defmodule Vortex.Router.Owner do
  @moduledoc """
  One process per owner. It holds that owner's `Vortex.Router.Policy`, turns
  the policy's wake-up requests into one-shot timers, and passes rings to the
  owner's connection. It outlives connections, so pacing, failures and the
  token survive a reconnect; the budget also survives a restart, through
  `Vortex.Router.Budget`.
  """

  # A crashed owner is started again by the next hello, not by the supervisor.
  use GenServer, restart: :temporary

  require Logger

  alias Vortex.Router.{Budget, Policy}

  @doc """
  Attaches the calling process as the owner's connection, starting the owner
  if this is its first hello. `sink` is called with each ring. The first
  token seen for a name is that owner's token for as long as the router runs.
  """
  @spec attach(String.t(), String.t(), non_neg_integer() | nil, (term() -> any())) ::
          {:ok, pid()} | {:error, :bad_token | :owner_attached}
  def attach(name, token, quiet_ms, sink) do
    pid =
      case DynamicSupervisor.start_child(Vortex.Router.OwnerSupervisor, {__MODULE__, {name, token}}) do
        {:ok, pid} -> pid
        {:error, {:already_started, pid}} -> pid
      end

    with :ok <- GenServer.call(pid, {:attach, token, quiet_ms, sink}), do: {:ok, pid}
  end

  @doc """
  Clears an owner's consecutive-failure stop, so the next ring can go out.
  For the operator over the release's remote console
  (`bin/vortex_router rpc 'Vortex.Router.Owner.clear_failures("codex")'`):
  one owner's stop never needs a router restart.
  """
  @spec clear_failures(String.t()) :: :ok | {:error, :unknown_owner}
  def clear_failures(name) do
    case Registry.lookup(Vortex.Router.Owners, name) do
      [{pid, _}] -> GenServer.call(pid, :clear_failures)
      [] -> {:error, :unknown_owner}
    end
  end

  @doc "Passes an event from the attached connection. Events from any other process are dropped."
  def event(owner, event), do: GenServer.cast(owner, {:event, self(), event})

  def start_link(policy_opts, {name, token}) do
    GenServer.start_link(__MODULE__, {policy_opts, name, token}, name: {:via, Registry, {Vortex.Router.Owners, name}})
  end

  @impl true
  def init({policy_opts, name, token}) do
    policy = Policy.new(Keyword.put(policy_opts, :starts, Budget.get(name)))
    {:ok, %{name: name, token: token, policy: policy, conn: nil, sink: nil, timer: nil}}
  end

  @impl true
  def handle_call({:attach, token, _quiet_ms, _sink}, _from, %{token: other} = state) when token != other do
    {:reply, {:error, :bad_token}, state}
  end

  def handle_call({:attach, _token, _quiet_ms, _sink}, _from, %{conn: {_, _}} = state) do
    {:reply, {:error, :owner_attached}, state}
  end

  def handle_call({:attach, _token, quiet_ms, sink}, {pid, _tag}, state) do
    policy = if quiet_ms, do: %{state.policy | owner_quiet_ms: quiet_ms}, else: state.policy
    {:reply, :ok, %{state | conn: {pid, Process.monitor(pid)}, sink: sink, policy: policy}}
  end

  def handle_call(:clear_failures, _from, state) do
    {:reply, :ok, run(%{state | policy: %{state.policy | failures: 0}}, :tick)}
  end

  @impl true
  def handle_cast({:event, pid, event}, %{conn: {pid, _}} = state), do: {:noreply, run(state, event)}
  def handle_cast({:event, _pid, _event}, state), do: {:noreply, state}

  @impl true
  def handle_info(:tick, state), do: {:noreply, run(%{state | timer: nil}, :tick)}

  def handle_info({:DOWN, ref, :process, _pid, _reason}, %{conn: {_, ref}} = state) do
    {:noreply, run(%{state | conn: nil, sink: nil}, :offline)}
  end

  def handle_info(_message, state), do: {:noreply, state}

  defp run(state, event) do
    now = System.os_time(:millisecond)
    {policy, actions} = Policy.step(state.policy, event, now)
    if state.timer, do: Process.cancel_timer(state.timer)
    saved = Policy.starts(policy) == Policy.starts(state.policy) or Budget.put(state.name, Policy.starts(policy))

    case {saved, actions} do
      # A ring whose charge is not on disk is not sent. It is taken back,
      # which refunds the charge, so memory and disk agree again, and the
      # owner tries once more after a pause.
      {{:error, reason}, [{:ring, id, _, _} | _]} ->
        Logger.error("router: budget not saved (#{inspect(reason)}); ring withheld")
        retry_ms = Application.get_env(:vortex_router, :save_retry_ms, 5_000)
        %{state | policy: Policy.withhold(policy, id), timer: Process.send_after(self(), :tick, retry_ms)}

      _ ->
        timer =
          Enum.reduce(actions, nil, fn
            {:ring, _, _, _} = ring, timer ->
              state.sink.(ring)
              timer

            {:wake_at, at}, _timer ->
              Process.send_after(self(), :tick, max(at - now, 0))
          end)

        %{state | policy: policy, timer: timer}
    end
  end
end

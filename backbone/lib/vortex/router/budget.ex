defmodule Vortex.Router.Budget do
  @moduledoc """
  Keeps every owner's charged ring starts on disk, so that restarting the
  router does not refill anyone's hourly budget. One process serializes the
  writes; each write replaces the file atomically.
  """

  use GenServer

  require Logger

  @hour 3_600_000

  def start_link(opts), do: GenServer.start_link(__MODULE__, Keyword.fetch!(opts, :path), name: __MODULE__)

  @doc "The starts recorded for an owner, as `Vortex.Router.Policy.starts/1` returned them."
  def get(owner), do: GenServer.call(__MODULE__, {:get, owner})

  @doc "Records an owner's starts. `{:error, reason}` means they are not on disk."
  def put(owner, starts), do: GenServer.call(__MODULE__, {:put, owner, starts})

  @impl true
  def init(path), do: {:ok, %{path: path, owners: load(path, System.os_time(:millisecond))}}

  @impl true
  def handle_call({:get, owner}, _from, state), do: {:reply, Map.get(state.owners, owner, %{}), state}

  def handle_call({:put, owner, starts}, _from, state) do
    owners = Map.put(state.owners, owner, starts)

    case write(state.path, owners) do
      :ok -> {:reply, :ok, %{state | owners: owners}}
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  defp load(path, now) do
    with {:ok, binary} <- File.read(path),
         {:ok, owners} <- decode(binary) do
      for {owner, starts} <- owners, into: %{} do
        {owner, for({room, times} <- starts, kept = Enum.filter(times, &(now - &1 < @hour)), kept != [], into: %{}, do: {room, kept})}
      end
    else
      {:error, :enoent} ->
        %{}

      # Wakes for every owner depend on the router starting, so a bad file
      # does not stop it. It is kept for inspection and reported: until it
      # is looked at, budgets spent before the restart are not enforced.
      _ ->
        Logger.error("router: budget file is not readable, moved to #{path}.corrupt; starting with an empty budget")
        File.rename(path, path <> ".corrupt")
        %{}
    end
  end

  defp decode(binary) do
    owners = :erlang.binary_to_term(binary, [:safe])
    if valid?(owners), do: {:ok, owners}, else: :error
  rescue
    ArgumentError -> :error
  end

  defp valid?(owners) do
    is_map(owners) and
      Enum.all?(owners, fn {owner, starts} ->
        is_binary(owner) and is_map(starts) and
          Enum.all?(starts, fn {room, times} -> is_binary(room) and is_list(times) and Enum.all?(times, &is_integer/1) end)
      end)
  end

  defp write(path, owners) do
    tmp = path <> ".tmp"

    with :ok <- File.write(tmp, :erlang.term_to_binary(owners)),
         :ok <- File.chmod(tmp, 0o600) do
      File.rename(tmp, path)
    end
  end
end

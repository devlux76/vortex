defmodule Bakeoff.T6.RateLimiter do
  @moduledoc """
  A token bucket. It starts full with `capacity` tokens and gains one token
  every `refill_ms` milliseconds, never holding more than `capacity`.
  """

  use GenServer

  def start_link(opts), do: GenServer.start_link(__MODULE__, opts)

  @doc "Takes `n` tokens, or none at all."
  def take(pid, n \\ 1), do: GenServer.call(pid, {:take, n})

  def tokens(pid), do: GenServer.call(pid, :tokens)

  @doc "Takes one token, waiting up to `timeout` milliseconds for it."
  def wait(pid, timeout) do
    GenServer.call(pid, :wait, timeout)
  catch
    :exit, {:timeout, _} -> {:error, :timeout}
  end

  @impl true
  def init(opts) do
    capacity = Keyword.fetch!(opts, :capacity)
    refill_ms = Keyword.fetch!(opts, :refill_ms)
    Process.send_after(self(), {:refill}, refill_ms)
    {:ok, %{capacity: capacity, refill_ms: refill_ms, tokens: capacity, waiters: []}}
  end

  @impl true
  def handle_call({:take, n}, _from, state) do
    if state.tokens > 0 do
      {:reply, :ok, %{state | tokens: state.tokens - n}}
    else
      {:reply, {:error, :empty}, state}
    end
  end

  def handle_call(:tokens, _from, state), do: {:reply, state.tokens, state}

  def handle_call(:wait, from, state) do
    if state.tokens > 0 do
      {:reply, :ok, %{state | tokens: state.tokens - 1}}
    else
      {:noreply, %{state | waiters: [from | state.waiters]}}
    end
  end

  @impl true
  def handle_info(:refill, state) do
    case state.waiters do
      [next | rest] ->
        GenServer.reply(next, :ok)
        {:noreply, %{state | waiters: rest}}

      [] ->
        Process.send_after(self(), :refill, state.refill_ms)
        {:noreply, %{state | tokens: state.tokens + 1}}
    end
  end
end

defmodule Bakeoff.T6Test do
  use ExUnit.Case, async: true

  alias Bakeoff.T6.RateLimiter

  @refill 50

  defp start(capacity), do: start_supervised!({RateLimiter, capacity: capacity, refill_ms: @refill})

  # Empties the bucket right after a refill, so the next one is a full interval away.
  defp drain(pid) do
    while_ok(pid)
    await_refill(pid, 200)
    while_ok(pid)
  end

  defp await_refill(_pid, 0), do: flunk("the bucket is not refilling")

  defp await_refill(pid, tries) do
    if RateLimiter.tokens(pid) == 0 do
      Process.sleep(2)
      await_refill(pid, tries - 1)
    end
  end

  defp while_ok(pid), do: if(RateLimiter.take(pid) == :ok, do: while_ok(pid), else: :ok)

  test "starts full and hands out tokens until empty" do
    pid = start(3)
    assert RateLimiter.tokens(pid) == 3
    assert RateLimiter.take(pid) == :ok
    assert RateLimiter.take(pid, 2) == :ok
    assert RateLimiter.tokens(pid) == 0
    assert RateLimiter.take(pid) == {:error, :empty}
  end

  test "never hands out more than it holds, and a refused take costs nothing" do
    pid = start(3)
    assert RateLimiter.take(pid, 4) == {:error, :empty}
    assert RateLimiter.tokens(pid) == 3
    assert RateLimiter.take(pid, 2) == :ok
    assert RateLimiter.take(pid, 2) == {:error, :empty}
    assert RateLimiter.tokens(pid) == 1
  end

  test "gains one token per interval" do
    pid = start(5)
    assert RateLimiter.take(pid, 5) == :ok
    Process.sleep(@refill * 3 + 25)
    assert RateLimiter.tokens(pid) in 3..4
  end

  test "never holds more than its capacity" do
    pid = start(2)
    Process.sleep(@refill * 4)
    assert RateLimiter.tokens(pid) == 2
    assert RateLimiter.take(pid) == :ok
    Process.sleep(@refill * 4)
    assert RateLimiter.tokens(pid) == 2
  end

  test "wait takes a token at once when one is there" do
    pid = start(1)
    assert RateLimiter.wait(pid, 10) == :ok
    assert RateLimiter.tokens(pid) == 0
  end

  test "wait blocks until the next refill" do
    pid = start(1)
    drain(pid)
    {micros, result} = :timer.tc(fn -> RateLimiter.wait(pid, 500) end)
    assert result == :ok
    assert micros > 20_000
    assert RateLimiter.tokens(pid) == 0
  end

  test "waiters are served in the order they arrived" do
    pid = start(1)
    drain(pid)
    test = self()

    for label <- [:first, :second, :third] do
      spawn_link(fn -> send(test, {label, RateLimiter.wait(pid, 1_000)}) end)
      Process.sleep(5)
    end

    assert_receive {:first, :ok}, 500
    assert_receive {:second, :ok}, 500
    assert_receive {:third, :ok}, 500
    {:messages, []} = Process.info(self(), :messages)
  end

  test "one waiter gets one token: the others keep waiting" do
    pid = start(1)
    drain(pid)
    test = self()
    for label <- [:a, :b], do: spawn_link(fn -> send(test, {label, RateLimiter.wait(pid, 1_000)}) end)
    assert_receive {_, :ok}, 500
    refute_receive {_, :ok}, 20
    assert_receive {_, :ok}, 500
  end

  test "refilling goes on after a waiter was served" do
    pid = start(2)
    drain(pid)
    assert RateLimiter.wait(pid, 500) == :ok
    Process.sleep(@refill * 3)
    assert RateLimiter.tokens(pid) == 2
  end

  test "a waiter that gives up gets a timeout" do
    pid = start(1)
    drain(pid)
    assert RateLimiter.wait(pid, 10) == {:error, :timeout}
  end

  test "a waiter that gave up does not consume a token" do
    pid = start(1)
    drain(pid)
    assert RateLimiter.wait(pid, 10) == {:error, :timeout}
    Process.sleep(@refill + 20)
    assert RateLimiter.tokens(pid) == 1
  end

  test "a waiter that gave up does not hold up the one behind it" do
    pid = start(1)
    drain(pid)
    test = self()
    spawn_link(fn -> send(test, {:impatient, RateLimiter.wait(pid, 10)}) end)
    Process.sleep(5)
    spawn_link(fn -> send(test, {:patient, RateLimiter.wait(pid, 1_000)}) end)
    assert_receive {:impatient, {:error, :timeout}}, 200
    assert_receive {:patient, :ok}, @refill + 30
  end

  test "the server survives all of this" do
    pid = start(1)
    drain(pid)
    assert RateLimiter.wait(pid, 5) == {:error, :timeout}
    assert RateLimiter.take(pid, 100) == {:error, :empty}
    Process.sleep(@refill + 20)
    assert Process.alive?(pid)
    assert RateLimiter.take(pid) == :ok
  end
end

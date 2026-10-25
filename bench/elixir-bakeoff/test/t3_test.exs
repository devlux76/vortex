defmodule Bakeoff.T3Test do
  use ExUnit.Case, async: true

  alias Bakeoff.T3.Debounce

  defp start(delay) do
    test = self()
    start_supervised!({Debounce, fun: fn value -> send(test, {:fired, value}) end, delay: delay})
  end

  test "calls the function once the delay has passed" do
    pid = start(60)
    assert Debounce.put(pid, :a) == :ok
    refute_receive {:fired, _}, 30
    assert_receive {:fired, :a}, 200
  end

  test "a burst fires once, with the last value" do
    pid = start(40)
    for value <- 1..20, do: Debounce.put(pid, value)
    assert_receive {:fired, 20}, 200
    refute_receive {:fired, _}, 100
  end

  test "every put restarts the delay" do
    pid = start(80)

    for value <- 1..5 do
      Debounce.put(pid, value)
      Process.sleep(40)
    end

    refute_received {:fired, _}
    assert_receive {:fired, 5}, 200
  end

  test "flush fires now, before it returns, and cancels the delay" do
    pid = start(60)
    Debounce.put(pid, :a)
    assert Debounce.flush(pid) == :ok
    assert_received {:fired, :a}
    refute_receive {:fired, _}, 150
  end

  test "flush with nothing pending calls nothing" do
    pid = start(20)
    assert Debounce.flush(pid) == :ok
    refute_receive {:fired, _}, 60
  end

  test "pending? says whether a value is waiting" do
    pid = start(40)
    refute Debounce.pending?(pid)
    Debounce.put(pid, :a)
    assert Debounce.pending?(pid)
    assert_receive {:fired, :a}, 200
    refute Debounce.pending?(pid)
  end

  test "a delay cancelled by flush cannot fire a later value early" do
    pid = start(100)
    Debounce.put(pid, :a)
    Process.sleep(60)
    Debounce.flush(pid)
    assert_received {:fired, :a}
    Debounce.put(pid, :b)
    # The first delay would have ended 40 ms from now.
    refute_receive {:fired, :b}, 70
    assert_receive {:fired, :b}, 200
  end

  test "works again after firing" do
    pid = start(20)
    Debounce.put(pid, 1)
    assert_receive {:fired, 1}, 200
    Debounce.put(pid, 2)
    assert_receive {:fired, 2}, 200
  end

  test "nil is a value like any other" do
    pid = start(20)
    Debounce.put(pid, nil)
    assert Debounce.pending?(pid)
    assert_receive {:fired, nil}, 200
  end

  test "a function that raises does not stop the server" do
    test = self()

    pid =
      start_supervised!(
        {Debounce, fun: fn value -> if value == :boom, do: raise("boom"), else: send(test, {:fired, value}) end, delay: 10},
        id: :raising
      )

    ExUnit.CaptureLog.capture_log(fn ->
      Debounce.put(pid, :boom)
      Process.sleep(50)
    end)

    assert Process.alive?(pid)
    Debounce.put(pid, :ok)
    assert_receive {:fired, :ok}, 200
  end
end

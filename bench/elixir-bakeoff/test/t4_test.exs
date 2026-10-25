defmodule Bakeoff.T4Test do
  # The tree uses fixed names, so these tests cannot run concurrently.
  use ExUnit.Case, async: false

  alias Bakeoff.T4

  setup do
    {:ok, top: start_supervised!(T4)}
  end

  # Waits until `fun` returns something truthy, for up to a second.
  defp eventually(fun, tries \\ 100) do
    case fun.() do
      result when result not in [nil, false] ->
        result

      _ when tries > 0 ->
        Process.sleep(10)
        eventually(fun, tries - 1)

      _ ->
        flunk("condition was not met within a second")
    end
  end

  defp kill(pid) do
    ref = Process.monitor(pid)
    Process.exit(pid, :kill)
    assert_receive {:DOWN, ^ref, _, _, _}, 1_000
  end

  test "counters are started by name and counted independently" do
    assert {:ok, pid} = T4.start_counter("a")
    assert is_pid(pid)
    assert {:ok, _} = T4.start_counter("b")
    assert T4.incr("a") == 1
    assert T4.incr("a") == 2
    assert T4.incr("b") == 1
    assert T4.value("a") == 2
    assert T4.counters() == ["a", "b"]
    assert T4.whereis("a") == pid
  end

  test "a name can be started only once" do
    assert {:ok, _} = T4.start_counter("a")
    assert T4.start_counter("a") == {:error, :already_started}
    assert T4.counters() == ["a"]
  end

  test "an unknown name is an error, not a crash" do
    assert T4.incr("nope") == {:error, :not_found}
    assert T4.value("nope") == {:error, :not_found}
    assert T4.stop_counter("nope") == {:error, :not_found}
    assert T4.whereis("nope") == nil
  end

  test "a crashed counter comes back under the same name, starting from zero" do
    {:ok, pid} = T4.start_counter("a")
    T4.incr("a")
    kill(pid)
    new = eventually(fn -> (found = T4.whereis("a")) && found != pid && found end)
    assert Process.alive?(new)
    assert eventually(fn -> T4.value("a") == 0 end)
    assert T4.incr("a") == 1
  end

  test "a stopped counter stays stopped" do
    {:ok, pid} = T4.start_counter("a")
    assert T4.stop_counter("a") == :ok
    refute Process.alive?(pid)
    Process.sleep(50)
    assert T4.whereis("a") == nil
    assert T4.counters() == []
    assert {:ok, _} = T4.start_counter("a")
    assert T4.value("a") == 0
  end

  test "one counter crashing over and over does not disturb the others" do
    {:ok, _} = T4.start_counter("steady")
    for _ <- 1..5, do: T4.incr("steady")
    {:ok, first} = T4.start_counter("flaky")
    steady = T4.whereis("steady")

    Enum.reduce(1..12, first, fn _, pid ->
      kill(pid)
      eventually(fn -> (found = T4.whereis("flaky")) && found != pid && found end)
    end)

    assert T4.whereis("steady") == steady
    assert T4.value("steady") == 5
    assert T4.counters() == ["flaky", "steady"]
  end

  test "if the registry dies, the counters are restarted clean and the tree survives", %{top: top} do
    {:ok, pid} = T4.start_counter("a")
    T4.incr("a")
    ref = Process.monitor(pid)
    kill(Process.whereis(Bakeoff.T4.Registry))
    assert_receive {:DOWN, ^ref, _, _, _}, 1_000
    assert Process.alive?(top)
    assert eventually(fn -> match?({:ok, _}, safe(fn -> T4.start_counter("b") end)) end)
    assert T4.whereis("a") == nil
    assert T4.counters() == ["b"]
  end

  # While the tree is restarting, a call may exit; that is not what this test is about.
  defp safe(fun) do
    fun.()
  catch
    :exit, _ -> nil
  end
end

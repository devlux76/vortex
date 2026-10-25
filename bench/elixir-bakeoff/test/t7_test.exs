defmodule Vortex.Router.PolicyTest do
  use ExUnit.Case, async: true

  alias Vortex.Router.Policy

  @hour 3_600_000

  # Most tests drive a context: the policy plus the id of the last ring. That
  # lets a test write `{:exited, 0}` for "the ring just emitted exited 0", has
  # snapshots report that ring as running, as a real service would, and drops
  # the id from ring actions. "ring identity" below uses Policy.step directly.

  # Pacing, quiet period and budget are off unless a test turns one on.
  defp new(opts \\ []) do
    defaults = [min_interval_ms: 0, owner_quiet_ms: 0, max_per_hour: 100, max_failures: 100, boot: "t"]
    ctx(Policy.new(Keyword.merge(defaults, opts)))
  end

  defp ctx(policy), do: %{policy: policy, ring: nil, live: nil}

  defp step(ctx, event, at) do
    {event, ctx} =
      case event do
        {:state, snapshot} -> {{:state, Map.put_new(snapshot, :running, ctx.live)}, ctx}
        {:exited, code} -> {{:exited, ctx.ring, code}, %{ctx | live: nil}}
        other -> {other, ctx}
      end

    {policy, actions} = Policy.step(ctx.policy, event, at)

    ctx =
      case actions do
        [{:ring, id, _, _}] -> %{ctx | policy: policy, ring: id, live: id}
        _ -> %{ctx | policy: policy}
      end

    {ctx,
     Enum.map(actions, fn
       {:ring, _id, room, unread} -> {:ring, room, unread}
       other -> other
     end)}
  end

  # A snapshot of unread mail: `{room, unread, oldest_cursor}` per room.
  defp mail(rooms, waiters \\ 0) do
    {:state, %{waiters: waiters, rooms: for({room, unread, oldest} <- rooms, do: %{room: room, unread: unread, oldest: oldest})}}
  end

  # Feeds `{event, at}` pairs in order and returns the final context and the actions of the last step.
  defp run(ctx, steps) do
    Enum.reduce(steps, {ctx, []}, fn {event, at}, {ctx, _} -> step(ctx, event, at) end)
  end

  describe "when to ring" do
    test "rings for unread mail when nobody is attending to it" do
      assert {_, [{:ring, "r", 1}]} = step(new(), mail([{"r", 1, 7}]), 0)
    end

    test "does nothing without unread mail" do
      assert {_, []} = step(new(), mail([]), 0)
      assert {_, []} = step(new(), :tick, 0)
    end

    test "does not ring while an agent is blocked in wait, and rings when it leaves" do
      {policy, actions} = step(new(), mail([{"r", 1, 7}], 1), 0)
      assert actions == []
      assert {_, [{:ring, "r", 1}]} = step(policy, mail([{"r", 1, 7}], 0), 5)
    end

    test "reports the unread total across rooms" do
      assert {_, [{:ring, "a", 5}]} = step(new(), mail([{"a", 2, 1}, {"b", 3, 2}]), 0)
    end

    test "tries rooms in order of their oldest unread event, whatever order they arrive in" do
      assert {_, [{:ring, "old", 2}]} = step(new(), mail([{"new", 1, 9}, {"old", 1, 3}]), 0)
    end
  end

  describe "one ring at a time" do
    test "events during a running ring start no second ring" do
      {policy, [{:ring, "r", 1}]} = step(new(), mail([{"r", 1, 7}]), 0)

      assert {_, []} =
               run(policy, [{mail([{"r", 2, 7}]), 1}, {mail([{"r", 3, 7}, {"s", 1, 9}]), 2}, {:tick, 3}, {:acted, 4}])
    end

    test "mail that piled up during a ring causes exactly one ring afterwards" do
      {policy, _} = run(new(), [{mail([{"r", 1, 7}]), 0}, {mail([{"r", 2, 7}]), 1}, {mail([{"r", 3, 7}]), 2}])
      assert {policy, [{:ring, "r", 3}]} = step(policy, {:exited, 0}, 3)
      assert {_, []} = step(policy, :tick, 4)
    end

    test "no ring follows an exit when the mail was acknowledged meanwhile" do
      {policy, _} = run(new(), [{mail([{"r", 1, 7}]), 0}, {mail([]), 1}])
      assert {_, []} = step(policy, {:exited, 0}, 2)
    end
  end

  describe "pacing" do
    test "keeps a minimum interval between ring starts and asks to be woken when it ends" do
      {policy, _} = run(new(min_interval_ms: 30_000), [{mail([{"r", 1, 7}]), 1_000}])
      assert {policy, [{:wake_at, 31_000}]} = step(policy, {:exited, 0}, 1_001)
      assert {policy, [{:wake_at, 31_000}]} = step(policy, :tick, 30_999)
      assert {_, [{:ring, "r", 1}]} = step(policy, :tick, 31_000)
    end

    test "owner activity holds off ringing, so a live session is not raced by a rung one" do
      {policy, []} = step(new(owner_quiet_ms: 30_000), :acted, 0)
      assert {policy, [{:wake_at, 30_000}]} = step(policy, mail([{"r", 1, 7}]), 10)
      assert {_, [{:ring, "r", 1}]} = step(policy, :tick, 30_000)
    end

    test "the later of the two holds wins" do
      policy = new(min_interval_ms: 30_000, owner_quiet_ms: 10_000)
      {policy, _} = run(policy, [{mail([{"r", 1, 7}]), 0}, {{:exited, 0}, 5}])
      assert {_, [{:wake_at, 30_000}]} = step(policy, :acted, 100)
      assert {_, [{:wake_at, 35_000}]} = step(policy, :acted, 25_000)
    end

    test "asks for no wake-up once the mail is gone" do
      {policy, _} = run(new(min_interval_ms: 30_000), [{mail([{"r", 1, 7}]), 0}, {{:exited, 0}, 5}])
      assert {_, []} = step(policy, mail([]), 6)
    end
  end

  describe "hourly budget per room" do
    test "bounds ring starts per room in a rolling hour" do
      policy = new(max_per_hour: 2)
      {policy, [{:ring, "r", 1}]} = step(policy, mail([{"r", 1, 7}]), 0)
      {policy, [{:ring, "r", 1}]} = step(policy, {:exited, 0}, 60_000)
      assert {policy, [{:wake_at, @hour}]} = step(policy, {:exited, 0}, 60_001)
      assert {policy, [{:wake_at, @hour}]} = step(policy, :tick, @hour - 1)
      assert {_, [{:ring, "r", 1}]} = step(policy, :tick, @hour)
    end

    test "a room that has spent its budget does not starve a later room" do
      policy = new(max_per_hour: 1)
      both = mail([{"a", 1, 1}, {"b", 1, 2}])
      {policy, [{:ring, "a", 2}]} = step(policy, both, 0)
      assert {policy, [{:ring, "b", 2}]} = step(policy, {:exited, 0}, 10)
      assert {_, [{:wake_at, @hour}]} = step(policy, {:exited, 0}, 20)
    end

    test "new mail in another room rings while the first room waits for its budget" do
      {policy, _} = run(new(max_per_hour: 1), [{mail([{"a", 1, 1}]), 0}, {{:exited, 0}, 10}])
      assert {_, [{:ring, "b", 2}]} = step(policy, mail([{"a", 1, 1}, {"b", 1, 2}]), 20)
    end

    test "owner activity does not refill the budget, since rung agents read and ack too" do
      {policy, _} = run(new(max_per_hour: 1), [{mail([{"r", 1, 7}]), 0}, {{:exited, 0}, 10}])
      assert {_, [{:wake_at, @hour}]} = step(policy, :acted, 20)
    end
  end

  describe "adapter exit codes" do
    test "consecutive failures stop ringing" do
      {policy, actions} =
        run(new(max_failures: 3), [
          {mail([{"r", 1, 7}]), 0},
          {{:exited, 1}, 1},
          {{:exited, 1}, 2},
          {{:exited, 0}, 3},
          {{:exited, 1}, 4},
          {{:exited, 1}, 5}
        ])

      assert [{:ring, "r", 1}] = actions
      assert {policy, []} = step(policy, {:exited, 1}, 6)
      assert {_, []} = step(policy, mail([{"r", 2, 7}]), 7)
    end

    test "owner activity clears the failure count" do
      {policy, []} = run(new(max_failures: 1), [{mail([{"r", 1, 7}]), 0}, {{:exited, 1}, 1}])
      assert {_, [{:ring, "r", 1}]} = step(policy, :acted, 2)
    end

    test "a deferral (75) restores the charged start and counts no failure" do
      {_, actions} = run(new(max_per_hour: 1, max_failures: 1), [{mail([{"r", 1, 7}]), 0}, {{:exited, 75}, 1}])
      assert [{:ring, "r", 1}] = actions
    end

    test "repeated deferrals neither suppress ringing nor exhaust the budget" do
      steps = [{mail([{"r", 1, 7}]), 0}] ++ for at <- 1..5, do: {{:exited, 75}, at}
      {_, actions} = run(new(max_per_hour: 2, max_failures: 1), steps)
      assert [{:ring, "r", 1}] = actions
    end

    test "a deferral keeps the minimum interval, which is when the retry happens" do
      {policy, _} = run(new(min_interval_ms: 30_000), [{mail([{"r", 1, 7}]), 0}])
      assert {policy, [{:wake_at, 30_000}]} = step(policy, {:exited, 75}, 10)
      assert {_, [{:ring, "r", 1}]} = step(policy, :tick, 30_000)
    end

    test "real failures still count after a deferral" do
      steps = [{mail([{"r", 1, 7}]), 0}, {{:exited, 75}, 1}, {{:exited, 1}, 2}]
      {policy, [{:ring, "r", 1}]} = run(new(max_failures: 2), steps)
      assert {_, []} = step(policy, {:exited, 1}, 3)
    end

    test "accepted but unacknowledged (76) keeps its charge and counts no failure" do
      {_, actions} = run(new(max_failures: 1), [{mail([{"r", 1, 7}]), 0}, {{:exited, 76}, 1}])
      assert [{:ring, "r", 1}] = actions

      {_, actions} = run(new(max_per_hour: 1), [{mail([{"r", 1, 7}]), 0}, {{:exited, 76}, 1}])
      assert [{:wake_at, @hour}] = actions
    end
  end

  describe "ring identity" do
    @unread %{waiters: 0, running: nil, rooms: [%{room: "r", unread: 1, oldest: 7}]}

    defp raw(opts \\ []) do
      Policy.new(Keyword.merge([min_interval_ms: 0, owner_quiet_ms: 0, max_per_hour: 100, boot: "t"], opts))
    end

    test "every ring has its own id, prefixed by the boot value" do
      {policy, [{:ring, "t-1", "r", 1}]} = Policy.step(raw(), {:state, @unread}, 0)
      assert {_, [{:ring, "t-2", "r", 1}]} = Policy.step(policy, {:exited, "t-1", 0}, 1)
      assert Policy.new().boot != Policy.new().boot
    end

    test "a snapshot that predates a pending ring does not clear it or cause a second ring" do
      {policy, [{:ring, "t-1", _, _}]} = Policy.step(raw(), {:state, @unread}, 0)
      assert {policy, []} = Policy.step(policy, {:state, %{@unread | rooms: [%{room: "r", unread: 2, oldest: 7}]}}, 1)
      assert {policy, []} = Policy.step(policy, {:started, "t-1"}, 2)
      assert {_, []} = Policy.step(policy, {:state, %{@unread | running: "t-1"}}, 3)
    end

    test "a refusal refunds the charge and counts no failure" do
      {policy, [{:ring, "t-1", _, _}]} = Policy.step(raw(max_per_hour: 1, max_failures: 1), {:state, @unread}, 0)
      assert {_, [{:ring, "t-2", "r", 1}]} = Policy.step(policy, {:refused, "t-1"}, 1)
    end

    test "a refusal keeps the minimum interval" do
      {policy, _} = Policy.step(raw(min_interval_ms: 30_000), {:state, @unread}, 0)
      assert {_, [{:wake_at, 30_000}]} = Policy.step(policy, {:refused, "t-1"}, 1)
    end

    test "once started, a snapshot without the ring clears it: no refund, no failure" do
      policy = raw(max_per_hour: 2, max_failures: 1)
      {policy, _} = Policy.step(policy, {:state, @unread}, 0)
      {policy, []} = Policy.step(policy, {:started, "t-1"}, 1)
      assert {policy, [{:ring, "t-2", "r", 1}]} = Policy.step(policy, {:state, @unread}, 2)
      {policy, []} = Policy.step(policy, {:started, "t-2"}, 3)
      assert {_, [{:wake_at, 3_600_000}]} = Policy.step(policy, {:state, @unread}, 4)
    end

    test "replies about any other ring are ignored" do
      policy = raw(max_failures: 1)
      assert {policy, []} = Policy.step(policy, {:exited, "old-9", 1}, 0)
      assert {policy, []} = Policy.step(policy, {:refused, "old-9"}, 1)
      {policy, [{:ring, "t-1", _, _}]} = Policy.step(policy, {:state, @unread}, 2)
      assert {policy, []} = Policy.step(policy, {:exited, "old-9", 0}, 3)
      assert {policy, []} = Policy.step(policy, {:started, "old-9"}, 4)
      # t-1 is still the current ring: its failure is counted and stops ringing.
      assert {_, []} = Policy.step(policy, {:exited, "t-1", 1}, 5)
    end

    test "a ring already running when the router starts is adopted, and nothing rings until it exits" do
      assert {policy, []} = Policy.step(raw(), {:state, %{@unread | running: "old-3"}}, 0)
      assert {policy, []} = Policy.step(policy, :tick, 1)
      assert {_, [{:ring, "t-1", "r", 1}]} = Policy.step(policy, {:exited, "old-3", 75}, 2)
    end

    test "an adopted ring that fails counts as a failure" do
      {policy, []} = Policy.step(raw(max_failures: 1), {:state, %{@unread | running: "old-3"}}, 0)
      assert {_, []} = Policy.step(policy, {:exited, "old-3", 1}, 1)
    end
  end

  describe "disconnect and restart" do
    test "a fresh policy rings from the first snapshot it is given" do
      assert {_, [{:ring, "r", 4}]} = step(new(), mail([{"r", 4, 7}]), 123_456)
    end

    test "going offline forgets the mail, so a pending wake-up rings nobody" do
      {policy, _} = run(new(min_interval_ms: 30_000), [{mail([{"r", 1, 7}]), 0}, {{:exited, 0}, 5}])
      assert {policy, []} = step(policy, :offline, 10)
      assert {_, []} = step(policy, :tick, 30_000)
    end

    test "going offline keeps the budget and drops a pending ring without refund" do
      {policy, [{:ring, "t-1", _, _}]} = Policy.step(raw(max_per_hour: 2), {:state, @unread}, 0)
      {policy, []} = Policy.step(policy, :offline, 1)
      assert {policy, [{:ring, "t-2", "r", 1}]} = Policy.step(policy, {:state, @unread}, 2)
      {policy, []} = Policy.step(policy, :offline, 3)
      assert {_, [{:wake_at, 3_600_000}]} = Policy.step(policy, {:state, @unread}, 4)
    end

    test "a started ring survives a reconnect when the service still reports it" do
      {policy, _} = Policy.step(raw(), {:state, @unread}, 0)
      {policy, []} = Policy.step(policy, {:started, "t-1"}, 1)
      {policy, []} = Policy.step(policy, :offline, 2)
      assert {policy, []} = Policy.step(policy, {:state, %{@unread | running: "t-1"}}, 3)
      assert {_, [{:ring, "t-2", "r", 1}]} = Policy.step(policy, {:exited, "t-1", 0}, 4)
    end

    test "the charged starts can be saved and restored" do
      {policy, _} = Policy.step(raw(), {:state, @unread}, 5)
      assert Policy.starts(policy) == %{"r" => [5]}
      restored = raw(max_per_hour: 1, starts: Policy.starts(policy))
      assert {_, [{:wake_at, 3_600_005}]} = Policy.step(restored, {:state, @unread}, 10)
    end
  end

  test "defaults are the documented ones" do
    policy = ctx(Policy.new())
    {policy, [{:ring, "r", 1}]} = step(policy, mail([{"r", 1, 7}]), 0)
    # 30 seconds between starts.
    {policy, [{:wake_at, 30_000}]} = step(policy, {:exited, 0}, 1)
    # 30 seconds of quiet after owner activity.
    {policy, [{:wake_at, 50_000}]} = step(policy, :acted, 20_000)
    # Four starts per room per hour.
    {policy, [{:ring, "r", 1}]} = step(policy, :tick, 50_000)
    {policy, [{:ring, "r", 1}]} = run(policy, [{{:exited, 0}, 50_001}, {:tick, 100_000}])
    {policy, [{:ring, "r", 1}]} = run(policy, [{{:exited, 0}, 100_001}, {:tick, 150_000}])
    assert {_, [{:wake_at, @hour}]} = run(policy, [{{:exited, 0}, 150_001}, {:tick, 200_000}])
    # Three consecutive failures.
    steps = [{mail([{"r", 1, 7}]), 0}, {{:exited, 1}, 1}, {:tick, 30_000}, {{:exited, 1}, 30_001}, {:tick, 60_000}]
    {policy, [{:ring, "r", 1}]} = run(ctx(Policy.new()), steps)
    assert {_, []} = run(policy, [{{:exited, 1}, 60_001}, {:tick, 90_000}])
  end
end

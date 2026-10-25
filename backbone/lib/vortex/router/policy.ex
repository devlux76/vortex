defmodule Vortex.Router.Policy do
  @moduledoc """
  Decides when an owner's wake adapter may be started. A pure state machine:
  no processes, no clock, no I/O. The caller supplies the time and carries
  out the actions.

  Events:

    * `{:state, %{waiters: n, running: id | nil, rooms: [%{room: key, unread: n, oldest: cursor}]}}`
      — a full snapshot from the owner's service of unread mail in rooms with
      mutual consent. It replaces what was known before.
    * `:acted` — the owner read, acknowledged, or was delivered a wait.
    * `{:started, id}` — the service started the adapter for ring `id`.
    * `{:refused, id}` — the service did not start it; the charge is refunded.
    * `{:exited, id, code}` — the adapter for ring `id` exited. 0 is success,
      75 a deferral before anything was sent (refunded), 76 accepted but not
      acknowledged in time (charge kept), anything else a broken adapter.
    * `:offline` — the service disconnected.
    * `:tick` — a requested wake-up time arrived.

  Actions:

    * `{:ring, id, room, unread}` — ask the service to start its adapter.
    * `{:wake_at, ms}` — send `:tick` at this time. It replaces any earlier
      request; a step that returns none wants no wake-up.

  A ring is pending from the moment it is emitted until `:started` or
  `:refused` arrives. A snapshot is ignored as evidence about a pending ring,
  since it may have been sent before the ring arrived. After that the
  snapshot's `running` is the truth. A ring still pending after `pending_ms`
  is given up: its charge is kept, and a late reply about it is ignored like
  any other stale reply.

  `now` is wall-clock milliseconds (`System.os_time(:millisecond)`), so that
  the charged starts mean the same thing after a restart.
  """

  @hour 3_600_000

  defstruct max_per_hour: 4,
            min_interval_ms: 30_000,
            owner_quiet_ms: 30_000,
            max_failures: 3,
            pending_ms: 10_000,
            boot: nil,
            seq: 0,
            rooms: [],
            waiters: 0,
            # nil, or {id, room | nil, {:pending, deadline} | :live}. The room is nil for a ring adopted from a snapshot.
            ring: nil,
            # room => start times within the last hour, newest first
            starts: %{},
            last_start: nil,
            last_owner: nil,
            failures: 0

  @type t :: %__MODULE__{}
  @type action :: {:ring, String.t(), String.t(), pos_integer()} | {:wake_at, integer()}

  @doc """
  Options: `:max_per_hour`, `:min_interval_ms`, `:owner_quiet_ms`,
  `:max_failures`, `:pending_ms`, `:starts` (from an earlier `starts/1`), and
  `:boot`, the prefix of ring ids, random unless given. Raises
  `ArgumentError` for a limit that is not a positive integer or a duration
  that is not a non-negative integer.
  """
  @spec new(keyword()) :: t()
  def new(opts \\ []) do
    policy = struct!(__MODULE__, opts)

    for {key, least} <- [max_per_hour: 1, max_failures: 1, min_interval_ms: 0, owner_quiet_ms: 0, pending_ms: 0] do
      value = Map.fetch!(policy, key)

      unless is_integer(value) and value >= least do
        raise ArgumentError, "#{key} must be an integer of at least #{least}, got: #{inspect(value)}"
      end
    end

    %{policy | boot: policy.boot || Base.encode16(:crypto.strong_rand_bytes(4), case: :lower)}
  end

  @doc "The charged ring starts per room, for the caller to persist."
  @spec starts(t()) :: %{String.t() => [integer()]}
  def starts(%__MODULE__{starts: starts}), do: starts

  @doc """
  Takes back a ring that was emitted and never sent: its charge is refunded
  and nothing is pending. Unlike `{:refused, id}` this decides nothing, so
  the caller chooses when to try again, with `:tick`.
  """
  @spec withhold(t(), String.t()) :: t()
  def withhold(%__MODULE__{ring: {id, room, {:pending, _}}} = policy, id), do: refund(%{policy | ring: nil}, room)
  def withhold(%__MODULE__{} = policy, _id), do: policy

  @spec step(t(), term(), integer()) :: {t(), [action()]}
  def step(%__MODULE__{} = policy, event, now) when is_integer(now) do
    policy |> expire(now) |> apply_event(event, now) |> decide(now)
  end

  # Before anything else, so that a reply arriving after the deadline finds no ring to act on.
  defp expire(%{ring: {_, _, {:pending, deadline}}} = p, now) when now >= deadline, do: %{p | ring: nil}
  defp expire(p, _now), do: p

  defp apply_event(p, {:state, %{waiters: waiters, running: running, rooms: rooms}}, _now) do
    %{p | waiters: waiters, rooms: Enum.sort_by(rooms, & &1.oldest), ring: reconcile(p.ring, running)}
  end

  defp apply_event(p, :acted, now), do: %{p | failures: 0, last_owner: now}
  defp apply_event(p, :tick, _now), do: p

  defp apply_event(%{ring: {_, _, {:pending, _}}} = p, :offline, _now), do: %{p | rooms: [], waiters: 0, ring: nil}
  defp apply_event(p, :offline, _now), do: %{p | rooms: [], waiters: 0}

  defp apply_event(%{ring: {id, room, {:pending, _}}} = p, {:started, id}, _now), do: %{p | ring: {id, room, :live}}
  defp apply_event(%{ring: {id, room, {:pending, _}}} = p, {:refused, id}, _now), do: refund(%{p | ring: nil}, room)

  defp apply_event(%{ring: {id, room, _}} = p, {:exited, id, code}, _now) do
    p = %{p | ring: nil}

    case code do
      0 -> %{p | failures: 0}
      75 -> refund(p, room)
      76 -> p
      _ -> %{p | failures: p.failures + 1}
    end
  end

  # A reply about a ring that is not the current one.
  defp apply_event(p, {reply, _id}, _now) when reply in [:started, :refused], do: p
  defp apply_event(p, {:exited, _id, _code}, _now), do: p

  defp reconcile({_, _, {:pending, _}} = ring, _running), do: ring
  defp reconcile({id, _, :live} = ring, id), do: ring
  defp reconcile(_ring, nil), do: nil
  defp reconcile(_ring, id), do: {id, nil, :live}

  defp refund(p, nil), do: p
  defp refund(p, room) do
    case Enum.drop(Map.get(p.starts, room, []), 1) do
      [] -> %{p | starts: Map.delete(p.starts, room)}
      rest -> %{p | starts: Map.put(p.starts, room, rest)}
    end
  end

  defp decide(%{ring: {_, _, {:pending, deadline}}} = p, _now), do: {p, [{:wake_at, deadline}]}

  defp decide(p, now) do
    unread = p.rooms |> Enum.map(& &1.unread) |> Enum.sum()
    allowed_at = allowed_at(p, now)

    cond do
      unread == 0 or p.waiters > 0 or p.ring != nil or p.failures >= p.max_failures ->
        {p, []}

      now < allowed_at ->
        {p, [{:wake_at, allowed_at}]}

      true ->
        p = %{p | starts: prune(p.starts, now)}

        case Enum.find(p.rooms, &(spent(p, &1.room) < p.max_per_hour)) do
          nil ->
            {p, [{:wake_at, p.rooms |> Enum.map(&(List.last(p.starts[&1.room]) + @hour)) |> Enum.min()}]}

          %{room: room} ->
            id = "#{p.boot}-#{p.seq + 1}"
            starts = Map.update(p.starts, room, [now], &[now | &1])
            deadline = now + p.pending_ms
            p = %{p | seq: p.seq + 1, ring: {id, room, {:pending, deadline}}, last_start: now, starts: starts}
            {p, [{:ring, id, room, unread}, {:wake_at, deadline}]}
        end
    end
  end

  defp allowed_at(p, now) do
    [p.last_start && p.last_start + p.min_interval_ms, p.last_owner && p.last_owner + p.owner_quiet_ms]
    |> Enum.reject(&is_nil/1)
    |> Enum.max(fn -> now end)
  end

  defp spent(p, room), do: length(Map.get(p.starts, room, []))

  defp prune(starts, now) do
    for {room, times} <- starts, kept = Enum.filter(times, &(now - &1 < @hour)), kept != [], into: %{}, do: {room, kept}
  end
end

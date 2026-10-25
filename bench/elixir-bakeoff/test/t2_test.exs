defmodule Bakeoff.T2Test do
  use ExUnit.Case, async: true

  alias Bakeoff.T2.Ring

  defp ring(items, capacity), do: Enum.reduce(items, Ring.new(capacity), &Ring.push(&2, &1))

  test "keeps the newest items up to its capacity, oldest first" do
    assert Enum.to_list(Ring.new(3)) == []
    assert Enum.to_list(ring([1, 2], 3)) == [1, 2]
    assert Enum.to_list(ring([1, 2, 3, 4], 3)) == [2, 3, 4]
    assert Enum.to_list(ring(1..100, 1)) == [100]
  end

  test "rejects a capacity that is not a positive integer" do
    for bad <- [0, -1, 1.5, nil], do: assert_raise(ArgumentError, fn -> Ring.new(bad) end)
  end

  test "is Enumerable" do
    r = ring([1, 2, 3, 4], 3)
    assert Enum.count(r) == 3
    assert Enum.member?(r, 3)
    refute Enum.member?(r, 1)
    assert Enum.map(r, &(&1 * 2)) == [4, 6, 8]
    assert Enum.take(r, 2) == [2, 3]
    assert Enum.slice(r, 1, 2) == [3, 4]
    assert Enum.zip(r, r) == [{2, 2}, {3, 3}, {4, 4}]
    assert r |> Stream.zip(Stream.cycle([:x])) |> Enum.to_list() == [{2, :x}, {3, :x}, {4, :x}]
    assert Enum.reduce_while(r, 0, fn x, acc -> if x > 2, do: {:halt, acc}, else: {:cont, acc + x} end) == 2
  end

  test "reports its size without walking the items" do
    assert Enumerable.count(ring([1, 2, 3, 4], 3)) == {:ok, 3}
    assert Enumerable.count(Ring.new(5)) == {:ok, 0}
  end

  test "is Collectable" do
    assert [1, 2, 3, 4, 5] |> Enum.into(Ring.new(2)) |> Enum.to_list() == [4, 5]
    assert Enum.to_list(for x <- 1..10, rem(x, 2) == 0, into: Ring.new(3), do: x * x) == [36, 64, 100]
    assert [9] |> Enum.into(ring([1, 2], 2)) |> Enum.to_list() == [2, 9]
  end

  test "inspects as its contents" do
    assert inspect(ring([1, 2, 3, 4], 3)) == "#Ring<[2, 3, 4]>"
    assert inspect(Ring.new(2)) == "#Ring<[]>"
    assert inspect(ring(["a"], 2)) == ~s(#Ring<["a"]>)
  end

  test "honours inspect limits" do
    assert inspect(ring(1..10, 10), limit: 3) == "#Ring<[1, 2, 3, ...]>"
  end

  test "push is cheap on a large ring" do
    {micros, r} = :timer.tc(fn -> ring(1..200_000, 100_000) end)
    assert Enum.count(r) == 100_000
    assert Enum.take(r, 1) == [100_001]
    assert micros < 2_000_000
  end
end

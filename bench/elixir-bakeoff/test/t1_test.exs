defmodule Bakeoff.T1Test do
  use ExUnit.Case, async: true

  alias Bakeoff.T1

  describe "rle/1 and unrle/1" do
    test "encodes runs of equal characters" do
      assert T1.rle("") == []
      assert T1.rle("aaabcc") == [{"a", 3}, {"b", 1}, {"c", 2}]
      assert T1.rle("aAa") == [{"a", 1}, {"A", 1}, {"a", 1}]
    end

    test "a character is what a reader sees, not a byte or a code point" do
      assert T1.rle("ééé👍👍") == [{"é", 3}, {"👍", 2}]
      decomposed = "é"
      assert T1.rle(decomposed <> decomposed <> "e") == [{decomposed, 2}, {"e", 1}]
      assert T1.rle("👨‍👩‍👧👨‍👩‍👧") == [{"👨‍👩‍👧", 2}]
    end

    test "decoding reverses encoding" do
      for text <- ["", "aaabcc", "ééé👍👍 ok", String.duplicate("x", 10_000) <> "y"] do
        assert text |> T1.rle() |> T1.unrle() == text
      end
    end
  end

  describe "frames/1" do
    test "splits a buffer into length-prefixed frames and returns what is left" do
      assert T1.frames(<<0, 2, "hi", 0, 0, 0, 3, "abc">>) == {["hi", "", "abc"], <<>>}
      assert T1.frames(<<0, 2, "hi", 0, 5, "ab">>) == {["hi"], <<0, 5, "ab">>}
      assert T1.frames(<<0>>) == {[], <<0>>}
      assert T1.frames(<<>>) == {[], <<>>}
    end

    test "the length is 16 bits, big-endian" do
      payload = :binary.copy("z", 300)
      assert T1.frames(<<1, 44, payload::binary, 9>>) == {[payload], <<9>>}
    end

    test "handles a large buffer" do
      buffer = :binary.copy(<<0, 1, "a">>, 200_000)
      assert {frames, <<>>} = T1.frames(buffer)
      assert length(frames) == 200_000
    end
  end

  describe "flatten/1" do
    test "joins nested string keys with dots" do
      assert T1.flatten(%{"a" => %{"b" => 1, "c" => %{"d" => 2}}, "e" => 3}) == %{"a.b" => 1, "a.c.d" => 2, "e" => 3}
      assert T1.flatten(%{}) == %{}
    end

    test "an empty map and a struct are values, not levels" do
      assert T1.flatten(%{"a" => %{}, "b" => %{"c" => %{}}}) == %{"a" => %{}, "b.c" => %{}}
      assert T1.flatten(%{"when" => ~D[2026-10-09], "r" => %{"x" => 1..3}}) == %{"when" => ~D[2026-10-09], "r.x" => 1..3}
    end

    test "lists are left alone" do
      assert T1.flatten(%{"a" => [%{"b" => 1}]}) == %{"a" => [%{"b" => 1}]}
    end
  end
end

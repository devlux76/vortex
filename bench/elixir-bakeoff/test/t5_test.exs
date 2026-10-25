defmodule Bakeoff.T5Test do
  use ExUnit.Case, async: true

  defmodule Mail do
    use Bakeoff.T5

    defevent :mail_stored, [:owner, :room]
    defevent :ring_was_started, [:ring]
    defevent :acted
  end

  defmodule Other do
    use Bakeoff.T5

    # Field names that would collide with careless macro internals.
    defevent :odd, [:name, :fields, :wire, :map, :args]
  end

  test "each event gets a constructor that takes its fields in order" do
    assert Mail.mail_stored("claude", "r1") == %{event: "mail.stored", owner: "claude", room: "r1"}
    assert Mail.ring_was_started("t-1") == %{event: "ring.was.started", ring: "t-1"}
    assert Mail.acted() == %{event: "acted"}
    assert Other.odd(1, 2, 3, 4, 5) == %{event: "odd", name: 1, fields: 2, wire: 3, map: 4, args: 5}
  end

  test "only the declared constructors exist" do
    assert function_exported?(Mail, :mail_stored, 2)
    refute function_exported?(Mail, :mail_stored, 1)
    refute function_exported?(Mail, :mail_stored, 3)
    refute function_exported?(Other, :acted, 0)
  end

  test "__events__/0 lists names and arities, sorted by name" do
    assert Mail.__events__() == [acted: 0, mail_stored: 2, ring_was_started: 1]
    assert Other.__events__() == [odd: 5]
  end

  test "decode/1 turns a string-keyed map into the event, dropping unknown keys" do
    assert Mail.decode(%{"event" => "mail.stored", "owner" => "claude", "room" => "r1", "junk" => true}) ==
             {:ok, %{event: "mail.stored", owner: "claude", room: "r1"}}

    assert Mail.decode(%{"event" => "acted"}) == {:ok, %{event: "acted"}}
    assert Mail.decode(%{"event" => "mail.stored", "owner" => nil, "room" => 3}) == {:ok, %{event: "mail.stored", owner: nil, room: 3}}
  end

  test "decode/1 rejects unknown events, missing fields and non-maps" do
    assert Mail.decode(%{"event" => "mail.stored", "owner" => "claude"}) == :error
    assert Mail.decode(%{"event" => "odd"}) == :error
    assert Mail.decode(%{"event" => "mail_stored", "owner" => "a", "room" => "b"}) == :error
    assert Mail.decode(%{event: "acted"}) == :error
    assert Mail.decode(%{}) == :error
    assert Mail.decode("acted") == :error
    assert Mail.decode(nil) == :error
  end

  test "decode/1 never creates atoms from input" do
    key = "bakeoff_never_an_atom_#{System.unique_integer([:positive])}"
    assert Mail.decode(%{"event" => "acted", key => 1}) == {:ok, %{event: "acted"}}
    assert Mail.decode(%{"event" => key}) == :error
    assert_raise ArgumentError, fn -> String.to_existing_atom(key) end
  end

  describe "misuse is a compile error" do
    defp compile(body) do
      name = "Elixir.Bakeoff.T5Test.Bad#{System.unique_integer([:positive])}"
      Code.compile_string("defmodule :'#{name}' do\n  use Bakeoff.T5\n#{body}\nend")
    end

    test "the same event declared twice" do
      assert_raise CompileError, ~r/mail_stored/, fn ->
        compile("defevent :mail_stored, [:a]\ndefevent :mail_stored, [:b, :c]")
      end
    end

    test "a field called event" do
      assert_raise CompileError, ~r/event/, fn -> compile("defevent :x, [:event]") end
    end

    test "a field repeated" do
      assert_raise CompileError, fn -> compile("defevent :x, [:a, :b, :a]") end
    end

    test "names and fields that are not atoms" do
      assert_raise CompileError, fn -> compile(~s(defevent "x", [:a])) end
      assert_raise CompileError, fn -> compile(~s(defevent :x, ["a"])) end
      assert_raise CompileError, fn -> compile("defevent :x, :a") end
    end

    test "a correct module still compiles this way" do
      assert [{module, _}] = compile("defevent :fine, [:a]")
      assert module.fine(1) == %{event: "fine", a: 1}
    end
  end
end

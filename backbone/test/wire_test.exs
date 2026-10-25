# Docs: ISSUES.md I8 — Agreed implementation boundary (body-free socket message schema).
defmodule Vortex.Router.WireTest do
  use ExUnit.Case, async: true

  alias Vortex.Router.Wire

  @token String.duplicate("k", 32)

  test "embedding requests are bounded and replies preserve request ids" do
    assert Wire.decode(JSON.encode!(%{t: "embed", id: "e-1", text: "task: clustering | query: same topic"})) ==
             {:ok, {:embed, "e-1", "task: clustering | query: same topic"}}
    for message <- [%{t: "embed", id: "", text: "x"}, %{t: "embed", id: "e", text: 3},
                    %{t: "embed", id: "e", text: String.duplicate("x", 65_537)}] do
      assert Wire.decode(JSON.encode!(message)) == :error
    end
    assert JSON.decode!(Wire.encode({:embedded, "e-1", [0.1, 0.2]})) == %{"t" => "embedded", "id" => "e-1", "vector" => [0.1, 0.2]}
    assert JSON.decode!(Wire.encode({:embed_error, "e-1", :busy})) == %{"t" => "embed_error", "id" => "e-1", "reason" => "busy"}
  end

  test "decodes hello" do
    assert Wire.decode(~s({"t":"hello","v":1,"owner":"claude","token":"#{@token}"})) == {:ok, {:hello, "claude", @token, nil}}

    assert Wire.decode(~s({"t":"hello","v":1,"owner":"claude","token":"#{@token}","quiet_ms":0})) ==
             {:ok, {:hello, "claude", @token, 0}}
  end

  test "decodes a state snapshot" do
    line = ~s({"t":"state","waiters":1,"running":"ab-3","rooms":[{"room":"ab12","unread":2,"oldest":42}]})

    assert Wire.decode(line) ==
             {:ok, {:state, %{waiters: 1, running: "ab-3", rooms: [%{room: "ab12", unread: 2, oldest: 42}]}}}

    empty = {:ok, {:state, %{waiters: 0, running: nil, rooms: []}}}
    assert Wire.decode(~s({"t":"state","waiters":0,"running":null,"rooms":[]})) == empty
    assert Wire.decode(~s({"t":"state","waiters":0,"rooms":[]})) == empty
  end

  test "decodes owner activity and adapter replies" do
    assert Wire.decode(~s({"t":"acted"})) == {:ok, :acted}
    assert Wire.decode(~s({"t":"started","ring":"ab-3"})) == {:ok, {:started, "ab-3"}}
    assert Wire.decode(~s({"t":"refused","ring":"ab-3"})) == {:ok, {:refused, "ab-3"}}
    assert Wire.decode(~s({"t":"exited","ring":"ab-3","code":75})) == {:ok, {:exited, "ab-3", 75}}
  end

  test "ignores unknown fields, surrounding whitespace and a trailing newline" do
    assert Wire.decode(~s(  {"t":"acted","acked":41,"extra":{"a":1}}\n)) == {:ok, :acted}
  end

  test "rejects anything that is not a well-formed message" do
    room = fn fields -> ~s({"t":"state","waiters":0,"rooms":[{#{fields}}]}) end

    for line <- [
          "",
          "not json",
          "[]",
          "7",
          ~s({"t":"ring","ring":"a-1","room":"a","unread":1}),
          ~s({"t":"hello","v":2,"owner":"claude","token":"#{@token}"}),
          ~s({"t":"hello","v":1,"owner":"Claude","token":"#{@token}"}),
          ~s({"t":"hello","v":1,"owner":"","token":"#{@token}"}),
          ~s({"t":"hello","v":1,"owner":"a/b","token":"#{@token}"}),
          ~s({"t":"hello","v":1,"owner":"claude","token":"short"}),
          ~s({"t":"hello","v":1,"owner":"claude","token":"#{String.duplicate("k", 129)}"}),
          ~s({"t":"hello","v":1,"owner":"claude"}),
          ~s({"t":"hello","v":1,"owner":"claude","token":"#{@token}","quiet_ms":-1}),
          ~s({"t":"hello","v":1,"owner":"claude","token":"#{@token}","quiet_ms":"0"}),
          ~s({"t":"state","waiters":9007199254740992,"rooms":[]}),
          ~s({"t":"state","waiters":-1,"rooms":[]}),
          ~s({"t":"state","waiters":0}),
          ~s({"t":"state","waiters":0,"running":7,"rooms":[]}),
          ~s({"t":"state","waiters":0,"running":"","rooms":[]}),
          ~s({"t":"state","waiters":0,"rooms":{}}),
          ~s({"t":"state","waiters":0,"rooms":["r"]}),
          room.(~s("room":"a","unread":0,"oldest":1)),
          room.(~s("room":7,"unread":1,"oldest":1)),
          room.(~s("room":"a","unread":1.5,"oldest":1)),
          room.(~s("room":"a","unread":1,"oldest":-1)),
          room.(~s("room":"","unread":1,"oldest":1)),
          room.(~s("room":"#{String.duplicate("a", 129)}","unread":1,"oldest":1)),
          room.(~s("room":"a","unread":1)),
          ~s({"t":"started"}),
          ~s({"t":"refused","ring":3}),
          ~s({"t":"exited","ring":"a-1"}),
          ~s({"t":"exited","ring":"a-1","code":"0"}),
          ~s({"t":"exited","ring":"a-1","code":256}),
          ~s({"t":"exited","code":0})
        ] do
      assert Wire.decode(line) == :error, "accepted: #{line}"
    end
  end

  test "encodes each outgoing message as one line of JSON" do
    ring = Wire.encode({:ring, "ab-3", "ab12", 3})
    refute ring =~ "\n"
    assert JSON.decode!(ring) == %{"t" => "ring", "ring" => "ab-3", "room" => "ab12", "unread" => 3}
    assert JSON.decode!(Wire.encode(:welcome)) == %{"t" => "welcome"}
    assert JSON.decode!(Wire.encode({:error, :owner_attached})) == %{"t" => "error", "reason" => "owner_attached"}
  end
end

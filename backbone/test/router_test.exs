# Docs: VORTEX_v5.1.md §9.3; ISSUES.md I8 — Agreed implementation boundary and acceptance.
defmodule Vortex.RouterTest do
  # One router at a time: its processes have fixed names.
  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  @token String.duplicate("a", 32)
  @other String.duplicate("b", 32)
  @room String.duplicate("c", 64)

  setup do
    dir = Path.join(System.tmp_dir!(), "vortex-router-#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm_rf!(dir) end)
    {:ok, socket: Path.join(dir, "router.sock")}
  end

  # Pacing and quiet period are off unless a test turns them on.
  defp start(socket, policy \\ [], opts \\ []) do
    policy = Keyword.merge([min_interval_ms: 0, owner_quiet_ms: 0], policy)
    start_supervised!({Vortex.Router.Supervisor, [socket: socket, policy: policy] ++ opts})
  end

  defp connect(socket) do
    {:ok, client} = :gen_tcp.connect({:local, socket}, 0, [:binary, packet: :line, active: false])
    client
  end

  defp say(client, message), do: :ok = :gen_tcp.send(client, [JSON.encode!(message), ?\n])

  defp hear(client, timeout \\ 1_000) do
    case :gen_tcp.recv(client, 0, timeout) do
      {:ok, line} -> JSON.decode!(line)
      {:error, reason} -> reason
    end
  end

  defp hello(socket, owner \\ "claude", token \\ @token, extra \\ %{}) do
    client = connect(socket)
    say(client, Map.merge(%{t: "hello", v: 1, owner: owner, token: token}, extra))
    {client, hear(client)}
  end

  defp mail(client, unread \\ 1, running \\ nil) do
    say(client, %{t: "state", waiters: 0, running: running, rooms: [%{room: @room, unread: unread, oldest: 7}]})
  end

  test "embedding before hello is refused", %{socket: socket} do
    start(socket)
    client = connect(socket)
    say(client, %{t: "embed", id: "e", text: "private text"})
    assert hear(client) == %{"t" => "error", "reason" => "bad_hello"}
  end

  test "authenticated embeddings fail over without blocking ring delivery", %{socket: socket} do
    {:ok, http} = :gen_tcp.listen(0, [:binary, active: false, packet: :http_bin, reuseaddr: true])
    {:ok, port} = :inet.port(http)
    caller = self()
    server = Task.async(fn ->
      {:ok, conn} = :gen_tcp.accept(http)
      {:ok, {:http_request, :POST, {:abs_path, "/v1/embeddings"}, _}} = :gen_tcp.recv(conn, 0, 2_000)
      headers = Stream.repeatedly(fn -> :gen_tcp.recv(conn, 0, 2_000) end)
        |> Enum.take_while(&(&1 != {:ok, :http_eoh}))
      length = Enum.find_value(headers, fn
        {:ok, {:http_header, _, :"Content-Length", _, value}} -> String.to_integer(value)
        _ -> nil
      end)
      :inet.setopts(conn, packet: :raw)
      {:ok, body} = :gen_tcp.recv(conn, length, 2_000)
      send(caller, {:embedded_input, JSON.decode!(body)["input"]})
      receive do: (:reply -> :ok)
      body = JSON.encode!(%{data: [%{embedding: List.duplicate(0.25, 768)}]})
      :gen_tcp.send(conn, ["HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ", Integer.to_string(byte_size(body)), "\r\nConnection: close\r\n\r\n", body])
      :gen_tcp.close(conn)
    end)
    start(socket, [], embed_urls: ["http://127.0.0.1:1/v1/embeddings", "http://127.0.0.1:#{port}/v1/embeddings"])
    {client, %{"t" => "welcome"}} = hello(socket)
    text = "task: clustering | query: private topic"
    say(client, %{t: "embed", id: "e-1", text: text})
    assert_receive {:embedded_input, ^text}, 3_000
    mail(client)
    assert %{"t" => "ring"} = hear(client)
    send(server.pid, :reply)
    assert %{"t" => "embedded", "id" => "e-1", "vector" => vector} = hear(client)
    assert vector == List.duplicate(0.25, 768)
    Task.await(server)
    :gen_tcp.close(http)
  end

  test "only two embeddings run at once and overflow does not delay owner events", %{socket: socket} do
    {:ok, http} = :gen_tcp.listen(0, [:binary, active: false, reuseaddr: true])
    {:ok, port} = :inet.port(http)
    caller = self()
    server = Task.async(fn ->
      sockets = for _ <- 1..2 do
        {:ok, conn} = :gen_tcp.accept(http)
        send(caller, :http_started)
        conn
      end
      receive do: (:close -> :ok)
      Enum.each(sockets, &:gen_tcp.close/1)
      :gen_tcp.close(http)
    end)
    start(socket, [], embed_urls: ["http://127.0.0.1:#{port}/v1/embeddings"])
    {client, %{"t" => "welcome"}} = hello(socket)
    for id <- ["first", "second"] do
      say(client, %{t: "embed", id: id, text: "private topic"})
      assert_receive :http_started, 2_000
    end
    say(client, %{t: "embed", id: "overflow", text: "another topic"})
    assert hear(client) == %{"t" => "embed_error", "id" => "overflow", "reason" => "busy"}
    mail(client)
    assert %{"t" => "ring"} = hear(client)
    send(server.pid, :close)
    Task.await(server)
    replies = for _ <- 1..2, do: hear(client, 2_000)
    assert Enum.sort(Enum.map(replies, & &1["id"])) == ["first", "second"]
    assert Enum.all?(replies, &(&1["reason"] == "unavailable"))
  end

  test "hello, mail, ring, start and exit over a real socket", %{socket: socket} do
    start(socket)
    {client, reply} = hello(socket)
    assert reply == %{"t" => "welcome"}

    mail(client, 2)
    assert %{"t" => "ring", "ring" => ring, "room" => @room, "unread" => 2} = hear(client)

    say(client, %{t: "started", ring: ring})
    mail(client, 3, ring)
    assert hear(client, 100) == :timeout

    say(client, %{t: "exited", ring: ring, code: 0})
    assert %{"t" => "ring", "ring" => second, "unread" => 3} = hear(client)
    assert second != ring
  end

  test "the socket is private to its user", %{socket: socket} do
    start(socket)
    assert Bitwise.band(File.stat!(socket).mode, 0o777) == 0o600
    assert Bitwise.band(File.stat!(Path.dirname(socket)).mode, 0o777) == 0o700
  end

  test "a first line that is not hello is refused", %{socket: socket} do
    start(socket)
    client = connect(socket)
    say(client, %{t: "acted"})
    assert hear(client) == %{"t" => "error", "reason" => "bad_hello"}
    assert hear(client) == :closed
  end

  test "a connection that says nothing is dropped", %{socket: socket} do
    start(socket, [], hello_ms: 100)
    client = connect(socket)
    assert hear(client) == %{"t" => "error", "reason" => "bad_hello"}
    assert hear(client) == :closed
  end

  test "a second connection for an attached owner is refused and the first is untouched", %{socket: socket} do
    start(socket)
    {first, %{"t" => "welcome"}} = hello(socket)
    {second, reply} = hello(socket)
    assert reply == %{"t" => "error", "reason" => "owner_attached"}
    assert hear(second) == :closed

    mail(first)
    assert %{"t" => "ring"} = hear(first)
  end

  test "an owner is released as soon as its connection closes", %{socket: socket} do
    start(socket)
    {first, %{"t" => "welcome"}} = hello(socket)
    :gen_tcp.close(first)

    # The close and the new hello race; a refused client retries.
    reply =
      Enum.find_value(1..50, fn _ ->
        {_client, reply} = hello(socket)
        if reply == %{"t" => "welcome"}, do: reply, else: Process.sleep(10)
      end)

    assert reply == %{"t" => "welcome"}
  end

  test "the first token seen for an owner is the only one accepted", %{socket: socket} do
    start(socket)
    {first, %{"t" => "welcome"}} = hello(socket)
    :gen_tcp.close(first)
    Process.sleep(50)
    assert {_, %{"t" => "error", "reason" => "bad_token"}} = hello(socket, "claude", @other)
    assert {_, %{"t" => "welcome"}} = hello(socket, "claude", @token)
    assert {_, %{"t" => "welcome"}} = hello(socket, "codex", @other)
  end

  test "owners are rung independently", %{socket: socket} do
    start(socket, max_per_hour: 1)
    {claude, _} = hello(socket, "claude")
    {codex, _} = hello(socket, "codex", @other)
    mail(claude)
    assert %{"t" => "ring", "ring" => ring} = hear(claude)
    say(claude, %{t: "exited", ring: ring, code: 0})
    mail(codex)
    assert %{"t" => "ring"} = hear(codex)
    assert hear(claude, 100) == :timeout
  end

  test "a malformed line is dropped and the connection stays", %{socket: socket} do
    start(socket)
    {client, _} = hello(socket)

    log =
      capture_log(fn ->
        :gen_tcp.send(client, "this is not json\n")
        say(client, %{t: "state", waiters: -1, rooms: []})
        mail(client)
        assert %{"t" => "ring"} = hear(client)
      end)

    assert log =~ "malformed line dropped"
  end

  test "clearing an owner's failure stop lets its next ring out without a restart", %{socket: socket} do
    start(socket, max_failures: 1)
    {client, _} = hello(socket)
    mail(client)
    assert %{"t" => "ring", "ring" => ring} = hear(client)
    say(client, %{t: "started", ring: ring})
    say(client, %{t: "exited", ring: ring, code: 1})
    mail(client, 2)
    assert hear(client, 100) == :timeout

    assert Vortex.Router.Owner.clear_failures("claude") == :ok
    assert %{"t" => "ring", "ring" => second, "unread" => 2} = hear(client)
    assert second != ring
    assert Vortex.Router.Owner.clear_failures("nobody") == {:error, :unknown_owner}
  end

  test "a refusal is refunded and the next ring comes when pacing allows", %{socket: socket} do
    start(socket, max_per_hour: 1, min_interval_ms: 80)
    {client, _} = hello(socket)
    mail(client)
    assert %{"t" => "ring", "ring" => ring} = hear(client)
    say(client, %{t: "refused", ring: ring})
    assert hear(client, 40) == :timeout
    assert %{"t" => "ring", "ring" => second} = hear(client, 3_000)
    assert second != ring
  end

  test "the router rings again by itself when the minimum interval ends", %{socket: socket} do
    start(socket, min_interval_ms: 100)
    {client, _} = hello(socket)
    mail(client)
    assert %{"t" => "ring", "ring" => ring} = hear(client)
    say(client, %{t: "exited", ring: ring, code: 0})
    assert hear(client, 50) == :timeout
    assert %{"t" => "ring"} = hear(client, 3_000)
  end

  test "a ring the service never confirms is given up and tried again", %{socket: socket} do
    start(socket, pending_ms: 80)
    {client, _} = hello(socket)
    mail(client)
    assert %{"t" => "ring", "ring" => ring} = hear(client)
    assert %{"t" => "ring", "ring" => second} = hear(client, 3_000)
    assert second != ring
  end

  test "quiet_ms in hello sets the owner's quiet period", %{socket: socket} do
    start(socket, owner_quiet_ms: 60_000)
    {client, _} = hello(socket, "claude", @token, %{quiet_ms: 100})
    say(client, %{t: "acted"})
    mail(client)
    assert hear(client, 50) == :timeout
    assert %{"t" => "ring"} = hear(client, 3_000)
  end

  test "the budget survives a reconnect", %{socket: socket} do
    start(socket, max_per_hour: 1)
    {client, _} = hello(socket)
    mail(client)
    assert %{"t" => "ring", "ring" => ring} = hear(client)
    say(client, %{t: "exited", ring: ring, code: 0})
    :gen_tcp.close(client)
    Process.sleep(50)

    {again, %{"t" => "welcome"}} = hello(socket)
    mail(again)
    assert hear(again, 150) == :timeout
  end

  test "the budget survives a restart of the router, written atomically", %{socket: socket} do
    start(socket, max_per_hour: 1)
    {client, _} = hello(socket)
    mail(client)
    assert %{"t" => "ring"} = hear(client)

    budget = Path.join(Path.dirname(socket), "router-budget.term")
    assert File.exists?(budget)
    refute File.exists?(budget <> ".tmp")
    assert Bitwise.band(File.stat!(budget).mode, 0o777) == 0o600

    stop_supervised!(Vortex.Router.Supervisor)
    refute File.exists?(socket)
    start(socket, max_per_hour: 1)

    {again, %{"t" => "welcome"}} = hello(socket)
    mail(again)
    assert hear(again, 150) == :timeout
  end

  test "a corrupt budget file is reported and set aside, and the router still starts", %{socket: socket} do
    budget = Path.join(Path.dirname(socket), "router-budget.term")
    File.mkdir_p!(Path.dirname(socket))
    File.write!(budget, "garbage")

    log = capture_log(fn -> start(socket, max_per_hour: 1) end)
    assert log =~ "budget file is not readable"
    assert File.read!(budget <> ".corrupt") == "garbage"

    {client, _} = hello(socket)
    mail(client)
    assert %{"t" => "ring"} = hear(client)
  end

  test "a connection process that is killed does not take its owner with it", %{socket: socket} do
    start(socket, max_per_hour: 1)
    {client, _} = hello(socket)
    mail(client)
    assert %{"t" => "ring", "ring" => ring} = hear(client)
    say(client, %{t: "exited", ring: ring, code: 0})
    Process.sleep(20)

    [{owner, _}] = Registry.lookup(Vortex.Router.Owners, "claude")
    [connection] = Task.Supervisor.children(Vortex.Router.Connections)
    Process.exit(connection, :kill)
    assert hear(client) == :closed

    Process.sleep(50)
    assert Process.alive?(owner)
    assert [{^owner, _}] = Registry.lookup(Vortex.Router.Owners, "claude")

    # Same owner, so the token still binds and the spent budget is still spent.
    assert {_, %{"t" => "error", "reason" => "bad_token"}} = hello(socket, "claude", @other)
    {again, %{"t" => "welcome"}} = hello(socket)
    mail(again)
    assert hear(again, 150) == :timeout
  end

  test "a connection is closed when its owner process dies", %{socket: socket} do
    start(socket)
    {client, _} = hello(socket)
    [{owner, _}] = Registry.lookup(Vortex.Router.Owners, "claude")
    Process.exit(owner, :kill)
    assert hear(client) == :closed
    assert {_, %{"t" => "welcome"}} = hello(socket)
  end

  test "no ring goes out unless its charge was saved", %{socket: socket} do
    budget_dir = Path.join(Path.dirname(socket), "budget")
    File.mkdir_p!(budget_dir)
    Application.put_env(:vortex_router, :save_retry_ms, 100)
    on_exit(fn -> Application.delete_env(:vortex_router, :save_retry_ms) end)
    # One start per hour: a withheld ring must not use it up.
    start(socket, [max_per_hour: 1], budget: Path.join(budget_dir, "router-budget.term"))
    {client, _} = hello(socket)
    [{owner, _}] = Registry.lookup(Vortex.Router.Owners, "claude")

    File.chmod!(budget_dir, 0o500)

    log =
      capture_log(fn ->
        mail(client)
        # Wait until the owner has tried, however loaded the machine is.
        Enum.find(1..200, fn _ -> :sys.get_state(owner).timer != nil or Process.sleep(5) == :never end)
        assert hear(client, 50) == :timeout
      end)

    assert log =~ "budget not saved"
    assert Vortex.Router.Policy.starts(:sys.get_state(owner).policy) == %{}

    # Once it can be saved again, the ring goes out, and it is the hour's one start.
    File.chmod!(budget_dir, 0o700)
    assert %{"t" => "ring", "ring" => ring} = hear(client, 3_000)
    say(client, %{t: "exited", ring: ring, code: 0})
    assert hear(client, 150) == :timeout
  end

  test "an adapter still running across a router restart is adopted, not duplicated", %{socket: socket} do
    start(socket)
    {client, _} = hello(socket)
    mail(client)
    assert %{"t" => "ring", "ring" => ring} = hear(client)
    say(client, %{t: "started", ring: ring})
    stop_supervised!(Vortex.Router.Supervisor)
    start(socket)

    {again, %{"t" => "welcome"}} = hello(socket)
    mail(again, 1, ring)
    assert hear(again, 150) == :timeout
    say(again, %{t: "exited", ring: ring, code: 0})
    assert %{"t" => "ring", "ring" => next} = hear(again)
    assert next != ring
  end

  test "a second router on the same socket refuses to start", %{socket: socket} do
    start(socket)
    assert Vortex.Router.Listener.init(socket: socket) == {:stop, {:already_running, socket}}
    assert {_, %{"t" => "welcome"}} = hello(socket)
  end

  test "a stale socket file is replaced", %{socket: socket} do
    File.mkdir_p!(Path.dirname(socket))
    File.write!(socket, "")
    start(socket)
    assert {_, %{"t" => "welcome"}} = hello(socket)
  end
end

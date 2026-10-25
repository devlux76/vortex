defmodule Vortex.Router.Listener do
  @moduledoc """
  Listens on a Unix domain socket and gives each connection its own process.
  A connection must say hello first; after that its lines are events for its
  owner and the owner's rings are written back to it.
  """

  use GenServer

  require Logger

  alias Vortex.Router.{Owner, Wire}

  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @impl true
  def init(opts) do
    path = Keyword.fetch!(opts, :socket)
    hello_ms = Keyword.get(opts, :hello_ms, 5_000)
    dir = Path.dirname(path)

    unless File.dir?(dir) do
      File.mkdir_p!(dir)
      File.chmod!(dir, 0o700)
    end

    case :gen_tcp.connect({:local, path}, 0, [], 500) do
      {:ok, other} ->
        :gen_tcp.close(other)
        {:stop, {:already_running, path}}

      {:error, _} ->
        # Nobody answers, so a socket file left here is stale.
        File.rm(path)
        {:ok, listen} = :gen_tcp.listen(0, [:binary, ifaddr: {:local, path}, packet: :line, active: false, buffer: 1_048_576])
        File.chmod!(path, 0o600)
        Process.flag(:trap_exit, true)
        spawn_link(fn -> accept(listen, hello_ms) end)
        {:ok, %{listen: listen, path: path}}
    end
  end

  @impl true
  def handle_info({:EXIT, _acceptor, :normal}, state), do: {:noreply, state}
  def handle_info({:EXIT, _acceptor, reason}, state), do: {:stop, reason, state}

  @impl true
  def terminate(_reason, state) do
    :gen_tcp.close(state.listen)
    File.rm(state.path)
  end

  defp accept(listen, hello_ms) do
    case :gen_tcp.accept(listen) do
      {:ok, socket} ->
        {:ok, pid} =
          Task.Supervisor.start_child(Vortex.Router.Connections, fn ->
            receive do: (:ready -> serve(socket, hello_ms))
          end)

        :ok = :gen_tcp.controlling_process(socket, pid)
        send(pid, :ready)
        accept(listen, hello_ms)

      # The listener is shutting down.
      {:error, :closed} ->
        :ok
    end
  end

  defp serve(socket, hello_ms) do
    connection = self()

    with {:ok, line} <- :gen_tcp.recv(socket, 0, hello_ms),
         {:ok, {:hello, owner, token, quiet_ms}} <- Wire.decode(line) do
      case Owner.attach(owner, token, quiet_ms, &send(connection, {:out, &1})) do
        {:ok, pid} ->
          # If the owner process dies, this connection closes and the service
          # reconnects. A monitor, not a link: a connection that crashes must
          # not take the owner with it.
          Process.monitor(pid)
          write(socket, :welcome)
          loop(socket, pid)

        {:error, reason} ->
          write(socket, {:error, reason})
      end
    else
      _ -> write(socket, {:error, :bad_hello})
    end

    :gen_tcp.close(socket)
  end

  defp loop(socket, owner) do
    :inet.setopts(socket, active: :once)

    receive do
      {:tcp, ^socket, line} ->
        case Wire.decode(line) do
          {:ok, {:hello, _, _, _}} -> Logger.warning("router: second hello ignored")
          {:ok, {:embed, id, text}} -> Vortex.Router.Embedder.request(self(), id, text)
          {:ok, event} -> Owner.event(owner, event)
          :error -> Logger.warning("router: malformed line dropped")
        end

        loop(socket, owner)

      {:out, action} ->
        write(socket, action)
        loop(socket, owner)

      {:DOWN, _ref, :process, ^owner, _reason} ->
        :ok

      {:tcp_closed, ^socket} ->
        :ok

      {:tcp_error, ^socket, _reason} ->
        :ok
    end
  end

  defp write(socket, message), do: :gen_tcp.send(socket, [Wire.encode(message), ?\n])
end

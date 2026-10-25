defmodule Vortex.Router.CLI do
  @moduledoc """
  Entry point of the `vortex_router` escript.

      vortex_router --socket PATH [--max-per-hour N] [--min-interval-ms N]
                    [--max-failures N] [--pending-ms N]

  Prints `{"event":"ready","socket":PATH}` once it is listening, and exits
  with status 1 if it cannot start, for instance because another router is
  already listening on that socket.
  """

  @policy [max_per_hour: :integer, min_interval_ms: :integer, max_failures: :integer, pending_ms: :integer]

  def main(args) do
    {opts, [], []} = OptionParser.parse(args, strict: [socket: :string] ++ @policy)
    socket = Keyword.fetch!(opts, :socket)
    # Validate the settings now, not at the first hello.
    Vortex.Router.Policy.new(Keyword.take(opts, Keyword.keys(@policy)))

    # The tree is linked to this process: report its failure instead of dying with it.
    Process.flag(:trap_exit, true)

    case Vortex.Router.Supervisor.start_link(socket: socket, policy: Keyword.take(opts, Keyword.keys(@policy))) do
      {:ok, _pid} ->
        IO.puts(JSON.encode!(%{event: "ready", socket: socket}))

        receive do
          {:EXIT, _pid, reason} -> stop("stopped: #{inspect(reason)}")
        end

      {:error, reason} ->
        stop("cannot start: #{inspect(reason)}")
    end
  end

  defp stop(message) do
    IO.puts(:stderr, "vortex_router: #{message}")
    System.halt(1)
  end
end

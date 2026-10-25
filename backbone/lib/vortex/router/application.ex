defmodule Vortex.Router.Application do
  @moduledoc """
  The router as an OTP release (`bin/vortex_router start`), so a fix is
  loaded into the running node (`deploy/hot-load-router.sh`) instead of
  restarting the backbone every owner shares.

  Settings come from the environment: `VORTEX_ROUTER_SOCKET` (the router
  serves only when it is set), and optionally `VORTEX_ROUTER_MAX_PER_HOUR`,
  `VORTEX_ROUTER_MIN_INTERVAL_MS`, `VORTEX_ROUTER_MAX_FAILURES` and
  `VORTEX_ROUTER_PENDING_MS`. Without a socket (tests, or the escript, which
  starts its own tree) the application starts nothing.
  """

  use Application

  @policy [
    max_per_hour: "VORTEX_ROUTER_MAX_PER_HOUR",
    min_interval_ms: "VORTEX_ROUTER_MIN_INTERVAL_MS",
    max_failures: "VORTEX_ROUTER_MAX_FAILURES",
    pending_ms: "VORTEX_ROUTER_PENDING_MS"
  ]

  @impl true
  def start(_type, _args) do
    case System.get_env("VORTEX_ROUTER_SOCKET") do
      nil ->
        Supervisor.start_link([], strategy: :one_for_one, name: Vortex.Router.Idle)

      socket ->
        policy = for {key, var} <- @policy, value = System.get_env(var), do: {key, String.to_integer(value)}
        # Validate the settings now, not at the first hello.
        Vortex.Router.Policy.new(policy)

        with {:ok, pid} <- Vortex.Router.Supervisor.start_link(socket: socket, policy: policy) do
          IO.puts(JSON.encode!(%{event: "ready", socket: socket}))
          {:ok, pid}
        end
    end
  end
end

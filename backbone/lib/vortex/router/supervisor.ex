defmodule Vortex.Router.Supervisor do
  @moduledoc """
  The router's tree. Connections come last and owners before them, so a
  burst of failing connections cannot take the owners down with it.

  Options: `:socket` (required), `:budget` (file, by default
  `router-budget.term` beside the socket), `:policy` (options for
  `Vortex.Router.Policy.new/1`), `:hello_ms`.
  """

  use Supervisor

  def start_link(opts), do: Supervisor.start_link(__MODULE__, opts, name: __MODULE__)

  @impl true
  def init(opts) do
    socket = Keyword.fetch!(opts, :socket)
    budget = Keyword.get(opts, :budget, Path.join(Path.dirname(socket), "router-budget.term"))

    children = [
      {Registry, keys: :unique, name: Vortex.Router.Owners},
      {Vortex.Router.Budget, path: budget},
      {DynamicSupervisor, name: Vortex.Router.OwnerSupervisor, extra_arguments: [Keyword.get(opts, :policy, [])]},
      {Task.Supervisor, name: Vortex.Router.Connections},
      {Task.Supervisor, name: Vortex.Router.EmbeddingTasks},
      {Vortex.Router.Embedder, Keyword.take(opts, [:embed_urls])},
      {Vortex.Router.Listener, Keyword.take(opts, [:socket, :hello_ms])}
    ]

    Supervisor.init(children, strategy: :rest_for_one)
  end
end

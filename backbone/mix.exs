defmodule Vortex.Router.MixProject do
  use Mix.Project

  def project do
    [
      app: :vortex_router,
      version: "0.1.0",
      elixir: "~> 1.18",
      escript: [main_module: Vortex.Router.CLI, name: "vortex_router"],
      # The deployed router is this release, so fixes hot-load into it.
      releases: [vortex_router: [include_executables_for: [:unix]]],
      deps: []
    ]
  end

  def application, do: [mod: {Vortex.Router.Application, []}, extra_applications: [:logger, :inets, :crypto]]
end

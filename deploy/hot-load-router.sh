#!/bin/sh
# Load a fix into the running wake router without a restart: rebuild the
# release in place, then have the node load every module whose code on disk
# differs from what it runs, and every new module (a release does not load
# modules on demand). Run from the deployed checkout (vortex-live) after the
# tests pass on main.
#
# A module is loaded only after a soft purge succeeds, so no process still
# running the previous old version is killed; one that is not loaded is named,
# and the next run tries again. GenServers move to the new code on their next
# message. Changes to the supervision tree, application config or a Port's
# native code still need `systemctl --user restart vortex-router`.

set -eu
cd "$(dirname "$0")/../backbone"

MIX_ENV=prod mise exec -- mix compile --warnings-as-errors
MIX_ENV=prod mise exec -- mix release --overwrite

export RELEASE_DISTRIBUTION=name RELEASE_NODE=vortex_router@127.0.0.1 ERL_EPMD_ADDRESS=127.0.0.1
exec _build/prod/rel/vortex_router/bin/vortex_router rpc '
  ebin = :code.lib_dir(:vortex_router, :ebin)
  on_disk =
    for f <- File.ls!(ebin), String.ends_with?(f, ".beam"),
        do: f |> Path.rootname() |> String.to_atom()
  fresh = for m <- on_disk, :code.is_loaded(m) == false, do: m
  changed = :code.modified_modules() -- fresh

  # OTP caches each code path directory listing, so a module new to the
  # release is :nofile until the cache is cleared. New modules load first:
  # changed ones may call them, so they wait until every new one is in.
  :code.clear_cache()
  new = for m <- fresh, do: {m, :code.load_file(m)}
  Enum.each(new, fn {m, result} -> IO.puts("#{inspect(m)}: #{inspect(result)}") end)

  if Enum.all?(new, &match?({_, {:module, _}}, &1)) do
    for m <- changed do
      if :code.soft_purge(m) do
        IO.puts("#{inspect(m)}: #{inspect(:code.load_file(m))}")
      else
        IO.puts("#{inspect(m)}: old code still running, not loaded; run again")
      end
    end
  else
    IO.puts("a new module did not load: changed modules left as they are; run again")
  end

  if fresh ++ changed == [], do: IO.puts("nothing to load")
'

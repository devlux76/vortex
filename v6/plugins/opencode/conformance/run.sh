#!/bin/sh
# Type-check the real OpenCode fork's plugin Context against host.ts.
# Uses the fork's own compiler, base tsconfig and types. Fails closed: any
# compiler diagnostic (in this check or in fork sources it pulls in) or any
# nonzero compiler exit is a failure; the compiler's status is preserved.
set -eu
FORK=${1:-$HOME/vendor/opencode}
HERE=$(cd "$(dirname "$0")" && pwd)
TSC="$FORK/node_modules/.bin/tsc"
[ -x "$TSC" ] || { echo "FAIL: no compiler at $TSC"; exit 2; }
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
sed "s#FORK/#$FORK/#; s#'\.\./host\.ts'#'$HERE/../host.ts'#" "$HERE/check.ts.tmpl" > "$T/check.ts"
cat > "$T/tsconfig.json" <<JSON
{ "extends": "$FORK/node_modules/@tsconfig/bun/tsconfig.json",
  "compilerOptions": { "noEmit": true, "skipLibCheck": true, "noUncheckedIndexedAccess": false, "lib": ["ESNext", "DOM", "DOM.Iterable"],
                       "types": ["bun"], "typeRoots": ["$FORK/node_modules/@types"] },
  "files": ["check.ts"] }
JSON
REV=$(git -C "$FORK" rev-parse HEAD)
status=0
OUT=$(cd "$FORK" && "$TSC" -p "$T/tsconfig.json" 2>&1) || status=$?
if [ "$status" -ne 0 ] || [ -n "$OUT" ]; then
  echo "FAIL: fork $REV vs host.ts PluginCtx (compiler exit $status)"
  [ -n "$OUT" ] && echo "$OUT"
  [ "$status" -ne 0 ] && exit "$status"
  exit 1
fi
echo "OK: fork $REV satisfies host.ts PluginCtx"

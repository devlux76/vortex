#!/bin/sh
# Type-check the real OpenCode fork's plugin Context against host.ts.
# Uses the fork's own tsc and node_modules; prints only errors in this check.
set -eu
FORK=${1:-$HOME/vendor/opencode}
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
sed "s#FORK/#$FORK/#; s#'\.\./host\.ts'#'$HERE/../host.ts'#" "$HERE/check.ts.tmpl" > "$T/check.ts"
cat > "$T/tsconfig.json" <<JSON
{ "compilerOptions": { "strict": true, "noEmit": true, "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler", "allowImportingTsExtensions": true, "skipLibCheck": true, "types": [] }, "files": ["check.ts"] }
JSON
REV=$(git -C "$FORK" rev-parse HEAD)
OUT=$(cd "$FORK" && node_modules/.bin/tsc -p "$T/tsconfig.json" 2>&1 | grep -A20 "check.ts" || true)
if [ -n "$OUT" ]; then echo "FAIL: fork $REV does not satisfy host.ts PluginCtx"; echo "$OUT"; exit 1; fi
echo "OK: fork $REV satisfies host.ts PluginCtx"

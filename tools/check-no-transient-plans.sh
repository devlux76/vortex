#!/usr/bin/env bash
# Refuse transient problem-solving documents in the tree.
#
# These are one-off plans an agent drafts while working a problem. They are
# addressed when the work lands, and afterwards they are noise: the answer
# belongs in the issue, the code or the spec, not in a document that will only
# mislead the next reader. So they are never committed.
#
# The check is on tracked paths (the index, which is what a commit would carry),
# and it matches a path segment that is exactly "superpowers", wherever it sits
# in the tree.
#
# Runs in CI on every pull request and on main; run it locally before pushing.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

hits=$(git ls-files | grep -E '(^|/)superpowers(/|$)' || true)

if [ -n "$hits" ]; then
  echo "transient plan documents must not be committed:" >&2
  printf '  %s\n' "$hits" >&2
  echo "move what they say into the issue, the code or the spec, then delete the files." >&2
  exit 1
fi

echo "ok: no transient plan documents are tracked"

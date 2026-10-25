#!/bin/sh
# Prints one line per task: tests run and failures, or that the task did not compile.
# Run from this directory, in the copy a candidate worked in.
cd "$(dirname "$0")"
for t in 1 2 3 4 5 6 7; do
  summary=$(mix test "test/t${t}_test.exs" 2>&1 | grep -E '^[0-9]+ tests?, [0-9]+ failures?' | tail -1)
  echo "t$t: ${summary:-did not compile or run}"
done

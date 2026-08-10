#!/usr/bin/env bash
# Runs every test/repro-*.mjs script in sequence, continuing past a
# failure so one broken script doesn't hide the state of the rest, and
# prints a pass/fail summary. Exits non-zero if any script failed.
#
# Used by .github/workflows/repro-scripts.yml (issue #6 -- nothing ran
# these before, so a rename could silently invalidate one). Also usable
# by hand: `bash test/run-repro.sh`, from the repo root.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

pass=0
fail=0
failed_names=()

for script in test/repro-*.mjs; do
  echo "── $script ──"
  if node "$script"; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    failed_names+=("$script")
  fi
  echo
done

echo "═══════════════════════════════════════"
echo "repro scripts: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then
  echo "Failed:"
  for name in "${failed_names[@]}"; do
    echo "  - $name"
  done
  exit 1
fi

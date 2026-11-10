#!/usr/bin/env bash
# One command that runs every check. Needs: Node 20+, and PostgreSQL reachable at TEST_DATABASE_URL
# (start it with:  docker compose up -d postgres).  On Windows run this in Git Bash or WSL.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
pass=(); fail=()
run() { # run "<label>" <dir> <command...>
  local label="$1" dir="$2"; shift 2
  echo; echo "=== $label ==="
  if (cd "$ROOT/$dir" && "$@"); then pass+=("$label"); else fail+=("$label"); fi
}
run "backend: install"            backend npm install --no-audit --no-fund
run "backend: lint"               backend npm run lint
run "backend: typecheck"          backend npm run typecheck
run "backend: unit tests"         backend npm run test:unit
run "backend: integration tests"  backend npm run test:integration
run "backend: build"              backend npm run build
run "web: install"                web npm install --no-audit --no-fund
run "web: typecheck + build"      web npm run build
echo; echo "================ SUMMARY ================"
for p in "${pass[@]:-}"; do [ -n "$p" ] && echo "PASS  $p"; done
for f in "${fail[@]:-}"; do [ -n "$f" ] && echo "FAIL  $f"; done
[ ${#fail[@]} -eq 0 ] || { echo; echo "Copy everything above this line into the chat so I can fix the failures."; exit 1; }
echo "All checks passed."

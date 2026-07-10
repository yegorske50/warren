#!/usr/bin/env bash

set -u

WARREN_DIR="${WARREN_DIR:-$(pwd)}"

BURROW_DIR="${BURROW_DIR:-$(dirname "$WARREN_DIR")/burrow}"

ok(){ printf '  \033[32m✓\033[0m %s\n' "$1"; }

nope(){ printf '  \033[31m✗\033[0m %s\n' "$1"; }

warn(){ printf '  \033[33m⚠\033[0m %s\n' "$1"; }

skip(){ printf '  \033[36m⊘\033[0m %s\n' "$1"; }

printf '\n=== Warren × MiniMax setup check ===\n'


# container

printf '\n[1] Container state\n'

if command -v docker >/dev/null && docker info >/dev/null 2>&1; then

  (cd "$WARREN_DIR" && docker compose ps 2>&1 | sed -n '1,3p') | sed 's/^/  /'

else

  warn "docker not running"

fi


# healthz

printf '\n[2] HTTP API\n'

HZ=$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://localhost:8080/healthz 2>/dev/null)

if [ "$HZ" = "200" ]; then ok "/healthz → 200"; else nope "/healthz → ${HZ:-unreachable}"; fi


# readyz

printf '\n[3] /readyz (uses $TOKEN)\n'

if [ -n "${TOKEN:-}" ]; then

  R=$(curl -s -m 5 -H "Authorization: Bearer $TOKEN" http://localhost:8080/readyz)

  OK=$(echo "$R" | jq -r '.ok')

  if [ "$OK" = "true" ]; then ok "/readyz overall ok=true"; else nope "/readyz overall ok=$OK"; fi

  echo "$R" | jq -r '.checks[] | "  \(.name | if .ok then "✓" else "✗" end): " + (if .ok then "OK" else "FAIL" end) + (if .message then " (" + .message + ")" else "" end)'

else

  skip "skipped — export TOKEN=... to enable"

fi


# warren patches

printf '\n[4] Warren fork MiniMax patches\n'

if grep -q '"minimax"' "$WARREN_DIR/src/registry/builtins/model-tiers.ts" 2>/dev/null; then

  ok "model-tiers.ts patched"

else

  nope "model-tiers.ts missing 'minimax' (Change 1)"

fi

if grep -q '^MINIMAX_API_KEY=' "$WARREN_DIR/.env.example" 2>/dev/null; then

  ok ".env.example documents MINIMAX_API_KEY"

else

  nope ".env.example missing MINIMAX_API_KEY (Change 2)"

fi

if grep -qE '^[[:space:]]+github:[A-Za-z0-9_-]+/burrow' "$WARREN_DIR/Dockerfile" 2>/dev/null; then

  ok "Dockerfile pins your burrow fork"

else

  nope "Dockerfile still uses @os-eco/burrow-cli (Change 5)"

fi


# burrow patches

printf '\n[5] Burrow fork MiniMax patches\n'

if [ -f "$BURROW_DIR/src/runtime/pi.ts" ]; then

  if grep -qE 'minimax:[[:space:]]*\["MINIMAX_API_KEY"\]' "$BURROW_DIR/src/runtime/pi.ts"; then

    ok "pi.ts registers minimax env-key"

  else

    nope "pi.ts missing minimax env-key (Change 4)"

  fi

else

  warn "$BURROW_DIR/src/runtime/pi.ts not found (set BURROW_DIR=...)"

fi


# .env secrets

printf '\n[6] .env secrets\n'

if [ -f "$WARREN_DIR/.env" ]; then

  for k in WARREN_API_TOKEN BURROW_API_TOKEN WARREN_BURROW_TOKEN MINIMAX_API_KEY GITHUB_TOKEN; do

    v=$(grep "^$k=" "$WARREN_DIR/.env" | cut -d= -f2-)

    if [ -n "$v" ]; then ok "$k is set"; else nope "$k is empty/missing"; fi

  done

  B=$(grep '^BURROW_API_TOKEN=' "$WARREN_DIR/.env" | cut -d= -f2-)

  WB=$(grep '^WARREN_BURROW_TOKEN=' "$WARREN_DIR/.env" | cut -d= -f2-)

  [ "$B" = "$WB" ] && [ -n "$B" ] && ok "BURROW == WARREN_BURROW tokens match" || nope "BURROW tokens mismatch"

else

  warn ".env missing in $WARREN_DIR"

fi


# gh + git

printf '\n[7] gh auth + git identity\n'

command -v gh >/dev/null && gh auth status 2>&1 | grep -oE 'Logged in to github.com as [^ ]+' | head -1 | sed 's/^/  /' || warn "gh not installed"

if [ -d "$WARREN_DIR/.git" ]; then

  printf '  repo git user.name  = %s\n' "$(cd "$WARREN_DIR" && git config user.name 2>/dev/null || echo '<unset>')"

  printf '  repo git user.email = %s\n' "$(cd "$WARREN_DIR" && git config user.email 2>/dev/null || echo '<unset>')"

fi


printf '\n=== done ===\n'
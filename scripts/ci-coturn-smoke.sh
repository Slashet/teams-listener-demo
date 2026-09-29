#!/usr/bin/env bash
# CI smoke test for the production coturn service.
#
# Starts the `coturn` service from the unchanged production docker-compose.yml
# (same image, same entrypoint/config generator) with non-secret placeholder
# values, bound to 127.0.0.1 only (nothing is reachable from outside the
# runner), and verifies that:
#   1. coturn starts, stays running and logs no errors,
#   2. it answers TURN requests on the configured port over UDP and TCP,
#   3. relay sockets are pinned to the configured address,
#   4. an allocation with shared-secret credentials succeeds and one with a
#      wrong secret is rejected.
# No DNS, TLS, Azure or public IP is needed. Run from the repository root.
set -euo pipefail

PORT=3478
SECRET="ci-placeholder-not-a-real-secret"
ENV_FILE=".env"
CONTAINER="teams-listener-coturn"

if [ -e "$ENV_FILE" ]; then
  echo "refusing to overwrite existing $ENV_FILE" >&2
  exit 1
fi

cleanup() {
  echo "--- coturn log (tail) ---"
  docker compose logs --no-color coturn 2>/dev/null | tail -30 || true
  docker compose down --remove-orphans >/dev/null 2>&1 || true
  rm -f "$ENV_FILE"
}
trap cleanup EXIT

cat > "$ENV_FILE" <<ENV
TURN_REALM=turn.ci.invalid
TURN_PORT=${PORT}
TURN_MIN_PORT=49160
TURN_MAX_PORT=49200
TURN_LISTENING_IP=127.0.0.1
TURN_EXTERNAL_IP=
TURN_SHARED_SECRET=${SECRET}
ENV

docker compose up -d coturn

# coturn's own client, run inside the container against the loopback listener.
# The peer is loopback, which coturn denies (403): no relayed packets leave the
# runner, but a completed allocation proves the listener and credentials work.
allocation_ok() {
  local secret="$1" flags="${2:-}" out
  # shellcheck disable=SC2086
  out="$(docker compose exec -T coturn turnutils_uclient -p "$PORT" -W "$secret" $flags \
    -e 127.0.0.1 -n 1 -m 1 127.0.0.1 2>&1 || true)"
  echo "$out" | grep -qi "allocat" && ! echo "$out" | grep -q "Cannot complete Allocation"
}

ready=false
for _ in $(seq 1 30); do
  if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = "true" ] && allocation_ok "$SECRET"; then
    ready=true
    break
  fi
  sleep 1
done
if [ "$ready" != true ]; then
  echo "FAIL: coturn did not answer TURN requests on 127.0.0.1:${PORT}/udp" >&2
  exit 1
fi
echo "OK: coturn answers on 127.0.0.1:${PORT}/udp (allocation succeeded)"

if ! allocation_ok "$SECRET" "-t"; then
  echo "FAIL: coturn did not answer TURN requests on 127.0.0.1:${PORT}/tcp" >&2
  exit 1
fi
echo "OK: coturn answers on 127.0.0.1:${PORT}/tcp (allocation succeeded)"

logs="$(docker compose logs --no-color coturn)"
if ! echo "$logs" | grep -q "Relay address to use: 127.0.0.1"; then
  echo "FAIL: relay address was not pinned to TURN_LISTENING_IP" >&2
  exit 1
fi
echo "OK: relay pinned to 127.0.0.1"

if echo "$logs" | grep -q "ERROR:"; then
  echo "FAIL: coturn logged errors during start-up / valid allocations" >&2
  exit 1
fi
echo "OK: no errors in coturn log"

# Last, because a rejected login is (correctly) logged as an error.
if allocation_ok "wrong-${SECRET}"; then
  echo "FAIL: allocation with a wrong secret was not rejected" >&2
  exit 1
fi
echo "OK: allocation with a wrong secret rejected"

if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" != "true" ]; then
  echo "FAIL: coturn container exited" >&2
  exit 1
fi
echo "coturn smoke test passed"

#!/bin/sh
# Generates turnserver.conf from environment variables at start-up and runs
# coturn. The config (which contains credentials) is written to a tmpfs with
# mode 600 and never printed. Credentials are not passed as command-line
# arguments, so they do not show up in `ps` on the host.
set -eu

fail() { echo "coturn: $1" >&2; exit 1; }

: "${TURN_REALM:?TURN_REALM is required}"
TURN_PORT="${TURN_PORT:-3478}"
TURN_MIN_PORT="${TURN_MIN_PORT:-49160}"
TURN_MAX_PORT="${TURN_MAX_PORT:-49200}"

if [ -z "${TURN_SHARED_SECRET:-}" ]; then
  [ -n "${TURN_USERNAME:-}" ] && [ -n "${TURN_PASSWORD:-}" ] || fail "set TURN_SHARED_SECRET or TURN_USERNAME + TURN_PASSWORD"
  case "$TURN_USERNAME" in *:*) fail "TURN_USERNAME must not contain ':'";; esac
fi

CONF=/tmp/turnserver.conf
umask 077
{
  echo "listening-port=${TURN_PORT}"
  [ -n "${TURN_LISTENING_IP:-}" ] && echo "listening-ip=${TURN_LISTENING_IP}"
  [ -n "${TURN_EXTERNAL_IP:-}" ] && echo "external-ip=${TURN_EXTERNAL_IP}"
  echo "realm=${TURN_REALM}"
  echo "server-name=${TURN_REALM}"
  echo "min-port=${TURN_MIN_PORT}"
  echo "max-port=${TURN_MAX_PORT}"

  echo "fingerprint"
  if [ -n "${TURN_SHARED_SECRET:-}" ]; then
    # Time-limited credentials minted by the app (TURN REST API scheme).
    echo "use-auth-secret"
    echo "static-auth-secret=${TURN_SHARED_SECRET}"
  else
    echo "lt-cred-mech"
    echo "user=${TURN_USERNAME}:${TURN_PASSWORD}"
  fi

  # Plain TURN over UDP/TCP 3478 only (no TLS listener / certificates).
  echo "no-tls"
  echo "no-dtls"
  echo "no-cli"
  echo "no-multicast-peers"
  echo "no-software-attribute"
  echo "stale-nonce=600"

  # Sized for a 4-person demo.
  echo "user-quota=12"
  echo "total-quota=60"

  # Never relay into private / loopback / link-local networks (SSRF protection).
  for range in \
    0.0.0.0-0.255.255.255 \
    10.0.0.0-10.255.255.255 \
    100.64.0.0-100.127.255.255 \
    127.0.0.0-127.255.255.255 \
    169.254.0.0-169.254.255.255 \
    172.16.0.0-172.31.255.255 \
    192.0.0.0-192.0.0.255 \
    192.0.2.0-192.0.2.255 \
    192.168.0.0-192.168.255.255 \
    198.18.0.0-198.19.255.255 \
    198.51.100.0-198.51.100.255 \
    203.0.113.0-203.0.113.255 \
    224.0.0.0-255.255.255.255 \
    ::1 \
    fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff \
    fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
  do
    echo "denied-peer-ip=${range}"
  done

  echo "log-file=stdout"
  echo "simple-log"
  echo "pidfile=/tmp/turnserver.pid"
  echo "userdb=/var/lib/coturn/turndb"
} > "$CONF"

echo "coturn: starting on port ${TURN_PORT} (relay ${TURN_MIN_PORT}-${TURN_MAX_PORT}), realm ${TURN_REALM}"
exec turnserver -c "$CONF"

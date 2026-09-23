#!/bin/sh
# Generates a self-signed TLS cert (once) before handing off to the stock
# postgres entrypoint. CN is taken from $SSL_DOMAIN (your DuckDNS hostname)
# so clients connecting with `ssl: { rejectUnauthorized: false }` (same as
# this app already does against Neon) work without extra CA setup.
set -e

CERT_DIR=/var/lib/postgresql/certs
mkdir -p "$CERT_DIR"

if [ ! -f "$CERT_DIR/server.crt" ] || [ ! -f "$CERT_DIR/server.key" ]; then
  echo "[ssl] generating self-signed cert for CN=${SSL_DOMAIN:-localhost}"
  openssl req -new -x509 -days 3650 -nodes -text \
    -out "$CERT_DIR/server.crt" \
    -keyout "$CERT_DIR/server.key" \
    -subj "/CN=${SSL_DOMAIN:-localhost}"
fi

chown postgres:postgres "$CERT_DIR/server.key" "$CERT_DIR/server.crt"
chmod 600 "$CERT_DIR/server.key"

exec docker-entrypoint.sh "$@"

#!/bin/bash
# Levanta el servidor local y lo expone por un túnel público de Cloudflare.
# Uso: ./dev-tunnel.sh            (puerto 7000)
#      PORT=8080 ./dev-tunnel.sh
#
# El túnel arranca ANTES que el servidor a propósito: necesitamos su URL para
# pasarla al addon como ADDON_PUBLIC_URL. Sin ella, el manifest se
# autorreferencia con la cabecera Host que llega del túnel y el "logo" y el
# "background" salen apuntando a un dominio inalcanzable — el mismo problema
# que en BeamUp. A cloudflared no le importa que aún no haya nada escuchando.

set -euo pipefail

PORT="${PORT:-7000}"
URL_TIMEOUT="${URL_TIMEOUT:-40}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "Falta cloudflared. Instálalo con:  sudo apt install cloudflared" >&2
  exit 1
fi

TUNNEL_LOG="$(mktemp -t dev-tunnel.XXXXXX.log)"
SERVER_PID=""
TUNNEL_PID=""

cleanup() {
  trap - EXIT INT TERM
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true
  rm -f "$TUNNEL_LOG"
}
trap cleanup EXIT INT TERM

# Libera el puerto por si quedó un proceso de una ejecución anterior.
fuser -k "${PORT}/tcp" 2>/dev/null || true

echo "Abriendo túnel..."
# --protocol http2 no es opcional en redes que bloquean UDP saliente en el
# 7844: cloudflared intentaría QUIC y reintentaría con retroceso exponencial
# (2s, 4s, 8s, 16s, 32s...) antes de rendirse y caer a HTTP/2 igualmente. Eso
# es puro tiempo perdido en cada arranque. Su propio pre-check lo sugiere.
cloudflared tunnel --url "http://localhost:${PORT}" --protocol http2 \
  >"$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!

# Esperar a que imprima la URL, en vez de dormir a ciegas una cantidad fija.
PUBLIC_URL=""
for _ in $(seq "$URL_TIMEOUT"); do
  PUBLIC_URL="$(grep -om1 'https://[a-z0-9-]*\.trycloudflare\.com' "$TUNNEL_LOG" || true)"
  [ -n "$PUBLIC_URL" ] && break
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "cloudflared murió antes de dar una URL:" >&2
    tail -n 20 "$TUNNEL_LOG" >&2
    exit 1
  fi
  sleep 1
done

if [ -z "$PUBLIC_URL" ]; then
  echo "No se obtuvo URL del túnel en ${URL_TIMEOUT}s:" >&2
  tail -n 20 "$TUNNEL_LOG" >&2
  exit 1
fi

echo "Iniciando servidor..."
ADDON_PUBLIC_URL="$PUBLIC_URL" PORT="$PORT" node src/index.js &
SERVER_PID=$!

cat <<BANNER

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Configurar:  ${PUBLIC_URL}/configure
  Local:       http://127.0.0.1:${PORT}/configure

  Sin interstitial: la URL se puede pegar en Stremio tal cual.
  La URL cambia en cada arranque, así que el addon hay que
  reinstalarlo en Stremio cada vez.

  Log del túnel: ${TUNNEL_LOG}
  Ctrl+C para parar servidor y túnel.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

BANNER

# Si cualquiera de los dos cae, el trap se lleva al otro por delante.
wait -n "$SERVER_PID" "$TUNNEL_PID"

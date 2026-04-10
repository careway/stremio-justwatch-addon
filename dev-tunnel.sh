#!/bin/bash
# Inicia el servidor y crea un túnel público con localtunnel
# Uso: ./dev-tunnel.sh

set -e

# Matar procesos previos en el puerto 7000
fuser -k 7000/tcp 2>/dev/null || true

echo "Iniciando servidor..."
node src/index.js &
SERVER_PID=$!
echo "Servidor PID: $SERVER_PID"

sleep 1

echo ""
echo "Abriendo túnel público..."
# --print-requests muestra cada solicitud entrante
npx --yes localtunnel --port 7000 &
LT_PID=$!

# Esperar a que localtunnel imprima la URL
sleep 4

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  IMPORTANTE: Antes de usar en Stremio:"
echo "  1. Abre la URL del túnel (https://xxxx.loca.lt)"
echo "     en el navegador y pulsa 'Click to Continue'"
echo "  2. Luego ve a /configure para generar tu manifest"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Pulsa Ctrl+C para detener todo"

# Esperar a que ambos procesos terminen
wait $SERVER_PID $LT_PID

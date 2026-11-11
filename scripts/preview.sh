#!/usr/bin/env bash
# Förhandsvisning av dashboarden i Docker innan deploy: mockdata plus påhittad kostnadshistorik.
#   scripts/preview.sh         bygg, fyll databasen och starta på port 3001
#   scripts/preview.sh stop    stoppa och ta bort containern och datamappen
# Öppna http://localhost:3001/ (hela dashboarden) och http://localhost:3001/?view=kitchen (köksvyn, fönster 1280x800).
set -euo pipefail
cd "$(dirname "$0")/.."
NAME=hd-preview
IMAGE=home-dashboard:preview
PORT="${PREVIEW_PORT:-3001}"
DATA="$(pwd)/.preview-data"

if [ "${1:-}" = "stop" ]; then
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$DATA"
  echo "förhandsvisningen är borttagen"
  exit 0
fi

docker rm -f "$NAME" >/dev/null 2>&1 || true
rm -rf "$DATA"; mkdir -p "$DATA"; chmod 777 "$DATA"
docker build -t "$IMAGE" .
docker run --rm -v "$DATA:/app/server/data" "$IMAGE" node server/scripts/seed-preview.js
docker run -d --name "$NAME" -p "$PORT:3000" -v "$DATA:/app/server/data" \
  -e TUYA_MOCK=1 -e NEXBLUE_MOCK=1 -e ELECTRICITY_MOCK=1 -e ROBOROCK_MOCK=1 "$IMAGE" >/dev/null
for _ in $(seq 1 30); do
  curl -sf "http://localhost:$PORT/api/version" >/dev/null && break
  sleep 1
done
echo "Förhandsvisning igång:"
echo "  http://localhost:$PORT/"
echo "  http://localhost:$PORT/?view=kitchen   (fönster 1280x800)"
echo "Ta bort med: scripts/preview.sh stop"

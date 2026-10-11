#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
N8N_CONTAINER=${N8N_CONTAINER:-n8n-chatgpt-oauth-n8n-1}
BRIDGE_IMAGE=${BRIDGE_IMAGE:-n8n-chatgpt-oauth-chatgpt-bridge}
SMOKE_NETWORK=${SMOKE_NETWORK:-n8n-chatgpt-oauth_default}
chmod 0644 test/mock-server.mjs test/n8n-sdk-smoke.cjs
docker run -d --rm --name n8n-chatgpt-sdk-smoke --network "$SMOKE_NETWORK" --memory 256m \
  -e CHATGPT_BRIDGE_API_KEY=mock-bridge-key-with-more-than-24-characters \
  -v "$PWD/test/mock-server.mjs:/app/test/mock-server.mjs:ro" \
  "$BRIDGE_IMAGE" node test/mock-server.mjs >/dev/null
trap 'docker stop n8n-chatgpt-sdk-smoke >/dev/null 2>&1 || true' EXIT
docker cp test/n8n-sdk-smoke.cjs "$N8N_CONTAINER":/tmp/n8n-sdk-smoke.cjs
ready=false
for attempt in 1 2 3 4 5; do
  if docker exec n8n-chatgpt-sdk-smoke node -e "fetch('http://127.0.0.1:3210/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [ "$ready" != true ]; then
  docker logs n8n-chatgpt-sdk-smoke --tail 20
  exit 1
fi
docker exec "$N8N_CONTAINER" node /tmp/n8n-sdk-smoke.cjs

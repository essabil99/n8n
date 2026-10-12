#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
private=/home/saad/workspaces/n8n-chatgpt-oauth/private
python3 - <<'PY'
from pathlib import Path
import secrets
private=Path('/home/saad/workspaces/n8n-chatgpt-oauth/private')
values={}
for line in (private/'stack.env').read_text().splitlines():
    if '=' in line and not line.startswith('#'):
        key,value=line.split('=',1);values[key]=value.strip("'\"")
env={'N8N_ENCRYPTION_KEY':secrets.token_hex(32),'N8N_DIAGNOSTICS_ENABLED':'false','N8N_VERSION_NOTIFICATIONS_ENABLED':'false','N8N_TEMPLATES_ENABLED':'false','N8N_SECURE_COOKIE':'false','N8N_HOST':'n8n-assistant-smoke','N8N_PROTOCOL':'http','N8N_EDITOR_BASE_URL':'http://n8n-assistant-smoke:5678','N8N_INSTANCE_AI_MODEL':'openai/chatgpt-plan','N8N_INSTANCE_AI_MODEL_URL':'http://n8n-chatgpt-sdk-smoke:3210/v1','N8N_INSTANCE_AI_MODEL_API_KEY':'mock-bridge-key-with-more-than-24-characters','N8N_INSTANCE_AI_SANDBOX_ENABLED':'true','N8N_INSTANCE_AI_SANDBOX_PROVIDER':'n8n-sandbox','N8N_SANDBOX_SERVICE_URL':'http://sandbox-api:8080','N8N_SANDBOX_SERVICE_API_KEY':values['SANDBOX_API_KEY'],'NODE_OPTIONS':'--max-old-space-size=1024','GENERIC_TIMEZONE':'Africa/Casablanca'}
path=private/'assistant-smoke.env';path.touch(mode=0o600,exist_ok=True);path.write_text('\n'.join(key+'='+value for key,value in env.items())+'\n');path.chmod(0o600)
PY
cleanup() {
  docker stop n8n-assistant-smoke n8n-chatgpt-sdk-smoke >/dev/null 2>&1 || true
  rm -f "$private/assistant-smoke.env"
}
trap cleanup EXIT
docker run -d --rm --name n8n-chatgpt-sdk-smoke --network n8n-chatgpt-oauth_default --memory 256m \
  -e CHATGPT_BRIDGE_API_KEY=mock-bridge-key-with-more-than-24-characters \
  -v "$PWD/test:/app/test:ro" -v "$PWD/src:/app/src:ro" n8n-chatgpt-oauth-chatgpt-bridge node test/assistant-mock-server.mjs >/dev/null
docker run -d --rm --name n8n-assistant-smoke --network n8n-chatgpt-oauth_default --memory 1536m \
  --env-file "$private/assistant-smoke.env" --tmpfs /home/node/.n8n:uid=1000,gid=1000,mode=0700,size=128m \
  "${N8N_CHATGPT_SMOKE_IMAGE:-n8n-chatgpt-plan:2.42.6}" >/dev/null
ready=false
for attempt in $(seq 1 45); do
  if docker exec n8n-assistant-smoke wget -qO- http://127.0.0.1:5678/healthz/readiness >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [ "$ready" != true ]; then docker logs n8n-assistant-smoke --tail 25; exit 1; fi
docker cp test/sandbox-concurrency-smoke.cjs n8n-assistant-smoke:/tmp/sandbox-concurrency-smoke.cjs
docker exec n8n-assistant-smoke node /tmp/sandbox-concurrency-smoke.cjs
docker cp test/n8n-sdk-smoke.cjs n8n-assistant-smoke:/tmp/n8n-sdk-smoke.cjs
docker exec n8n-assistant-smoke node /tmp/n8n-sdk-smoke.cjs > "$private/reasoning-after.log" 2>&1 || { tail -12 "$private/reasoning-after.log"; docker logs n8n-chatgpt-sdk-smoke --tail 6; exit 1; }
cat "$private/reasoning-after.log"
docker cp test/assistant-rest-smoke.cjs n8n-assistant-smoke:/tmp/assistant-rest-smoke.cjs
docker exec n8n-assistant-smoke node /tmp/assistant-rest-smoke.cjs || {
  docker logs n8n-assistant-smoke --tail 35
  docker logs n8n-chatgpt-sdk-smoke --tail 12
  exit 1
}

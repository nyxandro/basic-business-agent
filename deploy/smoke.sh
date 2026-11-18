#!/usr/bin/env bash
# Smoke check of an installation (spec, step 21). Builds the images, starts deploy/compose.yaml as a
# separate project "bba-smoke" with generated secrets, checks what every installation must
# guarantee, measures memory under load, and at the end removes that project with its own volumes.
#   bash deploy/smoke.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PROJECT="bba-smoke"
# A port of this check only, apart from the development stand (8080) and a real installation.
PORT=18080
BASE="http://127.0.0.1:${PORT}"
# Memory share of its ceiling a container may use under the load below.
MAX_MEM_PERCENT=90
LOAD_REQUESTS=400
LOAD_PARALLEL=40

ENV_FILE="$(mktemp)"
random() { openssl rand -hex 24; }
cat > "$ENV_FILE" <<ENV
POSTGRES_USER=bba
POSTGRES_PASSWORD=$(random)
POSTGRES_DB=bba
APP_PUBLIC_URL=http://localhost:${PORT}
SITE_ADDRESS=:80
WEB_BIND=127.0.0.1:${PORT}
WEB_BIND_TLS=127.0.0.1:18443
BETTER_AUTH_SECRET=$(random)
APP_ENCRYPTION_KEYS=1:$(openssl rand -base64 32)
LITELLM_MASTER_KEY=sk-$(random)
LITELLM_CALLBACK_SECRET=$(random)
LITELLM_SALT_KEY=sk-$(random)
ENV

compose() { docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$HERE/compose.yaml" "$@"; }
# An installation keeps its secrets in deploy/.env; the image must not take it. When there is none,
# a stand-in is put there for the build and removed afterwards.
PROBE_ENV=""
if [[ ! -e "$HERE/.env" ]]; then
  PROBE_ENV="$HERE/.env"
  echo "SMOKE_PROBE=must-not-reach-the-image" > "$PROBE_ENV"
fi
cleanup() {
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -f "$ENV_FILE"
  if [[ -n "$PROBE_ENV" ]]; then rm -f "$PROBE_ENV"; fi
}
trap cleanup EXIT

failures=0
check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then echo "ok   ${name}"; else echo "FAIL ${name}: expected ${expected}, got ${actual}"; failures=$((failures + 1)); fi
}
status() { curl --noproxy '*' -s -o /dev/null -w '%{http_code}' "$@"; }
psql_db() { compose exec -T db psql -U bba -d bba -tAc "$1"; }

echo "== build and start (${PROJECT})"
compose up -d --build --wait

echo "== addresses from outside"
check "/app/api/health through Caddy is 200" 200 "$(status "$BASE/app/api/health")"
check "/api/agents is 404" 404 "$(status "$BASE/api/agents")"
check "/app/api/internal/usage is 404 from outside" 404 "$(status -X POST "$BASE/app/api/internal/usage")"
check "/app/api/internal/account-events is 404 from outside" 404 "$(status -X POST "$BASE/app/api/internal/account-events")"
check "an interface page is served" 200 "$(status "$BASE/login")"
check "/app/api without a session is 401" 401 "$(status "$BASE/app/api/me")"

echo "== sandbox of skill scripts"
app_id="$(compose ps -q app)"
check "seccomp profile is attached" yes "$(docker inspect "$app_id" --format '{{json .HostConfig.SecurityOpt}}' | grep -q seccomp && echo yes || echo no)"
check "bubblewrap isolation starts" ok "$(compose exec -T app node -e "import('@mastra/core/workspace').then((m) => console.log(m.LocalSandbox.detectIsolation().available ? 'ok' : 'unavailable'))")"
check "inside the isolation there is no network" blocked "$(compose exec -T app bwrap --unshare-all --die-with-parent --ro-bind / / --dev /dev --proc /proc python3 -c "import socket; socket.create_connection(('1.1.1.1', 53), 2)" >/dev/null 2>&1 && echo open || echo blocked)"
check "the programs, Python libraries and Node packages of the skills are in the image" ok "$(compose exec -T app node -e "import('/app/core/sandbox/environment.ts').then((m) => { m.assertSandboxEnvironment('/app/.venv-skills'); console.log('ok'); })")"
check "Node packages of the skills load (sharp with its native part)" ok "$(compose exec -T app sh -c 'NODE_PATH=/app/.venv-skills/node/node_modules node -e "require(\"docx\"); require(\"pptxgenjs\"); require(\"sharp\"); console.log(\"ok\")"')"
# The sandbox of the agents exactly (Mastra's bubblewrap with core/sandbox/environment.ts sandboxOptions:
# only /usr, /lib, a few files of /etc and the folders of the skills are seen), not the whole image.
check "LibreOffice turns a Word document into PDF in the sandbox of the agents" ok "$(compose exec -T app node --input-type=module -e "
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { LocalSandbox } from '@mastra/core/workspace';
import { sandboxOptions } from '/app/core/sandbox/environment.ts';
const dir = mkdtempSync('/workspace/.smoke-');
try {
  execFileSync('/app/.venv-skills/bin/python', ['-c', 'import docx, sys; d = docx.Document(); d.add_paragraph(sys.argv[2]); d.save(sys.argv[1])', dir + '/t.docx', 'Проверка']);
  const result = await new LocalSandbox(sandboxOptions('/app/.venv-skills', dir, [], 'bwrap')).executeCommand('soffice -env:UserInstallation=file:///tmp/lo --headless --convert-to pdf t.docx');
  console.log(existsSync(dir + '/t.pdf') ? 'ok' : 'missing: ' + result.stderr.slice(-300));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
")"
# The viewer's conversions (spec, section 8.27): every format of core/preview/fixtures through the same
# LibreOffice, sandbox and qpdf as the installation, LibreOffice 7.4 of the image.
check "every format of the document viewer turns into PDF in the sandbox" "all 13 formats ok" "$(compose exec -T app node tooling/preview-check.ts 2>/dev/null | tail -1)"
check "no .env files with secrets in the image" none "$(compose exec -T app sh -c 'find /app -name ".env" -not -path "*/node_modules/*" | grep -q . && echo found || echo none')"
check "the app cannot change its code" denied "$(compose exec -T app sh -c 'touch /app/core/x 2>/dev/null && echo allowed || echo denied')"
echo "== login files of the ChatGPT accounts (volume chatgpt-auth)"
check "the app writes a login file" ok "$(compose exec -T app sh -c 'echo "{}" > /chatgpt-auth/a-00000000.json && echo ok || echo denied')"
check "LiteLLM reads it and writes a refreshed token back" ok "$(compose exec -T litellm sh -c 'cat /chatgpt-auth/a-00000000.json >/dev/null && echo "{}" > /chatgpt-auth/a-00000000.json && echo ok || echo denied')"
check "the folder is closed to other users of the container" 700 "$(compose exec -T app stat -c %a /chatgpt-auth)"
compose exec -T app rm -f /chatgpt-auth/a-00000000.json

echo "== data survives an update of the app image (migrations run again)"
psql_db "INSERT INTO app.org_profile (tone, requisites, industry) VALUES ('smoke-marker', '', '') ON CONFLICT (id) DO UPDATE SET tone = EXCLUDED.tone" >/dev/null
compose up -d --force-recreate --wait app
check "the record is still there" smoke-marker "$(psql_db "SELECT tone FROM app.org_profile")"

echo "== memory under load (${LOAD_REQUESTS} requests, ${LOAD_PARALLEL} at a time)"
seq "$LOAD_REQUESTS" | xargs -P "$LOAD_PARALLEL" -I{} curl --noproxy '*' -s -o /dev/null "$BASE/app/api/health"
stats="$(docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}' $(compose ps -q))"
echo "$stats"
while IFS=$'\t' read -r name _ percent; do
  value="${percent%\%}"
  if awk -v v="$value" -v max="$MAX_MEM_PERCENT" 'BEGIN { exit !(v > max) }'; then
    echo "FAIL memory of ${name}: ${percent} of its ceiling"
    failures=$((failures + 1))
  fi
done <<< "$stats"

if [[ "$failures" -gt 0 ]]; then
  echo "smoke: ${failures} check(s) failed"
  exit 1
fi
echo "smoke: all checks passed"

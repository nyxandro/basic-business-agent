# syntax=docker/dockerfile:1
# Images of an installation (spec, section 17.1), built from the repository root:
#   app — the server, the sandboxes of skill scripts (bubblewrap) and the document skills' Python;
#   web — Caddy with the built interface; only /app/api goes through to the app.
# deploy/compose.yaml builds both.

ARG NODE_IMAGE=node:24.16.0-bookworm-slim
ARG CADDY_IMAGE=caddy:2.10.2-alpine

# pnpm of the repository (package.json: packageManager) and the manifests of the workspace.
FROM ${NODE_IMAGE} AS pnpm
ENV CI=true
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY contracts/package.json contracts/
COPY web/package.json web/

FROM pnpm AS web-build
# --ignore-scripts: the repository's "prepare" sets git hooks, there is no git in an image.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@bba/web..."
COPY tsconfig.base.json ./
COPY contracts contracts
COPY web web
RUN pnpm -C web build

# Production dependencies of the server only (no web, no test tools).
FROM pnpm AS app-deps
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter "basic-business-agent..."

FROM ${NODE_IMAGE} AS app
# bubblewrap isolates skill scripts; the programs they run (LibreOffice, pandoc, poppler, qpdf,
# tesseract, fonts) are listed in core/sandbox/apt-packages.txt (spec, section 8.18).
COPY core/sandbox/apt-packages.txt /tmp/apt-packages.txt
RUN apt-get update \
  && grep -v '^#' /tmp/apt-packages.txt | xargs apt-get install -y --no-install-recommends bubblewrap python3 python3-venv ca-certificates \
  && rm -rf /var/lib/apt/lists/* /tmp/apt-packages.txt
WORKDIR /app
# Python libraries and Node packages of the skills (pinned in core/sandbox/requirements.txt and
# core/sandbox/node); the sandbox mounts .venv-skills read-only, NODE_PATH points at its node_modules.
COPY core/sandbox/requirements.txt /tmp/skills-requirements.txt
RUN python3 -m venv /app/.venv-skills \
  && /app/.venv-skills/bin/pip install --no-cache-dir -r /tmp/skills-requirements.txt \
  && rm /tmp/skills-requirements.txt
COPY core/sandbox/node/package.json core/sandbox/node/package-lock.json /app/.venv-skills/node/
RUN npm ci --prefix /app/.venv-skills/node --omit=dev --no-audit --no-fund \
  && npm cache clean --force
COPY --from=app-deps /src/node_modules node_modules
COPY --from=app-deps /src/contracts/node_modules contracts/node_modules
COPY . .
# The code belongs to root and cannot be changed by the app; the app writes only the employees'
# workspaces, the unpacked skills, the generated LiteLLM config (compose: one-shot service litellm-config),
# the login files of the ChatGPT accounts and, in the container mcp-runner, the packages of program servers.
RUN useradd --system --create-home --uid 10001 app \
  && mkdir -p /workspace /app/deploy/litellm /app/skills-unpacked /chatgpt-auth /packages \
  && chown app /workspace /app/deploy/litellm /app/skills-unpacked /chatgpt-auth /packages \
  && chmod 700 /chatgpt-auth
ENV NODE_ENV=production
USER app
EXPOSE 3000
CMD ["node", "core/server/main.ts"]

FROM ${CADDY_IMAGE} AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /src/web/dist /srv

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
RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap python3 python3-venv ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Python libraries of the document skills (pinned in core/sandbox/requirements.txt).
COPY core/sandbox/requirements.txt /tmp/skills-requirements.txt
RUN python3 -m venv /app/.venv-skills \
  && /app/.venv-skills/bin/pip install --no-cache-dir -r /tmp/skills-requirements.txt \
  && rm /tmp/skills-requirements.txt
COPY --from=app-deps /src/node_modules node_modules
COPY --from=app-deps /src/contracts/node_modules contracts/node_modules
COPY . .
# The code belongs to root and cannot be changed by the app; the app writes only the employees'
# workspaces, the unpacked skills, the generated LiteLLM config (compose: one-shot service litellm-config)
# and the login files of the ChatGPT accounts.
RUN useradd --system --create-home --uid 10001 app \
  && mkdir -p /workspace /app/deploy/litellm /app/skills-unpacked /chatgpt-auth \
  && chown app /workspace /app/deploy/litellm /app/skills-unpacked /chatgpt-auth \
  && chmod 700 /chatgpt-auth
ENV NODE_ENV=production
USER app
EXPOSE 3000
CMD ["node", "core/server/main.ts"]

FROM ${CADDY_IMAGE} AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /src/web/dist /srv

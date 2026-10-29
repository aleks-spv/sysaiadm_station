# build: install workspace deps and build the web UI
FROM oven/bun:1 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile && bun run --filter @sysadm/web build

# opencode CLI: the native binary shipped in the npm package; only the binary is copied out.
FROM node:22-slim AS opencode
RUN npm install -g @opencode/cli@2.2.0 && npm cache clean --force

# runtime: server (spawns opencode as a child), plugin directory, skills, built UI; no git, no .env (passed by compose)
FROM oven/bun:1-slim
WORKDIR /app
COPY --from=build /src/package.json /src/bun.lock ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/apps/server ./apps/server
COPY --from=build /src/packages ./packages
COPY --from=build /src/apps/web/dist ./apps/web/dist
COPY --from=build /src/skills ./skills
COPY --from=opencode /usr/local/lib/node_modules/@opencode/cli/bin/opencode.exe /usr/local/bin/opencode
ENV SKILLS_DIR=/app/skills WEB_DIST=/app/apps/web/dist OPENCODE_BIN=/usr/local/bin/opencode OPENCODE_HOME=/data/opencode PLUGIN_PATH=/app/packages/plugin
# Volumes mounted at /data and /infra inherit this ownership; otherwise SQLite and opencode cannot create their files.
RUN mkdir -p /data/opencode /infra && chown -R 1000:1000 /data /infra
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s CMD ["bun", "-e", "fetch('http://127.0.0.1:8080/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["bun", "apps/server/src/index.ts"]

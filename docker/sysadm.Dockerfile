# build: install workspace deps and build the web UI
FROM oven/bun:1 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile && bun run --filter @sysadm/web build

# runtime: server, shared types, skills, built UI; no git, no .env (passed by compose)
FROM oven/bun:1-slim
WORKDIR /app
COPY --from=build /src/package.json /src/bun.lock ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/apps/server ./apps/server
COPY --from=build /src/packages/shared ./packages/shared
COPY --from=build /src/apps/web/dist ./apps/web/dist
COPY --from=build /src/skills ./skills
ENV SKILLS_DIR=/app/skills WEB_DIST=/app/apps/web/dist
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s CMD ["bun", "-e", "fetch('http://127.0.0.1:8080/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["bun", "apps/server/src/index.ts"]

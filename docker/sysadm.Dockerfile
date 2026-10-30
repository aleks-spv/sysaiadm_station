# build: install workspace deps and build the web UI
FROM oven/bun:1 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile && bun run --filter @sysadm/web build

# rtk (Apache-2.0 edition) for the rtk plugin: pinned release, checksum verified.
FROM alpine:3.20 AS rtk
ARG TARGETARCH
ARG RTK_VERSION=v1.1.0
RUN set -eu; \
  case "${TARGETARCH:-amd64}" in \
    amd64) asset=rtk-oss-x86_64-unknown-linux-musl.tar.gz; sum=4dec94a64035e08189ae82fd5408fe4ae9ae27a665fc07e3e3ec3c4c2d8e8a3e ;; \
    arm64) asset=rtk-oss-aarch64-unknown-linux-gnu.tar.gz; sum=57a4fac13d18da77f0577ea8b68def7934b934bf76d0a6e161f0bfd06b1e1078 ;; \
    *) echo "unsupported arch ${TARGETARCH}"; exit 1 ;; \
  esac; \
  wget -qO /tmp/rtk.tgz "https://github.com/rtk-ai/rtk/releases/download/${RTK_VERSION}/${asset}"; \
  printf "%s  /tmp/rtk.tgz\n" "${sum}" > /tmp/rtk.sum; sha256sum -c /tmp/rtk.sum; \
  tar -xzf /tmp/rtk.tgz -C /usr/local/bin rtk

# runtime: server (spawns opencode as a child), plugin directory, skills, built UI; no git, no .env (passed by compose).
# opencode itself is not in the image: the server installs and upgrades it in /data/opencode/bin (volume).
FROM oven/bun:1-slim
WORKDIR /app
# WireGuard plugin: wg-quick + root wrapper; uid 1000 may sudo only the wrapper.
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends wireguard-tools iproute2 sudo \
  && rm -rf /var/lib/apt/lists/* \
  && echo '#1000 ALL=(root) NOPASSWD: /usr/local/sbin/sysadm-wg' > /etc/sudoers.d/sysadm-wg \
  && chmod 440 /etc/sudoers.d/sysadm-wg
COPY --chmod=755 plugins/wireguard/sysadm-wg /usr/local/sbin/sysadm-wg
COPY --from=build /src/package.json /src/bun.lock ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/apps/server ./apps/server
COPY --from=build /src/packages ./packages
COPY --from=build /src/plugins ./plugins
COPY --from=build /src/apps/web/dist ./apps/web/dist
COPY --from=build /src/skills ./skills
COPY --from=rtk /usr/local/bin/rtk /usr/local/bin/rtk
ENV SKILLS_DIR=/app/skills WEB_DIST=/app/apps/web/dist OPENCODE_HOME=/data/opencode PLUGIN_PATH=/app/packages/plugin
# Volumes mounted at /data and /infra inherit this ownership; otherwise SQLite and opencode cannot create their files.
RUN mkdir -p /data/opencode /infra && chown -R 1000:1000 /data /infra
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s CMD ["bun", "-e", "fetch('http://127.0.0.1:8080/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["bun", "apps/server/src/index.ts"]

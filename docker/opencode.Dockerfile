# build: bundle the sysadm plugin
FROM oven/bun:1 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile && bun build packages/plugin/src/index.ts --target=bun --outdir=packages/plugin/dist

# runtime: opencode CLI, no ssh client, runs as the node user
FROM node:22-slim
RUN npm install -g @opencode/cli@2.2.0 && npm cache clean --force
COPY --from=build /src/packages/plugin/package.json /opt/sysadm-plugin/package.json
COPY --from=build /src/packages/plugin/dist /opt/sysadm-plugin/dist
COPY docker/opencode.json /etc/opencode/opencode.json
# The state volume is mounted here; pre-creating it makes Docker copy node ownership into the volume.
RUN mkdir -p /home/node/.local/share/opencode && chown -R 1000:1000 /home/node
USER 1000:1000
ENV HOME=/home/node
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]

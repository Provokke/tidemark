# syntax=docker/dockerfile:1.12
# The tidemark image: the CLI and every package a project imports, nothing of the build toolchain.
#
#   docker build -t tidemark .
#   docker run --rm -v "$PWD/my-indexer:/opt/tidemark/project" -e DATABASE_URL=... tidemark start --serve
#
# A project goes in /opt/tidemark/project: its bundle resolves @tidemark/* from /opt/tidemark/node_modules.
# A project with dependencies of its own installs them there (FROM tidemark, COPY, npm ci --omit=dev).

ARG NODE_IMAGE=node:24.11.1-bookworm-slim

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN npm install -g pnpm@12.16.1
WORKDIR /src
# Manifests first, so dependency layers cache across source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages ./packages
COPY contracts/package.json ./contracts/package.json
COPY bench/package.json ./bench/package.json
COPY infra/package.json ./infra/package.json
COPY tsconfig.base.json ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter-prod "@tidemark/cli..."
RUN pnpm --filter-prod "@tidemark/cli..." run build \
 && pnpm --filter @tidemark/cli deploy --prod --legacy /opt/tidemark \
 && chmod +x /opt/tidemark/dist/bin.js

FROM ${NODE_IMAGE}
ENV NODE_ENV=production TIDEMARK_LOG_FORMAT=json HOST=0.0.0.0
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates && rm -rf /var/lib/apt/lists/* \
 && ln -s /opt/tidemark/dist/bin.js /usr/local/bin/tidemark \
 && mkdir -p /opt/tidemark/project && chown node:node /opt/tidemark/project
COPY --from=build /opt/tidemark /opt/tidemark
WORKDIR /opt/tidemark/project
USER node
EXPOSE 42069 9464
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||42069)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "tidemark"]
CMD ["start", "--serve"]

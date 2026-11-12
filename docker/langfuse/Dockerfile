FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS node

FROM registry.access.redhat.com/ubi9/ubi:9.8 AS build-base
RUN dnf -y install --setopt=install_weak_deps=0 libstdc++ openssl-libs tar gzip patch && dnf clean all
COPY --from=node /usr/local/ /usr/local/
ENV NODE_OPTIONS=--use-openssl-ca \
    SSL_CERT_FILE=/etc/pki/tls/certs/ca-bundle.crt
RUN npm install -g turbo@2.11.9 pnpm@12.8.2

FROM build-base AS pruner
WORKDIR /app
ADD --checksum=sha256:8b46b7740df95a14a0cf83b4fd99ff7e4cdf1aebfb2bb9e29f0591907a1e84bb https://codeload.github.com/langfuse/langfuse/tar.gz/311afd44d17755a04ca77174c222debf95c39927 /tmp/langfuse.tar.gz
RUN tar -xzf /tmp/langfuse.tar.gz --strip-components=1 -C /app
COPY playground.patch /tmp/playground.patch
RUN patch -p1 --batch < /tmp/playground.patch && turbo prune web --docker

FROM build-base AS builder
WORKDIR /app
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=pruner /app/out/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=pruner /app/out/json/ ./
RUN pnpm install --frozen-lockfile
ENV pnpm_config_verify_deps_before_run=false \
    DOCKER_BUILD=1 \
    NEXT_MANUAL_SIG_HANDLE=true \
    NEXT_TELEMETRY_DISABLED=1 \
    CI=true \
    RAYON_NUM_THREADS=2
COPY --from=pruner /app/out/full/ ./
RUN sed -i 's/experimental: {/experimental: { cpus: 2,/' ./web/next.config.mjs && \
    rm -f ./web/src/middleware.ts && \
    NEXT_IGNORE_BUILD_ERRORS=true NODE_OPTIONS="${NODE_OPTIONS} --max-old-space-size=6144" turbo run build --filter=web... && \
    pnpm --filter web run typecheck

FROM docker.langfuse.com/langfuse/langfuse-worker:4.70.1 AS worker-runtime
USER 0
WORKDIR /app/worker
COPY --from=builder /app/packages/shared/dist/src/server/media/mediaService.js /tmp/mediaService.js
COPY --from=builder /app/packages/shared/dist/src/server/repositories/dataset-item-media.js /tmp/dataset-item-media.js
RUN node -e 'const fs = require("fs"), path = require("path"); const root = path.dirname(require.resolve("@langfuse/shared/src/server")); for (const [source, target] of [["/tmp/mediaService.js", "media/mediaService.js"], ["/tmp/dataset-item-media.js", "repositories/dataset-item-media.js"]]) { fs.copyFileSync(source, path.join(root, target)); fs.unlinkSync(source); }'
WORKDIR /app
USER 1001

FROM docker.langfuse.com/langfuse/langfuse:4.70.1 AS official

FROM official AS runtime-rootfs
USER 0
RUN rm -rf /app

FROM scratch AS web-runtime
COPY --from=runtime-rootfs / /
WORKDIR /app
COPY --from=builder --chown=1001:1001 /app/web/.next/standalone/ /app/
COPY --from=builder --chown=1001:1001 /app/web/.next/static/ /app/web/.next/static/
COPY --from=builder --chown=1001:1001 /app/web/public/ /app/web/public/
COPY --from=official --chown=1001:1001 /app/web/entrypoint.sh /app/web/entrypoint.sh
COPY --from=official --chown=1001:1001 /app/packages/shared/prisma/ /app/packages/shared/prisma/
COPY --from=official --chown=1001:1001 /app/packages/shared/clickhouse/ /app/packages/shared/clickhouse/
COPY --from=official --chown=1001:1001 /app/packages/shared/scripts/cleanup.sql /app/packages/shared/scripts/cleanup.sql
ENV container=oci \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    BUILD_ID="" \
    NEXT_PUBLIC_LANGFUSE_CLOUD_REGION="" \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    DOCKER_BUILD=0 \
    NEXT_MANUAL_SIG_HANDLE=true \
    PORT=3000
USER 1001
ENTRYPOINT ["dumb-init", "--", "./web/entrypoint.sh"]
CMD if [ -n "$NEXT_PUBLIC_LANGFUSE_CLOUD_REGION" ]; then \
      node --import dd-trace/initialize.mjs ./web/server.js --keepAliveTimeout 110000; \
    else \
      node ./web/server.js --keepAliveTimeout 110000; \
    fi

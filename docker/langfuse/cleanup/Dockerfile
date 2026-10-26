FROM cgr.dev/chainguard/minio AS minio
FROM node:24-alpine
COPY --from=minio /usr/bin/mc /usr/local/bin/mc
WORKDIR /app
COPY main.mjs ./
USER node
CMD ["node", "main.mjs"]

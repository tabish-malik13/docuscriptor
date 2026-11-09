FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/package.json
COPY backend/package.json backend/package.json
RUN npm ci --workspace @docuscripter/services --omit=dev

FROM gotenberg/gotenberg:9@sha256:e1840b4c1ee113078cc153b8359433c9511ab544c1a15cd45b09f81c9329118a
USER root
COPY --from=dependencies /usr/local/bin/node /usr/local/bin/node
COPY --from=dependencies /usr/local/LICENSE /usr/local/share/doc/docuscripter-node/LICENSE
COPY --from=dependencies --chown=gotenberg:gotenberg /app/node_modules /app/node_modules
WORKDIR /app
COPY --chown=gotenberg:gotenberg backend backend
COPY --chown=gotenberg:gotenberg shared shared
COPY THIRD_PARTY_NOTICES.md /app/THIRD_PARTY_NOTICES.md
ENV NODE_ENV=production ORGANIZATION_ROUTING=path PORT=10000
USER gotenberg
EXPOSE 10000
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/node", "--max-old-space-size=96", "backend/render/server.mjs"]

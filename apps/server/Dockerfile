FROM node:24.22.1-bookworm-slim
ENV NODE_ENV=production PAGE_GATHER_PORT=3000
WORKDIR /app
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node apps/server ./apps/server
COPY --chown=node:node packages/plugin-sdk ./packages/plugin-sdk
COPY --chown=node:node plugins/github-trending ./plugins/github-trending
USER node
EXPOSE 3000
CMD ["node", "apps/server/server.js"]

# 从仓库根目录作为 context 构建；根工作区统一管理依赖锁。
FROM node:24-alpine AS build
WORKDIR /build
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/server/package.json ./apps/server/package.json
RUN npm ci --workspace apps/web --include-workspace-root=false
COPY apps/web/index.html apps/web/tsconfig.json apps/web/vite.config.ts apps/web/pwaBuild.mjs apps/web/pwaBuild.d.mts ./apps/web/
COPY apps/web/src ./apps/web/src
COPY apps/web/public ./apps/web/public
ARG VITE_BROWSER_PREVIEW_URL
ENV VITE_BROWSER_PREVIEW_URL=$VITE_BROWSER_PREVIEW_URL
RUN npm run build --workspace apps/web

FROM nginx:1.28-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /build/apps/web/dist /usr/share/nginx/html
EXPOSE 80

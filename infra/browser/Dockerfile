FROM --platform=linux/amd64 node:24.15.0-bookworm-slim

# Chrome 必须由调用方指定完整 deb 版本；仓库不隐式追踪 stable。
ARG CHROME_VERSION
RUN test "$(dpkg --print-architecture)" = amd64 \
    && test -n "$CHROME_VERSION" \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl gnupg tini xvfb openbox x11vnc novnc websockify xauth fonts-noto-cjk \
    && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
       | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main' \
       > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends "google-chrome-stable=$CHROME_VERSION" \
    && test -u /opt/google/chrome/chrome-sandbox \
    && chown root:root /opt/google/chrome/chrome-sandbox \
    && chmod 4755 /opt/google/chrome/chrome-sandbox \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/page-gather
COPY package.json package-lock.json ./
COPY scripts/check-dependencies.js ./scripts/
RUN npm ci --ignore-scripts --omit=dev && npm run check:deps
COPY apps/worker ./apps/worker
RUN mkdir -p /data/profiles/main /data/spool /data/artifacts /run/page-gather \
    && chown -R node:node /data /run/page-gather
ENV DISPLAY=:99 HOME=/home/node PAGE_GATHER_SOCKET=/run/page-gather/control.sock
USER node
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["node", "apps/worker/src/supervisor.js"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "apps/worker/src/cli.js", "health"]

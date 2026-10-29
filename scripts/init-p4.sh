#!/usr/bin/env bash
# Linux/WSL部署目录初始化；只生成一次私有VAPID文件，不输出密钥或外置数据路径。
set -Eeuo pipefail
(( $# == 0 )) || { echo '用法：bash scripts/init-p4.sh（无参数）' >&2; exit 1; }
cd "$(dirname "${BASH_SOURCE[0]}")/.."
bash scripts/init-p2.sh
image=${PAGE_GATHER_KEYGEN_IMAGE:-node:24-bookworm-slim}
docker run --rm --network none --read-only --user 1000:1000 --cap-drop ALL \
  --security-opt no-new-privileges \
  --mount "type=bind,source=$PWD/data/config,target=/data/config" \
  --mount "type=bind,source=$PWD/scripts/generate-vapid.js,target=/opt/generate-vapid.mjs,readonly" \
  --entrypoint node "$image" /opt/generate-vapid.mjs

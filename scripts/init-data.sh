#!/usr/bin/env bash
# Linux/WSL：仅初始化本部署 checkout 的固定 data 子目录，不接受外置数据路径。
set -Eeuo pipefail
if (( $# != 0 )); then
  echo '用法：bash scripts/init-data.sh（无参数，仅使用部署目录 ./data）' >&2
  exit 1
fi
command -v python3 >/dev/null 2>&1 || { echo '初始化需要 Python 3；请在 Linux/WSL 安装后重试。' >&2; exit 1; }
exec python3 "$(dirname "${BASH_SOURCE[0]}")/../infra/init-data.py"

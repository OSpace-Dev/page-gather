#!/usr/bin/env bash
# 必须从Linux原生文件系统的完整部署目录初始化；无外置data参数。
set -Eeuo pipefail
(( $# == 0 )) || { echo '用法：bash scripts/init-p2.sh（无参数）' >&2; exit 1; }
exec python3 "$(dirname "${BASH_SOURCE[0]}")/../infra/init-p2.py"

#!/usr/bin/env bash
# 在 Linux/WSL 仓库根显式运行，仅验收本脚本拥有的开发 Compose 项目。
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
project="page-gather-p1-test-$(date +%s)-$$"
port=${PAGE_GATHER_INTEGRATION_PORT:-16080}
[[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1024 && port <= 65535 && port != 6080 )) || { echo '验收端口须为 1024..65535 且不能使用预览端口 6080'; exit 1; }
: "${CHROME_VERSION:?先从 Google 官方仓库确认并设置完整 Chrome deb 版本}"
[[ "$CHROME_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+-[0-9]+$ ]] || { echo 'Chrome 版本格式错误'; exit 1; }
origin=${PAGE_GATHER_NOVNC_ORIGINS:-http://127.0.0.1:$port}
[[ "$origin" == "http://127.0.0.1:$port" ]] || { echo '验收 Origin 必须与独立端口一致'; exit 1; }
export PAGE_GATHER_PORT=$port PAGE_GATHER_NOVNC_ORIGINS=$origin
# 完整部署副本位于 Linux 临时目录，数据始终在该副本的 ./data。
log_dir=$(mktemp -d "${TMPDIR:-/tmp}/page-gather-p1-verify.XXXXXX")
chmod 700 "$log_dir"
deployment="$log_dir/deployment"
mkdir -m 700 "$deployment"
tar --exclude=.git --exclude=node_modules --exclude=data --exclude=profiles --exclude=spool --exclude=artifacts \
  --exclude=backups --exclude='*.tar' --exclude='*.tar.gz' --exclude='*.tgz' --exclude='*.zip' \
  --exclude=.deployment-source.json \
  --exclude='.env' --exclude='.env.*' --exclude='*.log' --exclude=probe.local.json -cf - . | tar -xf - -C "$deployment"
cd "$deployment"
# 日志可能含构建路径，只写系统临时目录，不复制进仓库。
exec 3>&1
exec > "$log_dir/verification.log" 2>&1
echo '独立 bind 验收已启动；详细日志仅写系统临时目录。' >&3
compose=(docker compose -p "$project" -f "$deployment/compose.yaml")
if [[ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ]]; then
  echo '验收项目已有容器；先确认并清理该项目自身容器，再重试。'; exit 1
fi
cleanup() {
  local result=$?
  trap - EXIT
  "${compose[@]}" logs --no-color > "$log_dir/worker.log" 2>&1 || true
  "${compose[@]}" down --timeout 30 || result=1
  [[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ]] || result=1
  echo "验收退出码=$result；独立临时部署、bind 数据及日志保留在系统临时目录；预览项目不受影响。" >&3
  exit "$result"
}
trap cleanup EXIT
bash scripts/init-data.sh
python3 scripts/test-init-data.py
"${compose[@]}" config --quiet
diagnose_startup() {
  echo '运行同权限沙箱诊断（临时 profile，不修改主档案、不禁用沙箱）'
  "${compose[@]}" run --rm -T --no-deps --entrypoint /usr/bin/tini browser-worker -g -- sh -c '
    node --version; google-chrome --version
    dpkg-query -W google-chrome-stable novnc websockify x11vnc xvfb
    id; stat -c "%U:%G %a" /opt/google/chrome/chrome-sandbox /tmp/.X11-unix
    awk "/^(NoNewPrivs|Seccomp|CapEff):/" /proc/self/status
    sysctl kernel.unprivileged_userns_clone user.max_user_namespaces || true
    unshare -Ur true; echo "unshare user namespace exit=$?"
    Xvfb :99 -screen 0 1440x900x24 -nolisten tcp -ac & display_pid=$!
    sleep 1
    test -S /tmp/.X11-unix/X99; echo "X11 Unix socket check exit=$?"
    timeout 12s google-chrome --user-data-dir=/tmp/p1-sandbox-diagnostic --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --no-first-run --no-default-browser-check --disable-background-networking --disable-component-update --disable-sync --disable-default-apps --disable-extensions --password-store=basic --enable-logging=stderr about:blank
    result=$?
    kill "$display_pid" 2>/dev/null || true
    wait "$display_pid" 2>/dev/null || true
    exit "$result"
  ' < /dev/null > "$log_dir/sandbox-diagnostic.log" 2>&1 || true
  echo '诊断已写入系统临时目录的 sandbox-diagnostic.log；不将启动失败计为沙箱已启用。'
}
"${compose[@]}" build browser-worker
# 运行时镜像不包含完整仓库检查文件；以只读仓库挂载进行离线回归。
# Worker镜像保持无npm运行依赖，阶段脚本仅跑worker回归；全仓P4套件在安装工作区依赖后执行。
docker run --rm --init --network none --name "$project-regression" \
  --label "com.docker.compose.project=$project" \
  --mount "type=bind,source=$PWD,target=/workspace,readonly" --workdir /workspace \
  --entrypoint sh "${project}-browser-worker" -c 'node scripts/derive-chrome-seccomp.js --check && npm run check:deps && npm run test:worker'
"${compose[@]}" up -d --no-build browser-worker
id=$("${compose[@]}" ps -aq browser-worker)
docker inspect "$id" | docker run --rm -i --network none --name "$project-security-inspect" \
  --label "com.docker.compose.project=$project" \
  --mount "type=bind,source=$PWD,target=/workspace,readonly" --workdir /workspace \
  --entrypoint node "${project}-browser-worker" --input-type=module -e '
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const [container] = JSON.parse(readFileSync(0, "utf8"));
const security = container.HostConfig;
assert.equal(security.Privileged, false);
assert.ok(!security.CapAdd?.length);
assert.equal(security.SecurityOpt.length, 1);
assert.ok(security.SecurityOpt[0].startsWith("seccomp={"));
assert.deepEqual(JSON.parse(security.SecurityOpt[0].slice(8)), JSON.parse(readFileSync("infra/browser/seccomp/chrome-userns-amd64.json", "utf8")));
assert.deepEqual(container.Mounts.map(m => [m.Type, m.Destination]).sort(),
  ["artifacts", "profiles", "spool"].map(name => ["bind", `/data/${name}`]).sort());
console.log("运行时安全及三个 bind mount 检查通过");'
bindings=$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$id")
[[ "$bindings" == "{\"6080/tcp\":[{\"HostIp\":\"127.0.0.1\",\"HostPort\":\"$port\"}]}" ]] || { echo '发现非预期发布端口'; exit 1; }
echo '端口配置检查通过：仅发布独立宿主 loopback 端口，无 CDP/VNC/6081 发布；活体连接另行验证。'
wait_for_health() {
  local current_id=$1
  for ((attempt=0; attempt<60; attempt++)); do
    if "${compose[@]}" exec -T browser-worker node apps/worker/src/cli.js health; then return; fi
    if [[ $(docker inspect -f '{{.State.Running}}' "$current_id") != true ]]; then
      echo 'worker 启动失败；保留日志诊断，未关闭沙箱。'
      diagnose_startup
      return 1
    fi
    sleep 1
  done
  echo 'worker health 超时；验收失败。'
  return 1
}
wait_for_health "$id"
run() { "${compose[@]}" exec -T browser-worker node apps/worker/test/container.integration.js "$1"; }
"${compose[@]}" exec -T browser-worker sh -c 'node --version; google-chrome --version; dpkg-query -W google-chrome-stable novnc websockify x11vnc xvfb; uname -m'
docker image inspect "${project}-browser-worker" --format 'worker image ID: {{.Id}}'
run core
run sandbox
run manual
run persist-write
# 让桌面入口处于开启状态，确认 VNC/6081 的真实监听边界。
"${compose[@]}" exec -T browser-worker node apps/worker/src/cli.js manual-start
# 验证容器网卡不能访问仅 loopback 监听的内部服务。
"${compose[@]}" exec -T browser-worker node --input-type=module -e '
import { networkInterfaces } from "node:os";
import { createConnection } from "node:net";
const ip = Object.values(networkInterfaces()).flat().find(x => x.family === "IPv4" && !x.internal).address;
for (const port of [9222, 5900, 6081]) await new Promise((resolve, reject) => {
  const socket = createConnection({host: ip, port});
  socket.setTimeout(1500, () => { socket.destroy(); reject(Error("PRIVATE_PORT_TIMEOUT")); });
  socket.once("connect", () => { socket.destroy(); reject(Error("PRIVATE_PORT_EXPOSED")); });
  socket.once("error", resolve);
}); console.log("CDP/VNC/6081 在容器网卡均拒绝连接");'
# 桌面入口开启时停止，覆盖完整进程树。
# daemon 若与验收 shell 共用 PID 命名空间，再核对每个原进程的 starttime。
declare -A process_starts=()
if [[ -r "/proc/$(docker inspect -f '{{.State.Pid}}' "$id")/cgroup" ]] && \
   [[ $(<"/proc/$(docker inspect -f '{{.State.Pid}}' "$id")/cgroup") == *"$id"* ]]; then
  while read -r pid; do
    if [[ -r "/proc/$pid/stat" ]]; then
      process_starts[$pid]=$(awk '{print $22}' "/proc/$pid/stat")
    fi
  done < <(docker top "$id" -eo pid | awk 'NR>1 {print $1}')
fi
"${compose[@]}" stop --timeout 30 browser-worker
[[ $(docker inspect -f '{{.State.ExitCode}}' "$id") == 0 ]] || { echo '优雅停止非零退出'; exit 1; }
[[ $(docker inspect -f '{{.State.Pid}}' "$id") == 0 ]] || { echo '停止后仍有容器 PID'; exit 1; }
for pid in "${!process_starts[@]}"; do
  if [[ -r "/proc/$pid/stat" ]] && [[ $(awk '{print $22}' "/proc/$pid/stat") == "${process_starts[$pid]}" ]]; then
    echo '停止后发现原容器进程残留'; exit 1
  fi
done
echo "优雅停止：退出码 0、容器 PID 0，检查 ${#process_starts[@]} 个原进程均已消失。"
# 使用同一部署目录的 bind 数据重建，保留合成持久化证据。
"${compose[@]}" up -d --no-build --force-recreate browser-worker
id=$("${compose[@]}" ps -aq browser-worker)
wait_for_health "$id"
run persist-read
run core
"${compose[@]}" stop --timeout 30 browser-worker
id=$("${compose[@]}" ps -aq browser-worker)
[[ $(docker inspect -f '{{.State.ExitCode}}:{{.State.Pid}}' "$id") == 0:0 ]]
echo 'P1 开发容器合成验收通过；真实账号与实际服务器尚待用户验证。'

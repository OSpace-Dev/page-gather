# P1 服务器部署手册

## 1. 责任与适用范围

实际服务器由用户亲自部署。本项目已在开发环境 WSL/Docker 中完成真实 Chrome 的合成集成验收；开发环境通过不能替代服务器核验。开发验证结论见 [P1 验证记录](P1-verification.md)。

本手册部署一个 `browser-worker` 容器，包含真实有界面 Chrome、直接 CDP 执行器、显示环境和受 Origin 限制的 noVNC 人工入口。没有中心服务、SQLite、前端管理页或周期采集；这些属于后续阶段。P1 不要求改动现有域名、HTTPS 或 NGINX 配置。

要求：Linux amd64、Docker Engine、Compose v2、本地持久磁盘、受信任的单用户运行环境，Chrome 沙箱可用。arm64 或不支持沙箱的内核需单独评估，不用模拟或 `--no-sandbox` 绕过。备份卷及浏览器档案应视为登录凭据管理。

文中 `${PROJECT_ROOT}`、`${BACKUP_DIR}` 等由部署者设置为自己的位置，`<服务器地址>`、`<SSH用户>` 等为占位符。`/data/...`、`/run/...`、`/opt/...` 为容器内约定路径，不是宿主机位置。终端切换到仓库根目录后执行命令。

## 2. 获取代码与固定部署版本

```sh
git clone git@github.com:OSpace-Dev/page-gather.git
cd page-gather
git log -1 --oneline
docker version
docker compose version
uname -m
```

确认架构是 x86_64/amd64，记录选择的 Git commit。当前 Compose 给 worker 指定项目级 seccomp profile，基于 Moby 28.3.3 官方默认策略，仅追加带参数限制的 clone/unshare 例外，以支持 Chrome user namespace 沙箱。先审阅 [策略来源与差异](../infra/browser/seccomp/README.md)，目标 Engine/内核升级后重新核验；这扩大了容器内核接口，不等同于完全沿用 Docker 内置默认策略。不得改为 unconfined 或通过关闭 Chrome 沙箱运行。

生产部署不直接用未审阅的最新分支内容；更新前记录旧 commit 与旧镜像 ID。

Chrome 构建要求显式的完整 deb 版本，先从 Google 官方 APT 仓库确认可下载版本。设定：

```sh
export CHROME_VERSION='<可下载的完整Chrome-deb版本>'
bash scripts/init-data.sh
docker compose -p page-gather config --quiet
docker compose -p page-gather build --pull browser-worker
```

可在仓库根 `.env` 保存 `CHROME_VERSION`，它被 Git 忽略；不放账号密码或 Cookie。初始化需要 Python 3，在 Linux/WSL 原生文件系统内执行，当前匹配镜像 node 的 UID/GID 1000:1000 和 0700 数据目录；脚本拒绝不兼容的权限、链接或已有错误目录，不递归改权。不同运行 UID 的部署要先明确适配镜像和初始化逻辑，不用 root 启动 Chrome 或 chmod 777 绕过。Google 可能下架旧版本，不能保证每个历史版本都能重新下载。成功构建后保存镜像供回滚；系统包尚未快照锁定，以实际镜像为准。

## 3. 启动与基本检查

```sh
docker compose -p page-gather up -d browser-worker
docker compose -p page-gather ps
docker compose -p page-gather exec -T browser-worker node apps/worker/src/cli.js health
docker compose -p page-gather exec -T browser-worker node apps/worker/src/cli.js status
```

启动后应为 `PAUSED`、登录状态 `unknown`；这是主动重新检查，不能根据历史状态文件认定有效。health 成功只说明控制进程和 CDP 可连接，不说明某个账号已登录。

如果启动失败，先检查版本、卷权限、共享内存、宿主沙箱兼容性。日志刻意不打印 Chrome 页面和账号信息；不要为排错把所有浏览器调试输出上传公共仓库。不要为了启动成功添加 privileged、SYS_ADMIN 或关闭沙箱。

固定使用 Compose project `page-gather` 管理容器与网络。数据位置由部署目录下 `./data/` 决定，不再依赖 Docker 命名卷的项目前缀；启动必须使用预期部署目录中的 compose 文件。容器默认不自动重启，运行异常需要先检查再启动。

## 4. 本地 fixture 验证

```sh
docker compose -p page-gather exec -T browser-worker node apps/worker/src/cli.js connect
docker compose -p page-gather exec -T browser-worker node apps/worker/src/cli.js navigate
docker compose -p page-gather exec -T browser-worker node apps/worker/src/cli.js read --selector h1
docker compose -p page-gather exec -T browser-worker node apps/worker/src/cli.js screenshot
docker compose -p page-gather exec -T browser-worker node apps/worker/src/cli.js probe --config apps/worker/test/fixtures/probe.example.json
```

fixture 不访问外部网站。`valid` 只证明测试页标记匹配，不证明真实账号登录。截图保存在 artifacts 卷；如需复制到宿主机，使用输出的文件名并将目标存到受保护的部署目录，勿提交截图。

## 5. 人工入口与登录

在服务器执行：

```sh
docker compose -p page-gather exec -T browser-worker node apps/worker/src/cli.js manual-start
```

在个人电脑另开终端保持隧道：

```sh
ssh -N -L 127.0.0.1:6080:127.0.0.1:6080 <SSH用户>@<服务器地址>
```

电脑浏览器访问 `http://127.0.0.1:6080/vnc.html`，操作的是服务器容器中的 Chrome。不要直接公开 6080，不要映射 5900、6081 或 9222；P1 不提供公网登录认证。当前裸 VNC 无密码，仅适用于受信任的单用户宿主、专属 Docker 网络和 SSH 隧道。

Origin 精确白名单默认只允许 `http://127.0.0.1:6080`；`localhost` 或其他端口不等价。若端口被占用，先按 [使用说明](P1-usage.md#3-人工登录与可靠互斥)同时调整明确的入口和 Origin，不能把允许来源改为通配符。防跨站 Origin 校验不是身份认证，不能替代 SSH。

人工模式中页面命令应返回 `MANUAL_ACTIVE`；浏览器关闭或隧道断开不会自动退出人工模式。登录由用户在 Chrome 中手动完成，不复制本地 Chrome 用户目录，也不导入密码/Cookie 给脚本。

在 Chrome 打开 `chrome://sandbox`，确认浏览器实际报告的沙箱状态。仅“没传 no-sandbox”不构成沙箱验收证据，实际结果若异常必须停止排查。

## 6. 结束人工模式与真实站点探测

未配置站点时先结束人工入口：

```sh
docker compose -p page-gather exec -T browser-worker node apps/worker/src/cli.js manual-finish
```

入口关闭、既有连接撤销后回到 `PAUSED/unknown`。再次打开旧 noVNC 窗口不应继续输入；截图或画面缓存不是仍可控制的证据。

真实站点配置使用仓库根 `probe.local.json`，字段与格式参考 `apps/worker/test/fixtures/probe.example.json`。配置自己的 URL、能证明登录的 validSelector、登录页 loginSelector、验证码 challengeSelector；三者都要明确，不能用公共页通用元素证明账号有效。不要写凭据，避免 URL 中的身份 token；配置文件已忽略。

```sh
docker compose -p page-gather cp probe.local.json browser-worker:/run/page-gather/probe.json
docker compose -p page-gather exec -T browser-worker node apps/worker/src/cli.js probe --config /run/page-gather/probe.json
```

如果还在 MANUAL 模式，则使用 `manual-finish --config /run/page-gather/probe.json`，先撤销输入再探测。同源重定向、DOM 规则或 SPA 加载时机仍会影响结果，unknown 不等于登出；探测页面由可信部署者选择，P1 不接受不可信用户 URL。不执行签到或写入动作。

## 7. 部署目录持久化与备份

默认目录结构如下，数据不打入镜像、不进入 Git：

```text
page-gather/
  compose.yaml
  data/
    profiles/       # Chrome 用户目录 main/ 及运行状态
    spool/          # 暂存结果，P1 仅预留
    artifacts/      # 截图等诊断文件
    database/       # 后续中心服务的 SQLite；P1 尚未创建/使用
```

使用 bind mount 将前三个目录分别挂入容器 `/data/profiles`、`/data/spool`、`/data/artifacts`；后者是容器内约定路径。Compose 不自动创建缺失宿主目录，先按初始化步骤创建，避免误用 root 所有的空目录。使用支持 Linux 权限、符号链接和文件锁的本地文件系统；WSL 推荐 Linux 原生文件系统部署目录，不直接把活动 Chrome 档案放在 Windows 挂载盘。

先正常停止 Chrome，再备份整个 data。部署目录内备份只放统一的 `./backups/`，该目录在 Git、Docker 上下文和集成复制中排除；也可放部署目录之外。不要放入其他部署子目录或data内。下例使用部署根内backups，归档名必须不存在：

```sh
set -e
worker_id=$(docker compose -p page-gather ps -aq browser-worker)
test -n "$worker_id"
docker compose -p page-gather stop browser-worker
test "$(docker inspect --format '{{.State.Running}}:{{.State.Pid}}:{{.State.ExitCode}}' "$worker_id")" = 'false:0:0'
BACKUP_DIR="${PWD}/backups"
mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"
test ! -e "${BACKUP_DIR}/page-gather-data.tar.gz"
umask 077
docker run --rm --network none --entrypoint tar \
  --user 0:0 --mount "type=bind,source=${PWD}/data,target=/source,readonly" \
  page-gather-browser-worker -C /source -czf - . \
  > "${BACKUP_DIR}/page-gather-data.tar.gz"
test -s "${BACKUP_DIR}/page-gather-data.tar.gz"
test "$(stat -c %u "${BACKUP_DIR}/page-gather-data.tar.gz")" = "$(id -u)"
test "$(stat -c %a "${BACKUP_DIR}/page-gather-data.tar.gz")" = 600
gzip -t "${BACKUP_DIR}/page-gather-data.tar.gz"
```

`/source` 是辅助容器路径；辅助 root 仅只读源目录，不启动 Chrome，不挂载可写备份目录。归档由宿主普通部署者创建，保留源文件权限、UID/GID与符号链接。默认镜像名为 `page-gather-browser-worker`，以实际 `docker compose images` 为准。备份放在受保护存储并加密；不要提交、公开日志或打印凭据文件内容。备份读取失败或退出状态不是 `false:0:0` 必须停止后续更新并保留原数据；异常停止可能未落盘，不能继续将归档称为一致性备份。若只为保全现场另做归档，应明确标记未确认一致性并人工处理。非空/gzip检查不替代恢复演练。

迁移时停止原服务，将代码/compose 和整个 data 复制到目标部署目录，使用 tar 或保留权限、所有权与符号链接的工具。目标服务先不启动，核对归属与内容、初始化检查通过后再启动；禁止两实例同时访问同一 Chrome 档案。恢复备份时解压到新的空目录并校验，不覆盖正在使用的 data，保留原目录直至确认成功。容器运行 UID/GID 改变或跨主机 Chrome 加密环境变化，可能需要修正权限或重新手动登录，不能保证复制目录就保留所有网站会话。

旧命名卷不会自动删除。已经运行旧版的实例先停止，将旧三个卷完整复制到新空子目录并核对后切换；原卷留作回退，不能直接以空 data 覆盖或自动清理锁文件。WSL 当前预览迁移结果见 [开发验收记录](P1-verification.md)，用户服务器以后再部署。

## 8. 更新、回滚与故障处理

更新前记录 Git commit、镜像 ID、Chrome 版本并备份，停止 worker 后构建并重建，不删除卷：

```sh
docker compose -p page-gather stop browser-worker
docker compose -p page-gather build --pull browser-worker
docker compose -p page-gather up -d --force-recreate browser-worker
```

Chrome 更新可能升级档案格式；回滚旧浏览器不能保证能读取升级后的同一档案。需要回滚时使用保存的旧镜像和升级前档案备份，不让两份 Chrome 同时访问同一卷。手动保存的镜像 tag 应使用自己的版本名，不提交部署账号信息。

- `WORKER_BUSY`：等当前命令完成，再显式重试，不强行接管。
- `WORKER_RESTART_REQUIRED`：清理或输入撤销不能确认，先停止容器检查，再重启；不要手动修改 state 文件解锁。
- `unknown/login_required/challenge_required`：按站点情况人工处理，不能循环重试点击。
- profile 锁冲突：确认没有另一容器共享该档案；不自动删锁。
- 磁盘不足：先停新操作，保留 profiles 和未确认 spool；清理前做备份。

`docker compose down` 不删除 bind mount 的 data 目录；仍不要使用无关卷删除或全局清理命令。真正删除部署目录/data 会丢失登录档案与诊断，删除前必须明确备份。

## 9. 服务器验收清单

- 镜像构建、版本与 digest/ID 已记录；无高层浏览器框架依赖。
- 非 root、有界面 Chrome、真实沙箱状态已确认；项目级 [seccomp 策略](../infra/browser/seccomp/README.md)已审阅，目标 Engine/内核兼容性已验证。
- health、fixture 导航/读取/截图/探测通过。
- 人工模式拒绝自动命令，断开客户端仍保持 MANUAL；结束后旧连接不可输入。
- 只发布宿主 loopback 6080，CDP/VNC/内部 websockify 未发布；防火墙和其他容器信任边界符合要求。
- stop 能在宽限期内结束，无遗留 worker 子进程；原卷重新启动和容器重建后合成/真实会话分别验证。
- 用户完成真实站点手动登录，明确探测规则，重建后检查保持或正确提示重登。
- 已备份并演练恢复；没有把日志、截图、配置或真实路径泄露到仓库。

开发环境结果与用户服务器结果分开记录。通过开发测试可以进入服务器验收，不代表已在用户服务器完成部署。

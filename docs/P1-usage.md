# P1 浏览器执行器使用说明

## 范围与前置条件

这是 Page Gather / 拾页的 **P1 最小实现，尚未通过目标容器和真实站点验收**。只实现单容器、单 Chrome 档案、显式 CLI 和直接 CDP SDK；不含中心服务、插件平台、数据库、调度、上报、通知或签到（P2–P5）。不会启动周期采集，不会默认访问真实网站或执行点击。Chrome 启动页为 `about:blank`，CLI 默认导航为容器内本地 fixture。Chrome 自身可能产生更新/网络基础请求；相关后台功能已尽量关闭，但不是完全离线浏览器承诺。

前提：Linux amd64、Docker Engine 与 Compose v2、本地持久卷、可用的 Chrome 沙箱。arm64 不默认启用模拟器，也不替换成 Chromium。本轮发现 WSL Docker 可用，已用只读挂载、无外网的通用 Node 容器执行回归测试；以下 Chrome worker 构建与部署命令仍为**待执行步骤，不是已成功运行记录**。

## 1. 版本与启动

Node 镜像固定为 `24.15.0-bookworm-slim`，本地测试使用 Node 24.22.1；镜像标签拉取及兼容性尚待构建验证，未固定镜像 digest。Chrome 必须明确指定完整 deb 版本；不内置可能过时的 stable 版本。通过 Google 官方 APT 仓库确认可下载版本后，将下方占位符替换为该版本（含 `-1` 等发行后缀）。不填写会由 Compose 直接报错。Google 仓库可能下架旧版本；不要假装只靠版本参数就能永久重建。Debian 系统包尚未做快照锁定，构建后记录镜像 digest 和软件版本。

```sh
export CHROME_VERSION='<完整Chrome-deb版本>'
docker compose config --quiet
docker compose build --pull browser-worker
docker compose up -d browser-worker
docker compose exec browser-worker node apps/worker/src/cli.js health
docker compose exec browser-worker node apps/worker/src/cli.js status
```

PowerShell 用户使用 `$env:CHROME_VERSION = '<完整Chrome-deb版本>'`。所有路径均以仓库根为工作目录；文中的 `/data/...`、`/run/...`、`/opt/...`、`/home/node` 为**容器内约定路径**，不是宿主真实路径。

- 非 root `node` 用户启动 Xvfb → Openbox → 有界面 Google Chrome，tini 回收子进程。Chrome 不是 headless，也没有默认 `--no-sandbox`。
- 默认使用 Docker 自身 seccomp，未添加 privileged、SYS_ADMIN 或 Docker socket。保留 Chrome 自带 root-owned setuid 沙箱，不设置可能禁用该沙箱的 no-new-privileges。宿主内核/user namespace/LSM 的兼容性必须实测；沙箱失败即启动失败，**禁止为了跑通默认禁用沙箱**。在浏览器 `chrome://sandbox` 中人工确认实际沙箱。
- Chrome 用户目录固定 `/data/profiles/main`，CDP 固定容器 `127.0.0.1:9222`；不发布或代理它。CLI 经权限 0600 的容器内 Unix socket 请求唯一控制进程；不得绕过该控制器在同一浏览器直接并发运行 SDK。
- 512 MiB 共享内存只是起点，无真实站点 CPU/内存跑分，不承诺容量。
- 任一关键子进程异常退出导致整个 worker 停止，不偷偷启动第二份 Chrome。Compose 默认不自动重启，先检查原因。

## 2. 先用本地安全页面验证

```sh
docker compose exec browser-worker node apps/worker/src/cli.js connect
docker compose exec browser-worker node apps/worker/src/cli.js navigate
docker compose exec browser-worker node apps/worker/src/cli.js read --selector h1
docker compose exec browser-worker node apps/worker/src/cli.js screenshot
docker compose exec browser-worker node apps/worker/src/cli.js probe --config apps/worker/test/fixtures/probe.example.json
```

fixture 只在容器 `127.0.0.1:8080` 服务，不发布到宿主；无外部资源、表单或定时任务。示例探测返回的 `valid` **仅表示测试 DOM 标记匹配，绝不表示真实账号有效**。每次页面命令新建 `about:blank` 标签，导航/读取/截图/探测后关闭它，不关闭人工保留的标签；不支持 iframe、弹窗、分页、点击或下载。每个协议命令有超时，导航等待对应 session/loader 的 load，超时不重试；SPA 延迟渲染可能返回 unknown，P1 没有自动条件等待。

截图输出随机文件名，保存于 artifacts 卷，只有明确 `screenshot` 才生成。`read` 的结果可能包含页面敏感文字，不要把 CLI 输出粘贴到公共日志。SDK 为 `apps/worker/src/cdp.js` 的 `Cdp`、`CdpPage`，使用 Node 原生 WebSocket，无第三方浏览器框架或间接依赖。低层 `send`/`evaluateRead` 是可信开发代码接口，不是沙箱或对不可信插件的权限隔离；P1 CLI 不接受任意脚本。

## 3. 人工登录与可靠互斥

```sh
docker compose exec browser-worker node apps/worker/src/cli.js manual-start
```

这时才启动 x11vnc（仅容器 loopback 5900）、websockify/noVNC（仅容器 loopback 6081）与 Node 最小 Origin 网关（6080）。不依赖发行版 websockify 的 ExpectOrigin 插件或参数；6081 不发布，6080 的所有 WebSocket Upgrade 都经网关。浏览器访问宿主 `http://127.0.0.1:6080/vnc.html`，选择连接，操作的是同一 Chrome。远程服务器通过**自行管理的 SSH 隧道/VPN**转发服务器 loopback 6080；不要把 Compose 端口改成 `0.0.0.0`，也不要直接挂到公网 NGINX。

网关使用严格、显式且精确匹配的 Origin 白名单，默认只允许 `http://127.0.0.1:6080`；缺失、`null`、其他来源及重复 Origin 请求均在握手阶段返回 403，不连接后端。`http://localhost:6080` 不等于默认地址。确需其他入口时，在 Compose 的 worker environment 中设置 `PAGE_GATHER_NOVNC_ORIGINS` 为逗号分隔的完整 HTTP(S) origin（协议、主机和端口；无路径、尾斜线或通配符），重建容器后生效；不按 Host 或请求头推导白名单。SSH 本地转发建议保持 `127.0.0.1:6080`，其他端口必须显式列入。错误配置使启动失败。此检查防御浏览器跨站 WebSocket 劫持，**loopback/SSH 本身不能替代 Origin 防护**；Origin 可以被非浏览器客户端伪造，它不是账号认证。

noVNC 没有内置账号认证，原始 VNC 使用 nopw：这是**仅可信单用户宿主 loopback/SSH 隧道**的 P1 默认，不适合共享宿主、共享 Docker 网络或不可信本地用户。6080 在容器网卡监听以支持 Docker loopback 发布，同 Docker 网络的其他容器可能直连；不得将不可信容器接入该网络。Docker 发布 loopback 的隔离效果也需结合目标 Engine/防火墙实际验证。没有中心认证和短期会话代理，不宣称已有公网安全入口。

人工期间所有 CLI 页面命令立即拒绝，不能抢占；正在执行自动操作时进入人工会返回 WORKER_BUSY，等操作完成后显式重试。状态查看与只检查协议连接的 health 不接管页面。关闭网页、断开 noVNC **不会结束 MANUAL**。

无真实站点配置时这样结束：

```sh
docker compose exec browser-worker node apps/worker/src/cli.js manual-finish
```

结束时先关闭 Origin 网关并销毁既有 HTTP/WebSocket 连接，再终止 websockify **整个进程组**、最后终止 VNC，并确认进程组已消失，之后才允许探测；停止失败会锁死为需要重启，不放行自动命令。无探测配置进入 PAUSED/unknown，不会凭 Cookie 文件、档案目录或历史 state 文件认定登录有效。重启也一律 PAUSED/unknown，人工入口默认关闭。状态文件是诊断快照，不是任务锁或登录凭证；互斥由单个控制进程的在途锁、Chrome profile 自身锁及入口进程生命周期落实。可信 Docker 管理员可绕过边界，不在防御范围。

## 4. 用户明确配置真实站点

先确认网站规则和访问授权。将 fixture 配置复制为仓库根 `probe.local.json`（已忽略），自行设置 `url`、`validSelector`、`loginSelector`、`challengeSelector`。必须选择能证明账号会话的稳定 DOM，而不是公共页通用元素；不要写账号、密码、Cookie 或 Token，不配置脚本。JSON 只有 URL 与选择器，不提供泛化登录正确性的保证。三个选择器都必须给出；验证码优先于需要登录，最后才是有效；无匹配/跨源重定向为 unknown，任何异常不会沿用上次有效结论。

```sh
docker compose cp probe.local.json browser-worker:/run/page-gather/probe.json
docker compose exec browser-worker node apps/worker/src/cli.js manual-finish --config /run/page-gather/probe.json
# 后续仅在用户主动需要时，再做一次只读探测：
docker compose exec browser-worker node apps/worker/src/cli.js probe --config /run/page-gather/probe.json
```

本地配置在容器可写层，重建后需要重新复制；它不是凭据。若不在 MANUAL 状态，不执行 manual-finish，直接显式 probe。探测导航本身可能使站点产生访问记录；“只读”指不调用点击/表单/写接口，不能保证网站 GET 请求绝无副作用。有效结果含 checkedAt，只代表上次检查，不代表永久有效。新 URL 必须由用户通过配置或 `--url` 明确提供。URL 不做中心级 SSRF 授权（P2 之外）；只供可信本地管理员，禁止接受来自不可信用户的 URL。Chrome/CDP 不保证防检测、不封号。

## 5. 停止、重建与持久化

```sh
docker compose stop browser-worker
docker compose up -d browser-worker
# 重建验证：stop → build → up -d --force-recreate（不删除卷）
```

SIGTERM 同步封闭请求与 launch 两道门禁，停止监听并销毁既有控制 socket（包括半包），撤销 noVNC 网关，再并行停止所有已登记进程组；8 秒未退出发 SIGKILL，再确认退出。组长 exit 不等于进程组清空：后代仍存活就保留登记，直到确认组消失才移除。在途 manual-start 无法在停机快照后 spawn；等待请求清理完成后再检查一次组注册表。人工退出则严格先关闭网关、再关闭 websockify、最后关闭 VNC。Compose 预留 30 秒。停止时在途只读请求可能失败，不自动重放。`docker compose down` 保留命名卷；**不要使用 `down -v`**，它会删除用户目录与诊断。

| 命名卷 | 容器目录 | P1 用途 |
|---|---|---|
| profiles | /data/profiles | main 完整用户目录、诊断状态快照 |
| spool | /data/spool | 预留持久目录；未实现任何上报/回放协议 |
| artifacts | /data/artifacts | 显式截图；无自动清理 |

首次空命名卷从镜像继承目录权限；已有卷必须由管理员确认归属 node UID/GID（镜像通常为 1000:1000，部署时核实），不可 chmod 777 或以 root 运行 Chrome。不要两容器共享并发操作同一 main 档案。Chrome profile 锁冲突会失败，不自动删除 SingletonLock；确认所有旧 Chrome 已停止后再人工修复。只在 Chrome 完全停止时备份完整 profiles。`--password-store=basic` 避免容器缺少桌面 keyring 导致交互阻塞，但**不提供密钥环级保护**：卷和备份均视为敏感凭据，限制宿主权限并采用磁盘/备份加密。截图同样敏感，不经公网提供。

## 6. 无 Chrome 测试与待验收

```sh
npm ci --ignore-scripts
npm run check
git diff --check
```

零第三方 npm 包，锁文件纳入仓库；禁止依赖检查拒绝任意新直接依赖、间接锁包和额外 package.json，而不是只检查几个框架名字。测试使用协议假对象、本地真实 TCP/HTTP Upgrade 与可注入的进程组信号；POSIX 平台另有真实组长退出后回收后代测试，Windows 明确跳过该项，不需要 Chrome。完整计数和平台差异见验证记录。敏感扫描覆盖常用 JSON 带引号键、YAML、dotenv/export 的引号与裸值，合成测试数据仅运行时拼装；保留所有 Windows 盘符路径检查。它仍是按行启发式检查（如多行 YAML、短值、任意命名或编码秘密不保证发现），仅输出相对文件名和行号。详见 [P1 验证记录](P1-verification.md)。

目标环境验收必须逐项执行：镜像构建/记录版本；health；fixture 导航、读取、PNG；MANUAL 下自动拒绝；断开 noVNC 保持 MANUAL；manual-finish 后旧 WebSocket 无法输入；通过真实 noVNC 验证默认来源可连，缺失/null/恶意/未配置来源握手 403，6081 无法从容器外访问；同卷重建、会话重新探测；原始 VNC/CDP 不可从宿主/外网连接；沙箱实际启用；SIGTERM 后无残留 Chrome；真实站点手动登录及重建后保持/失效判断。以上未通过前不标记 P1 完成，不进入 P2–P5。

## 官方 API 查阅依据

本轮成功读取官方 devtools-protocol 的 browser_protocol.json，核对 Page.navigate/lifecycleEvent 的 loaderId 与 Target.closeTarget 的 success。Node globals 页面可获取但标题匹配检查未确认 WebSocket，Chrome 用户目录变更说明本轮抓取失败；不能将它们记为本轮 API 已核实。原生 WebSocket 的协议单测使用假传输，不替代真实 Chrome 握手。既有官方入口见 [架构依据](02-architecture.md#10-参考资料)。

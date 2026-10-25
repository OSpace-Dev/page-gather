# P1 开发验证记录

## 当前结论

**本轮 WSL / Docker 28.3.3 的真实 Chrome worker 合成集成验收通过，最终脚本退出码 0。** 已验证真实 Chrome/CDP、有效 namespace sandbox、noVNC 所用的 RFB 通路、来源校验、人工互斥与撤销、Cookie/localStorage 同卷重建及正常停止。此前 Docker 默认 seccomp 下的 namespace EPERM 已通过本项目受限 profile 解决。

这不是实际服务器或真实账号验收：没有访问真实账号、人工登录、签到或部署服务器，也未人工在浏览器点击 noVNC UI。目标服务器仍由用户部署并验收；本轮新增安全配置、停机修复、集成脚本与部署手册已通过 Reviewer 完整评审及修复复审。P1 开发交付完成，开发环境验收与完整评审通过。服务器部署与真实账号验收是未来独立事项，不作为当前开发或下一阶段的门槛；本轮未进入 P2–P5。

本阶段只实现单容器、单 Chrome 档案、显式 CLI 和直接 CDP；没有中心服务、数据库、调度或数据上报。

## 实际环境与软件

通过 WSL 内 Docker 执行构建和验收，所有容器、网络及卷限定到独立 Compose project `page-gather-p1-dev`。长任务使用用户级 systemd 临时服务后台运行，日志只保留系统临时目录，不记录宿主真实路径。

| 项目 | 实测结果 |
|---|---|
| WSL / 架构 | Ubuntu-22.04，Linux amd64 / x86_64 |
| 内核 | `6.6.87.2-microsoft-standard-WSL2` |
| Docker Server / Compose | `28.3.3` / `v2.39.1` |
| Node 基础镜像 | `node:24.15.0-bookworm-slim`，真实构建成功 |
| 镜像内 Node | `v24.15.0` |
| 官方 Chrome deb | `google-chrome-stable=156.0.8078.47-1` |
| Chrome / CDP | `Google Chrome 156.0.8078.47` / protocol `1.3` |
| Chrome revision | `1d17a2e2ee147bb7d6ae2ab6abdb3a2510c17775` |
| noVNC | `1:1.3.0-1` |
| websockify | `0.10.0+dfsg1-4+b1` |
| x11vnc | `0.9.16-9` |
| Xvfb | `2:21.1.7-3+deb12u13` |

Chrome 完整版本此前从 Google 官方 `https://dl.google.com/linux/chrome/deb/dists/stable/main/binary-amd64/Packages.gz` 的 google-chrome-stable 条目确认，再通过 Google 签名 APT 仓库精确安装；没有使用 Chromium 或其他浏览器框架。该索引中的 deb 大小为 `144849192` 字节、SHA256 为 `6c92cd22e90c6e3e255d782991543fa2091db8614e8536a971a7433a5c4d7ac8`。后续官方仓库可能下架该版本。

基础镜像本轮实际 digest：

```text
sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d
```

包含本轮 Cookie 停机修复的最终本地 `page-gather-p1-dev-browser-worker` image ID：

```text
sha256:a3ae6e1c96f6280b43b6deda28c72d6b7eaa80f640370528e8375f816e42a939
```

`RepoDigests=[]`，没有推送 registry。基础镜像标签尚未在 Dockerfile 固定 digest，Debian 软件包没有快照锁定，不能宣称永久可重建。

## namespace EPERM 的定位与修复

原始失败证据：非 root UID/GID 1000、CapEff=0、NoNewPrivs=0、Seccomp=2；Chrome helper 为 root-owned 4755，X11 socket 目录为 root-owned 1777。默认 seccomp 下 `unshare -Ur true` 返回 EPERM，Chrome 报 `Failed to move to new namespace` 并退出，宿主相同 userns 检查成功。此前只能定位到容器边界，本轮进一步完成策略对照：

| 本项目临时诊断容器策略 | 结果 |
|---|---|
| Docker builtin 默认 | userns / user+PID+NET unshare 均 EPERM |
| 仅临时 `seccomp=unconfined` | 上述 unshare 均成功；只用来诊断，未写入默认配置 |
| Moby 官方基线 + 只 allow unshare | userns 成功，Chrome 失败 |
| Moby 官方基线 + 只 allow clone | userns 与 Chrome 失败 |
| 基线 + allow clone/unshare | Chrome 启动；无需 setns |
| 最终限制参数的 clone/unshare | Chrome 启动，真实 sandbox 页面通过 |
| 最终 profile 负向检查 | `unshare -Urn true`、`unshare -Urm true` 均 EPERM，`unshare -Ur true` 成功 |

WSL `user.max_user_namespaces=63293`；AppArmor 模块参数为 `N`，两个 userns 限制 sysctl 不存在。该环境对照支持 **Docker 默认 seccomp 是此次 namespace EPERM 的阻碍**；未发现额外 AppArmor 阻碍，不推广为其他宿主的结论。

[安全策略目录](../infra/browser/seccomp/README.md)保留 Moby **v28.3.3** 官方默认 profile 原始字节、许可、SHA256 和完整依据；派生 profile 原样保留基线规则，只追加两条 amd64 例外：

- `clone` 仅放开 USER/PID/NET namespace 标志，其他原 namespace 过滤位保留。
- `unshare` 参数必须精确等于 CLONE_NEWUSER。

未新增 setns/clone3 例外，未添加 capability，未使用 privileged、SYS_ADMIN、`--no-sandbox` 或 `--disable-setuid-sandbox`。Compose 只为本项目 worker 指定该文件，不修改全局 Docker daemon 或宿主 LSM。生成器及验收脚本分别核对基线与派生内容、实际运行中的完整 profile。userns 例外扩大容器进程可访问的内核接口，不能描述为与 Docker 默认策略完全等价；升级 Engine/Chrome/内核后须重新审阅。

真实 CDP 读取 `chrome://sandbox` 的结果：

```text
Layer 1 Sandbox                         Namespace
PID namespaces                          Yes
Network namespaces                      Yes
Seccomp-BPF sandbox                     Yes
Seccomp-BPF sandbox supports TSYNC       Yes
Ptrace Protection with Yama LSM (Broker)  Yes
Ptrace Protection with Yama LSM (Non-broker) No
You are adequately sandboxed.
```

验收要求 Namespace、PID/NET、Seccomp-BPF、TSYNC 与 adequately sandboxed 全部匹配；并非只根据文件权限或 Chrome 能启动判定沙箱。当前无需禁用 setuid helper；禁用一种 helper 不等于禁用所有 sandbox，但任何调整都必须重新读实际状态。

## 真实集成检查与发现的修复

| 检查 | 最终实测结果 |
|---|---|
| Compose config / build | 通过，真实 Google Chrome 镜像构建完成 |
| 镜像内离线回归 | 只读挂载仓库、`--init --network none`；profile 校验、依赖检查及 **50/50 测试通过** |
| Windows `npm run check` | 50 项：49 通过、1 POSIX 项明确跳过、0 失败；依赖与敏感模式扫描通过 |
| 运行时安全 | `Privileged=false`、无 capAdd，实际 seccomp JSON 精确等于项目文件 |
| health / CLI fixture | connect、navigate、read、PNG 签名及 DOM probe 全通过；PNG 为 26975 字节 |
| Chrome sandbox | 上述真实状态通过 |
| MANUAL 互斥 | connect/navigate/read/screenshot/probe 全部拒绝；断开 RFB 客户端仍为 MANUAL |
| noVNC 资源 / RFB | `vnc.html` 返回 200；真实 gateway→websockify→x11vnc 二进制 WebSocket/RFB 3.8 握手通过，画面 1440×900 |
| Origin | 默认来源握手 101；缺失、null、恶意、未配置 localhost、重复来源五类均 403 |
| 真实桌面输入与撤销 | RFB KeyEvent 将 `a` 输入 Chrome 合成输入框；manual-finish 后旧 socket 关闭、网关拒绝新连接，输入值保持 |
| 同卷重建 | 每轮随机合成 localStorage 与有到期时间的 HttpOnly Cookie 均读回；重启为 `PAUSED/unknown` |
| 端口隔离 | 仅发布宿主 `127.0.0.1:6080`；MANUAL 活体期间，容器网卡对 CDP 9222、VNC 5900、websockify 6081 连接均拒绝 |
| 运行中优雅停止 | noVNC 开启时停止，exit=0、PID=0；核对 **20 个**原进程 starttime 均已消失；重建复跑 fixture 后再次正常停止 |
| 最终脚本 / 资源清理 | 退出码 **0**；project 标签下容器、网络均为空，卷保留 |

本轮发现并修复了 **Cookie 未及时落盘**：原停机同时向 Chrome 及其后代发信号，退出码虽为 0、localStorage 虽保留，刚写入的持久 Cookie 在重建后丢失。现在先同步封闭请求和 launch 门禁、撤销入口，并在终止进程组前以有界 CDP `Browser.close` 请求正常退出并等待；失败仍执行全部进程组回收，并以非零退出表明正常关闭失败。新增两项回归验证等待顺序，以及正常关闭失败时仍清理并报错。修复后相同 Cookie 重建检查通过，不能用添加等待或放宽断言掩盖丢失。

另发现上轮失败启动遗留 SingletonLock：确认本项目容器全部停止后，在本项目 profiles 卷中将原 main 合成档案移到 `previous-failed-start` 保留，新建 main 执行验收；没有自动删除锁、删除卷或触碰真实账号。后续正常停止与 force-recreate 未出现锁冲突。worker 不会自动清理未知 profile 锁。

既有 X11 修复保留：Dockerfile 预建 root-owned 1777 的 `/tmp/.X11-unix`，实测 X99 socket 存在。noVNC/Origin/撤销代码在真实通路中通过，本轮未因预期问题而改动这些实现。

## 重复执行入口

在 Linux/WSL 仓库根执行；版本先向 Google 官方仓库确认仍可下载：

```sh
export CHROME_VERSION=156.0.8078.47-1
bash scripts/verify-p1-container.sh
```

[验收脚本](../scripts/verify-p1-container.sh)检测到该 project 已有容器就拒绝覆盖；退出 trap 仅清理该项目容器与网络，保留卷。日志位于 `${TMPDIR:-/tmp}/page-gather-p1-verify.*`，含 verification.log、worker.log，启动失败另有 sandbox-diagnostic.log；日志可能含构建真实路径，不提交、不整段复制进文档。失败或 health 超时返回非零。宿主无需安装 Node；派生策略检查和 Linux 回归在实际 worker 镜像中执行。

[容器集成检查](../apps/worker/test/container.integration.js)使用原生 Node、直接 CDP、TCP/HTTP/WebSocket/RFB，没有第三方 npm 依赖或高层浏览器框架。低层 CDP 用于可信开发验收的合成页面准备，产品命令互斥仍经过唯一控制器。

## 保留资源与验收边界

本轮只管理 `page-gather-p1-dev` 资源，未 prune、未删除卷、未修改其他项目。结束保留：

- `page-gather-p1-dev_profiles`：本轮合成 main 档案及上一轮失败档案归档，没有真实账号。
- `page-gather-p1-dev_spool`：合成 Cookie/localStorage 标记的对照记录，不含凭据。
- `page-gather-p1-dev_artifacts`：fixture 的 PNG 截图。
- 本项目镜像、构建缓存及系统临时日志；没有 commit/push 或 registry 推送。

RFB 自动输入证明了 noVNC 使用的真实通路，不等于已人工浏览器操作 noVNC UI；配置和容器网卡检查也不替代用户服务器的网络/防火墙验收。合成 Cookie/localStorage 只证明指定测试的正常停止后持久化，不保证崩溃断电保持，更不证明真实网站登录仍有效。

真实网站手动登录、真实会话重建后重新探测、站点规则、服务器 AppArmor/userns 兼容性和实际服务器端口隔离仍由用户依[使用说明](P1-usage.md)与[部署手册](P1-deployment.md)验收。Reviewer 已完整评审并确认两项 P2 修复关闭，详见 [P1 开发评审记录](reviews/p1-development-review.md)。本轮修复后镜像已重建并再次通过完整合成验收。

## 当前保留的交互预览

按用户要求，完成自动化验收清理后又使用现有镜像和原三个卷启动了 `page-gather-p1-dev-browser-worker-1`，当前保留运行并进入 MANUAL，health 正常，Windows 侧 noVNC 返回 HTTP 200，尚未认定已完成人工 UI 验收。没有启动周期任务或访问真实账号；后续状态可能由用户操作改变。入口和操作见 [开发环境直观验收](P1-preview.md)。服务器部署验收留待未来，不影响当前 P1 开发完成状态。

## 完整评审后的针对性修复与复验

Reviewer 发现控制 socket 两端按 chunk 独立解码可能损坏中文，以及备份辅助容器生成宿主 root 文件后普通部署者无法 chmod。两端改为 `setEncoding('utf8')` 流式解码，增加请求/响应的中文与 emoji 跨字节真实 TCP 测试；备份改成辅助容器标准输出、宿主 `umask 077` 创建归档。两项经 Reviewer 修复复审关闭，无剩余阻断项。

修复后的实际 worker 镜像再次通过完整容器验收，Linux 50/50、Windows 49/50（1 POSIX 跳过）。WSL 普通用户按部署手册方式备份已停止的合成 profiles，文件归属为当前部署 UID、权限 600，gzip 与 tar 校验通过。恢复到独立临时卷后，302 个条目及 228 个普通文件的内容、路径、类型、符号链接目标、所有权与权限哈希一致。临时恢复卷及归档清理完成；没有输出档案内容，没有真实账号或服务器操作。

敏感扫描仍是按行启发式检查，无法保证发现多行、编码或任意命名的秘密。

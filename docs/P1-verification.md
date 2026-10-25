# P1 开发验证记录

## 当前状态

P1 初始代码已完成，**容器和真实站点验收尚未完成，不标记 P1 整体完成**。本阶段不含中心服务、数据库、周期任务、数据上报、签到或推送。

## 已执行检查

- Windows / Node.js 24.22.1 下 `npm run check` 通过：44 项测试，43 通过、1 跳过（POSIX 负 PID 进程组），0 失败。
- WSL Docker 的现有 `node:24-bookworm-slim`（实测 Node.js 24.21.0）以 `--init --network none`、仓库只读挂载运行 `npm run check:deps && npm test`：44 项全部通过，无跳过。此镜像不是 worker Dockerfile 指定版本，也没有构建 Chrome worker；不把它冒充目标镜像验收。
- 零第三方 npm 包的直接/间接依赖检查通过；未引入 Playwright 或其他高层浏览器自动化框架。
- 原有 31 项测试保留；新增 13 项行为回归，覆盖真实 HTTP Upgrade 默认/自定义来源、缺失/null/恶意/重复来源拒绝、旧隧道与半包撤销、组长 exit 后存活后代、停止失败保留登记、launch 停机拒绝、排队请求拒绝、控制 socket 半包及在途 manual-start 的 persist/readiness 两个暂停点。竞态测试直接使用生产 `quiesce` 门禁/回收函数和真实控制 socket，不是源码文本断言。
- Linux 真实进程组回归使用同组后代通过 IPC 确认已忽略 SIGTERM，再让组长退出；确认组仍登记，随后完成 SIGKILL 与组消失检查。其他进程组单元测试使用可注入信号，覆盖失败分支。
- 凭据合成正反例覆盖 JSON 引号键、YAML、dotenv/export、裸值/标点、占位符与变量引用，并回归所有 Windows 盘符路径；合成值只在运行时拼装，没有写入真实密钥。
- 敏感模式扫描通过；此检查为启发式，不能保证发现所有秘密。原有 PNG 内嵌图形也已单独检查本机路径与密钥标记。
- `node --check apps/worker/src/supervisor.js` 与 `git diff --check` 通过；README 与 docs 中 33 个 Markdown 本地链接（含标题锚点）检查通过，无缺失。

CDP 单元测试仍采用协议假传输。新增网关测试是真实 TCP/HTTP Upgrade 和双向隧道，后端为合成 HTTP 握手服务，不是实际 websockify/noVNC/x11vnc；不能证明真实 Chrome、沙箱或桌面输入可用。Dockerfile/Compose 安全断言仍仅是静态文本检查。网关完全不依赖 websockify ExpectOrigin，因此没有声称已验证某个发行版本的插件参数。

## 未执行及阻碍

Windows 当前 shell 未发现 Docker，但本轮经 WSL 找到可用 Docker 并执行了上述通用 Node 容器回归，修正此前“没有可调用 Docker”的记录。尚未提供/选择完整 Chrome deb 版本，未构建 worker 镜像、校验完整 Compose 运行语义或启动 Chrome。仍未验证 Dockerfile 指定 Node 标签可拉取、指定 Chrome 版本可安装、沙箱、部署端口隔离、用户目录重建、真实桌面旧 WebSocket 输入撤销或整个 worker 的 SIGTERM 无残留；Linux 独立进程组回收通过不替代这些验收。

隐私扫描仍是按行启发式检查，不保证覆盖多行 YAML、短值、任意命名/编码秘密；不会打印匹配内容。本轮保留并扩展主 agent 的所有盘符路径扫描，没有回退此前修改。

用户尚未提供首个具体网站及登录探测规则，未访问或操作真实账号，没有执行签到。真实登录检测与保持必须由用户在目标环境手动登录后验证。

## 目标环境验收

按 [P1 使用说明](P1-usage.md)执行镜像构建、fixture 导航/读取/截图、人工登录和互斥、旧连接撤销、持久化重建、Chrome 沙箱、私有端口与退出测试。记录镜像 digest、Chrome/Node 版本、宿主架构及结果；不记录凭据或真实宿主路径。验收通过后才进入 P2。

## 代码复审

Reviewer 已完成修复复审：原四项问题均可关闭，未发现新增阻断性 P1/P2。显式 Origin 网关、组长退出后继续追踪、停机门禁与在途协调、凭据语法扫描均有行为回归覆盖。Reviewer 独立复跑 Windows 检查为 43 通过、1 POSIX 跳过、0 失败；Linux 通用 Node 容器结果由开发执行记录提供，Reviewer 未独立复跑。

本结论仅为代码修复复审通过，不替代上面的目标 Chrome worker 验收，不标记 P1 整体完成。

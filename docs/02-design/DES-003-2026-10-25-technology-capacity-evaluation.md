# 技术选型与容量评估 v0.2

> 文档编号：DES-003 | 建立日期：2026-10-25 | 最后更新：2026-10-29
> 类型：02-design | 状态：现有文档（功能状态与限制见正文）

本轮评估及其同步修改已由 Reviewer 复审通过，结论与边界见 [技术选型复审记录](../06-reviews/REV-002-2026-10-25-technology-review.md)。无新增必须修订项；Vue 3 + Naive UI 保持推荐状态，等待用户最终选择。

## 1. 结论与确认边界

本轮用户补充确认：中心服务将以容器部署；已有域名、前置 NGINX 与 HTTPS 配套，项目不再引入 Caddy、证书签发或新的公网 TLS 入口。浏览器仍采用容器内真实有界面 Chrome，手动登录、持久化目录、直接 CDP，不引入 Playwright。

推荐前端从尚未实现的 React 方案调整为 **Vue 3 + TypeScript + Vite + Vue Router + Naive UI**，Pinia 只管理会话、偏好等跨页客户端状态。此项是本轮设计建议，不代表用户已指定 Vue 或已完成性能验证。React 同样合适，选择 Vue 是为了统一单文件组件、模板与现成管理组件，不能据此承诺服务器 CPU 明显降低。

SQLite 保持默认。长期容量主要取决于版本新增量、索引、查询和备份窗口，不按总行数设一个虚假的性能上限。后续升级数据库以实测瓶颈为依据。

## 2. SQLite 能存多大

SQLite 官方 limits 文档说明：SQLite 3.45.0 起默认最大页数为 4,294,967,294，默认 4096 字节页对应约 **17.5 TB（16 TiB）**；最大 65536 字节页的理论上限约 **281 TB（256 TiB）**。编译选项、运行时 max_page_count、SQLite 版本和底层文件系统可能降低实际上限。这里不是本项目容量承诺，也不建议为追求理论上限修改默认页大小。

本项目是单中心、低写并发、本地磁盘、索引查询，GB 级长期累积不构成更换 SQLite 的充分理由。百万级甚至更多行是否可用需看行宽、查询计划和硬件；低 CPU 服务器上的无索引全文扫描、深 OFFSET、JSON 大字段排序，会比文件大小更早成为问题。WAL 仍只有一个写入者，内存足够不能消除写竞争。

### 2.1 容量估算

按**每天真正增加的持久记录**估算，不能把每天扫描条数当成每天新增条数。未变化的实体不新增 entity_version；但每次任务的 collection、收据、日志仍有开销。

`年新增体积 ≈ 每天新增版本数 × 平均版本字节数 × 365 × 存储放大系数 + 执行/收据/通知/归档增长`

下表假设每条新版本业务载荷 2 KiB，版本相关元数据、实体重复字段和索引合计放大为 2–4 倍；是规划示例，不是测量结果，未计截图、Chrome 档案、WAL、spool 和备份。

| 每天新增或变化版本 | 一年版本数 | 版本载荷 | 含示例放大后的年度增量 |
|---|---:|---:|---:|
| 100 | 36,500 | 约 71 MiB | 约 0.14–0.28 GiB |
| 1,000 | 365,000 | 约 713 MiB | 约 1.4–2.8 GiB |
| 10,000 | 3,650,000 | 约 6.96 GiB | 约 14–28 GiB |

例如每天扫描 10,000 条，只有 100 条新增或变化，主要版本增长接近第一行；如果所有记录每天都有重要字段变化，则接近第三行。原始 HTML、大段正文和反复归档的 STALE 批次会使估算大幅增大，需要实测平均行宽。

### 2.2 增长治理与不变量

- entity 只存当前视图，entity_version 存重要变化，不把抓取时间、排序、浏览次数等噪声纳入指纹。
- 数据库只存结构化数据，截图/trace 不转 BLOB 长期堆积；STALE archived_payload 是已审查的可靠归档特例，单批有上限、只在过期时存完整载荷，不能对每个正常提交都重复存全量结果。
- **禁止按“日志保留 30 天”删除 collection、submission 幂等身份/收据、档案提交水位和未决签到键。** 原执行详情可裁剪，但须保留不可变的提交身份、hash、处置、顺序和必要外键行，足以重取原收据并防重；版本/事件引用不得被级联误删。
- 业务数据和版本首版不自动删除。STALE 完整载荷经中心确认后可由用户明确清理，保留原收据、hash、归档处置及“载荷已清理”标记；清理不能让该提交再次入库或变为 APPLIED。未确认 spool、未决操作不清理。
- 执行诊断保留 30 天、失败截图/trace 14 天；通知已读内容等未来可配置归档，但先明确事件/收据引用，不通过无约束级联删除节省空间。
- 采用稳定键游标分页，每页默认 50、最大 200。首版搜索针对索引字段或受限时间范围关键词；大范围全文检索需要评估 FTS5、中文分词及索引增长，不使用无限制 `%keyword%` 扫全库。
- 监控主数据库、WAL、归档、spool、Chrome 档案和备份各自大小；checkpoint 不等于收缩主文件。大规模删除后 VACUUM 需要额外空间和维护窗口，不每次清理都执行。

### 2.3 验证目标与迁移触发

P2 最小闭环后，在目标 CPU 和磁盘上建立 10 万、100 万记录及真实宽度的变化历史数据集，再按年增长估算扩到预计三年体积。验证筛选、详情、历史、入库与心跳共存、在线备份和恢复。建议目标：常用分页查询 P95 小于 500 ms、无超时写争用、每日备份与恢复能落入约定维护窗口；这是验收目标，尚无跑分依据。

达到 5 GiB 或 100 万条版本时做一次容量复核，此后随增长定期复核；这不是 SQLite 硬上限。若持续 SQLITE_BUSY 影响心跳、索引优化后主要查询仍不达标、备份恢复超过可接受窗口，或确需多中心实例，再评估 PostgreSQL。主卷建议至少预留数据库当前体积两倍的空闲空间并另计 Chrome/spool 和备份；若计划本地多代备份或 VACUUM，按实际副本数追加，不把“两倍空闲”当成所有维护操作的充分保证。

## 3. 前端框架与组件库

### 3.1 React 与 Vue 3

| 维度 | React + Vite | Vue 3 + Vite | 本项目判断 |
|---|---|---|---|
| 表单/列表/详情 | 成熟组件与类型生态 | 成熟组件、模板、Composition API | 都能实现 |
| PWA / iOS Web Push | 使用浏览器 API / Service Worker | 使用相同标准 API | 无本质优劣 |
| 服务器 CPU | 静态文件，不需 SSR | 静态文件，不需 SSR | 不以框架差异优化服务器 CPU |
| 开发组织 | JSX/TSX 与 Hooks | SFC + script setup + TypeScript | 推荐 Vue 以统一个人项目开发方式 |
| 迁移代价 | 原文档建议，尚无业务代码 | 现在调整无需重写现有实现 | 当前最适合决定 |

不用 Nuxt/Next SSR，不常驻 Vite 开发服务，不在低 CPU 服务器上日常执行依赖安装与构建；在开发机或 CI 构建后发布 dist。依赖版本实施时锁定，记录实际 Node LTS、Vue 与组件库兼容性。

### 3.2 组件库比较与建议

| 候选 | 优点 | 本项目代价 | 决策 |
|---|---|---|---|
| Naive UI | Vue 3/TypeScript，表格、表单、主题与管理组件较完整 | 桌面导向，移动列表与触控仍需自行适配 | **推荐默认**，按需引入一种主库 |
| Element Plus | 管理组件齐全，中文资料多，按需导入方案成熟 | 同样以桌面为主，手机表格不会自动变卡片 | 合理备选，若用户更熟悉可在开工前替换 |
| Vant | Vue 移动端组件与触控模式 | 桌面任务表、配置表单需更多封装 | 暂不叠加，手机复杂交互明显增多再评估 |
| React + Ant Design / shadcn/ui | React 生态可用，分别偏完整管理套件/可定制组件 | 选 Vue 后不混用 React 组件；后者还需组合表格等能力 | React 路线的备选，不并存 |

采用单个 Vue 应用和 Naive UI，并不直接把桌面表格缩成窄屏。任务/数据/通知在手机显示卡片或单列列表，详情为纵向布局；桌面使用服务端分页表格。删除、取消、签到开关等需明确反馈与防误触，触控目标至少 44×44 CSS px，375px 宽无横向页面滚动，正文建议 16px；支持键盘焦点、非颜色状态和减少动画。

首版不需要完整视觉稿，但需用“任务表单、数据分页、通知详情”三个页面验证组件方案，包括 iPhone Safari 日期输入、弹层、安全区、虚拟键盘遮挡、路由深链接与 PWA standalone。Naive UI 的组件完整不等于已验证 iOS 适配。路由懒加载，图表需要时才引入，系统字体优先，不默认加载远程字体。

## 4. 容器与既有 NGINX 边界

### 4.1 默认拓扑

- **现有 NGINX**：继续负责域名、TLS、静态前端和反向代理，属于现有基础设施，不由项目重新部署证书或入口。前端 dist 以版本目录发布给 NGINX；若无法挂载文件，可后续选择独立静态资源容器作为 upstream，但首版不增加第二层 NGINX。
- **server容器**：Node.js；早期推荐Fastify，P2实际用原生HTTP与node:sqlite减少运行依赖。已实现API、任务协调和嵌入式SQLite，调度与推送留后续。单实例。只绑定部署目录 `./data/database`，不包含 Chrome/Xvfb；优雅关闭时停止新调度并提交短事务。
- **browser-worker 容器**：真实有界面 Google Chrome、Node 执行器、直接 CDP 适配层、可信插件、Xvfb/窗口管理器、VNC/noVNC。Chrome 是该容器中的受管理子进程，不是把浏览器界面嵌入服务端进程。分别绑定部署目录 `./data/profiles`、`./data/spool`、`./data/artifacts`，与 `./data/database` 目录隔离；迁移时可连同部署目录整体搬迁，停止服务后保留权限及符号链接。

server 与 worker 内网通信，worker 主动领取并上报，CDP 和原生 VNC 不映射公网。不把 Docker socket 挂进 server 来实现强杀容器；无法确认旧进程停止时按已有 RECOVERING/人工处理，不扩展服务端宿主权限。已有 NGINX 在宿主机时 API 端口只绑定 loopback 或受控私网；NGINX 在容器时接入明确的内部网络，不直接公开 server/worker 管理端口。

### 4.2 代理与发布契约

首版部署在已有域名的根路径、同一 origin。`/api/v1/` 保留原路径代理到 server；Vue Router HTML5 深链接回退 index.html，但 API、静态资源和 `/sw.js` 缺失必须返回真实错误，不能回退 HTML。将来要用子路径部署时统一配置 Vite base、路由 base、manifest start_url/scope 和 Service Worker scope，不能直接移动 dist 就宣称支持。

NGINX 继续处理外部 HTTPS，内部可用受控 HTTP。Fastify 只信任已配置的代理地址/跳数，不盲信任所有 forwarded 头；由 NGINX 覆盖传入的 Host/Forwarded/X-Forwarded-*，应用固定 public origin 并校验写请求 Origin，正确识别外部 HTTPS 并使用 Secure Cookie。项目不负责申请证书，PWA 所需的安全上下文由现有入口提供。

API、认证响应和敏感数据不进入 NGINX 共享缓存或 Service Worker 缓存；首版 Service Worker 仅缓存带版本的公开静态 app shell，离线不提供账号数据。index.html、manifest 和 sw.js 采用可重新验证策略，带内容 hash 资源可长期 immutable。前端与 API schema 发布需兼容：保留上一版静态资源，更新提示后在无未保存表单时刷新，不强制 reload；退出登录清理前端个人状态。

noVNC 如需通过现有 NGINX 访问，使用受认证的管理 location，HTTP 和 WebSocket 握手均校验人工会话、支持 Upgrade/Connection 和合适超时。退出人工模式时必须关闭已有 WebSocket 连接或由浏览器容器撤销输入通道，单纯让后续鉴权失败不能阻止已连接的远程操作者。该细化落实原人工互斥要求，不开放裸 noVNC。

node:sqlite/原生HTTP配置的请求体上限10MiB；若通过既有NGINX接入，也应同步代理上限。413 保留 spool 并显示需调整配置/采集范围，不能无限当网络故障重试。首次部署检查深链接、代理头、Cookie、Service Worker 更新和远程会话撤销。

## 5. Chrome 容器化的明确结论

**当前就是 Chrome 容器化方案**，不是宿主机安装 Chrome，也不是用无头浏览器替换人工登录浏览器。首版不再拆分 browser 与 worker 两个容器，使 Chrome 生命周期、CDP localhost 连接和互斥都在同一个容器边界内。

实施前确认目标 CPU 架构。Google Chrome Linux 常规发行包的架构支持需按官方下载核对，首版按 Linux amd64 验证；若宿主机是 arm64，不默认使用 x86 模拟，不静默换 Chromium，需要重新评估可用 Chrome 发行渠道并与用户确认。容器不能消除内核和架构兼容性问题。

镜像在 CI/开发环境构建，锁定 Chrome 和 Node 版本并定期更新。非 root、沙箱可用、合理共享内存和 init 进程回收、持久卷权限、SIGTERM 优雅退出均需验证。noVNC 无连接时不持续传输桌面图像。资源预算建议先给 worker 共享内存 512 MiB 作为试跑起点，再按真实页面调整；这是配置建议，不是确定内存需求或最低 CPU 承诺。容器 CPU 不设置过低硬限额导致心跳和点击超时，先测待机、采集、人工登录三种场景再定配额。

## 6. 依据与验证边界

- SQLite 限制：https://sqlite.org/limits.html
- SQLite 适用场景：https://sqlite.org/whentouse.html
- Vue 性能与包体策略：https://vuejs.org/guide/best-practices/performance.html
- Naive UI 官方项目：https://github.com/tusen-ai/naive-ui
- Element Plus 官方文档：https://element-plus.org/en-US/guide/quickstart
- Vant 官方文档：https://vant-ui.github.io/vant/
- NGINX WebSocket 代理：https://nginx.org/en/docs/http/websocket.html
- Chrome Linux 要求：https://support.google.com/chrome/a/answer/7100626

SQLite 上限、Vue 性能指南、Naive UI 官方 README 与 NGINX WebSocket 文档已查阅；Element Plus/Vant 文档抓取未成功，本轮仅将其作为候选入口，不据此声称实际组件性能或移动兼容已验证。所有性能数字除官方文件格式上限外都是估算、建议目标或待验证参数；没有运行本项目业务基准测试。

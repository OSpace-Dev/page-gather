# P4 通知、PWA 与采集工作台

Vue 3 + TypeScript + Vue Router + Naive UI 静态前端。依赖与锁文件由根工作区统一安装维护。

```sh
npm run typecheck --workspace apps/web
npm run build --workspace apps/web
# 从仓库根目录构建静态服务
 docker build -f apps/web/Dockerfile -t page-gather-web .
```

默认通过 NGINX 访问，前端只请求同源 `/api/v1`，不需要独立 Node 生产服务。`vite dev` 不配置绕过同源的代理；开发入口应由 NGINX 统一提供。NGINX 上游名为 `server:3000`，代理保留完整路径与浏览器自动发送的 Origin。公开访问地址需要由后端允许的 Origin 配置显式授权。

浏览器预览使用独立入口，不通过本静态服务代理 WebSocket。当前页面在 localhost / loopback 上访问时显示 `http://127.0.0.1:16080/` 链接；其他主机默认隐藏链接。可通过构建参数 `VITE_BROWSER_PREVIEW_URL` 配置受控的 http(s) 预览入口，例如 Docker 构建时传入 `--build-arg VITE_BROWSER_PREVIEW_URL=...`，配置会进入静态文件，不能包含密钥。

## P4 入口与协作模块

契约来源：[DES-007 通知与 PWA](../../docs/02-design/DES-007-2026-10-29-p4-notifications-pwa.md)；具体 DTO 已与 [server README 的 P4 接线字段](../server/README.md) 核对。路由仍由 `src/main.ts` 导出的 `router` 管理；通知 DTO、校验与 `notificationsClient` 导出在 `src/notifications.ts`，同源网络请求仍由 `src/api.ts::api` 统一发送并设置 `cache:no-store`。

- `/notifications`：分页通知中心；`?id=<notification-id>` 打开详情，兼容 `?notificationId=<notification-id>` 与 `/notifications/:id` 入口，登录重定向和 SW 均规范化为 id；别名冲突或数组值明确报错，不当作无详情。默认不传 unread，表示全部；只看未读传 `unread=true`（后端的 false 表示只看已读，不能用于“全部”）。正文始终文本展示。详情成功校验、渲染且前台可见后才 PATCH 已读；失败保留“未读/未确认”并可重试。全部已读需显式确认，成功后重新读取服务端事实，不本地伪造 readAt。
- `/notification-settings`：规则 CRUD / 停用、本机订阅与解除、设备安全元数据、投递摘要、显式推送测试、安装及更新指引。新规则 `pushEnabled=false`；规则编辑只提交六个用户字段，不回写 id/时间。规则变化只影响未来事件；停用或关闭推送也阻止尚未发出的投递。
- `src/AppNavigation.vue`：现有工作台和通知页共用导航及未读 badge。前台最多每 30 秒轻量读取未读数量；hidden 暂停、恢复可见时更新、组件离开时清除 timer，防止重叠请求。不新增 3 秒通知轮询；原运行进度轮询保持原规则。
- `src/push.ts`：只有点击订阅按钮后才调用 `Notification.requestPermission` → `serviceWorker.ready` → `PushManager.subscribe`，使用 `userVisibleOnly:true` 和服务端公钥转换的 `applicationServerKey`。页面读取配置、安装、登录及 SW 注册均不请求权限。拒绝、无能力、非安全上下文和服务端无 VAPID 均有明确提示，站内通知不依赖 push。
- 本机仅在 localStorage 保存 `page-gather.push.device-id`；不保存 token、endpoint 或订阅 keys，不输出它们到日志。浏览器自身的 PushManager 订阅不复制到其他持久存储。本地 id 与 enabled 不代表 session 归属；设备 DTO 必须显式带 owned。删除和测试按钮只允许当前 session owned 的本机设备，执行前重新 GET 校验；数据不完整或 owned=false 明确报错，不发送 DELETE/test。会话过期重新登录后，主动点击重新登记会 POST 浏览器现有订阅的相同 endpoint/keys 续绑，不自动 subscribe。解除执行本机 unsubscribe 和 DELETE；登出先确认归属、尝试 unsubscribe，再给 `/auth/logout` 可选的 owned 本机 `subscriptionId`。归属无法确认时不传 ID，明确警告服务器解绑未确认；只处理本机，不清空其他设备。
- 推送测试仅由按钮触发，需先订阅本机，body 为 `{subscriptionId}` 并附 Idempotency-Key；失败对同一设备复用 key，不广播其他设备。HTTP 202 的有效 test 通知只显示“测试请求 accepted/受理”，不等于推送服务接受，更不等于手机展示或已读。全局与单通知 delivery 中 accepted 指推送服务接受，同样不是终端送达证明。
- 原通知链接只由冻结的 `runId/entityId/versionId` 构造 `/runs?runId=…&entityId=…&versionId=…`，保留原运行上下文，不信任任意 `targetPath`。Workspace 实际读取 versionId，并在应用 currentVersionId 之前选择固定版本；缺失版本、正文 DTO 不完整、run/entity 不匹配均明确报错，不用当前版本替代。正文不使用 HTML/Markdown 解析。

### 已对齐的具体 API DTO

所有路径前缀为 `/api/v1`；不使用宽松字段别名掩盖契约不一致。

| API | 响应 / 请求约定 |
|---|---|
| GET `/notifications` | `{items,nextCursor}`；服务端 item：`id,kind,title,body,taskId,runId,entityId,versionId,targetPath,createdAt,readAt,dedupeKey,matchedRuleIds,delivery`，body 为短摘要而非 README；前端列表仅投影标识、标题、时间与固定目标字段。kind 为 baseline/created/changed/test，readAt 和无目标字段为 null |
| GET/PATCH `/notifications/:id` | `{notification}`；在 item 上增加 `body:string,delivery:{pending,retry,sending,accepted,failed,skipped}`；PATCH 请求 `{read:true}`，确认返回同 id 和非 null readAt 才视为已读 |
| POST `/notifications/read-all` | `{}` → `{count:非负整数}`；严格确认响应后 GET 列表 / 未读计数，不据未知 DTO 乐观修改本地记录 |
| GET `/notifications/unread-count` | `{count:非负整数}`，无效或失败显示未知而不是 0 |
| GET `/notification-rules` | `{items,nextCursor}`；rule：`id,name,enabled,taskIds,eventTypes,keywords,pushEnabled`，服务端时间字段可附加但不回写 |
| POST/PATCH `/notification-rules[/:id]` | 只提交 `name,enabled,taskIds,eventTypes,keywords,pushEnabled`；响应 `{rule}` |
| GET `/push/config` | `{configured:boolean,publicKey:string|null,enabled:boolean,reason:string|null}` |
| GET `/push/subscriptions` | `{items,nextCursor}`；设备只含 `id,deviceLabel,enabled,createdAt,updatedAt,owned` 等安全元数据（owned 必须为 boolean），绝不含 endpoint/keys |
| POST `/push/subscriptions` | `{subscription:{endpoint,keys:{p256dh,auth},expirationTime},deviceLabel}` → `{subscription:{id,deviceLabel,enabled,createdAt,updatedAt,owned}}` |
| GET `/push/status` | `{enabled,healthy,running,lastTickAt,lastErrorCode,nextWakeAt,counts:{pending,retry,sending,accepted,failed,skipped}}`，前端仅投影安全计数与固定错误码 |
| POST `/push/test` | `{subscriptionId}` + Idempotency-Key → HTTP 202 `{notification}`，notification.kind 必须是 test |

### PWA / Service Worker 缓存边界

`public/manifest.webmanifest` 使用稳定根 id、根 scope、`/notifications` start_url、standalone 和真实 192/512 PNG（由 Python 标准库一次性生成，不引入运行时图形依赖）。`src/pwa.ts` 注册根作用域 `/sw.js`，`updateViaCache:none`；NGINX 为 SW 与 API 设置 no-store，API 不进入代理缓存。无外部字体或新增前端依赖。

`pwaBuild.mjs` 是 Vite closeBundle 插件：仅将实际 generateBundle 输出的 hash JS/CSS 与固定公开 index/offline/icons/manifest 列入精确 precache，并对清单、内容及 SW 模板计算版本。SW 安装 `cache.addAll` 一律 `credentials:omit`。缓存名称版本化，只清理本站自己的旧公开 shell 缓存，不读取或清理其他应用缓存内容。

- API/auth 永远走 `cache:no-store` 网络，请求失败不回退 shell，不缓存认证、通知、README 或任何个人数据。
- 不按访问路径扩充缓存；任意导航都是 network-first/no-store，不保存网络导航响应。离线只返回固定公开 `offline.html`（没有私有数据），不会显示任意缓存导航响应。在线应用收到离线事件也卸载个人页面，联网后重新请求；不从 localStorage/IndexedDB 恢复个人内容。
- 所有 push 都尝试 `showNotification`，空载荷、坏 JSON、错误类型仍显示通用回退。锁屏不展示载荷 title/body 或项目正文；使用合法 notificationId 的稳定 tag 合并重复通知。
- 推送载荷使用 `notificationId,targetPath`。点击仅接受同源 `/notifications`、`?id=<合法id>` 或 `/notifications/<合法id>`（规范化为 query），拒绝外站、脚本、双斜线、其他路径与多余参数；focus/navigate/openWindow 不调用 API、不绕过认证，也不标已读。登录后保留校验过的通知目标。
- 安装或激活不自动 skipWaiting/reload。新版本仅提示；用户点击并确认“未保存表单将丢失”后，页面发送同源 window message `{type:'SKIP_WAITING'}`，controllerchange 才刷新。不通过更新自动丢弃未保存表单。设置页有安装/更新状态，不要求用户去 console 判断。

### 开发验证与明确未执行项

纯 Node 测试（Node 24，无浏览器自动化依赖）：

```sh
node --test apps/web/test/*.test.mjs
npm run typecheck --workspace apps/web
```

P4 新增 `notifications.test.mjs`、`push.test.mjs`、`sw.test.mjs`、`pwaBuild.test.mjs`、`pwaUpdate.test.mjs`、`p4Contract.test.mjs`。后端完工后增加实际 DTO/payload 合成对照、owned/session 与续绑、query 别名及固定 run/version 回归。覆盖严格 DTO / 已读失败、规则校验、安全原目标与登录重定向、公钥转换及订阅请求、本机解除/登出范围、纯 VM 的可见推送/坏载荷/安全点击/缓存排除、精确 precache 与 PNG 尺寸、显式更新确认。权限、订阅、网络与 CacheStorage 均为隔离合成 mock，没有自动批准真实权限或向真实推送服务发送请求。

后端完工对照复核后，已在 Node 24.22.1 执行全部 **105 项隔离 Node 测试**及 `fnm exec --using 24 node --run web:build`（含 vue-tsc 与 Vite 生产构建），均通过；实际构建 SW 的 precache 已确认只列公开 shell 和输出 hash 资源。首轮构建的一处 nullable 类型错误已修复并重跑成功。根检查仍由 main 协调。没有运行预览、操作真实账号、申请真实权限、发送真实推送、安装依赖或修改根锁文件；本次只修改 apps/web。Dockerfile 已补 server workspace manifest 和 public / PWA 构建器 COPY。

Reviewer R1/R2 修复补充：`notificationCenterComponent.test.mjs` 经 `sfcHarness.mjs` 编译磁盘上的当前 SFC 脚本，使用真实 Vue 响应式、自定义无 DOM renderer、真实通知 DTO 校验及 mock fetch，覆盖 pending PATCH 时关闭/切换详情后的列表与角标同步、无效 DTO 和卸载守卫，不复制业务函数。`notificationSettingsA11y.test.mjs` 编译当前设置页模板，使用现有 Vue server-renderer、真实 Naive UI 和现有 SSR 样式适配器，断言实际原生 input/textarea、选择输入及 role=switch 与可见 label 的关联，且不允许吞 SSR 组件异常。新增 7 项回归后，Node 24 下全部 105 项测试和 web build（含 typecheck）通过。没有引入新依赖，也未改设备契约、原 run/version 目标或 SW。

**人工待办，未验收：** P3 界面/日程体验、P4 通知分页/已读/规则与 375px 触控体验；实际 iPhone/iPadOS 16.4+ Safari 添加主屏幕、从图标启动、主动授权、锁屏及关闭 PWA 后推送、点击后登录与跳转、设备退订、未保存表单更新确认。iOS Web Push 需要 Home Screen；站内通知一直可在线使用。用户今天无空验收，Node/VM mock 不能称为“iOS 已通过”或真实手机已送达。P5 不在本次范围。

## 原有工作台页面与数据约定

- `/login`：用户名 admin，密码仅存在于表单内存，提交后清空，无默认密码。会话仅依赖同源 HttpOnly cookie。
- `/overview`：服务、Worker 与管理员调度状态、最近完成结果。调度状态读取 `GET /api/v1/scheduler` 的 enabled/healthy/lastTickAt/lastErrorCode/nextWakeAt/stats，进入页面或手动刷新时更新，不增加常驻轮询。请求失败显示不可确认健康，不使用旧健康值兜底。调度时间明确标注 UTC。运行列表按 API 游标遍历后按创建时间降序排列，以兼容服务端升序游标并在刷新后找到最近完成结果。
- `/tasks`：API 预置任务，编辑 name/enabled/config/schedule；保留 config 其他字段，只更新 daily、maxRepos、itemDelayMs、language、spokenLanguage。schedule 只提交 enabled/time/timezone；默认关闭、09:00、Asia/Shanghai。缺少 schedule 的 P2 DTO 兼容为关闭。任务 enabled 和 schedule.enabled 独立，二者都开启才自动运行；保存时明确提示任务停用与日程启用的组合。手动执行不改变日程。HH:mm 与浏览器 Intl 支持的 IANA 时区严格校验，最终由服务端再次校验；时区可搜索选择或自行输入，不新增依赖。卡片显示下一次、上次计划及处理/跳过摘要，计划时间以配置时区展示。首次启用或修改日程只安排未来，不追补启用前历史；恢复最多补最近 24 小时内最新一次，同任务占用则跳过，人工模式排队不抢占。
- `/runs?runId=...`：运行详情、进度、取消及完整榜单。活动运行前台每 3 秒轮询，后台停止，终态停止，出错停止并提供手动重试。列表与详情展示 manual/scheduled 触发方式、scheduledFor 及冻结 taskSnapshot.schedule 的当地时间/时区，不借用当前任务日程。SKIPPED 为终态，不轮询、不视为成功；最近完成结果仍仅取 SUCCEEDED/PARTIAL。
- `/entities?entityId=...`，也可在运行 URL 上附加 `entityId`：实体 README 与所有版本历史，默认选择实体 currentVersionId，不将运行快照插入实体版本列表。

API 使用 API07 的 `{items,nextCursor}`、`{run}`、`{entity,versions,nextCursor}` 包装。尚未提交时，后端 `run.snapshot` 可能为带 taskId/config 的任务快照；提交后应为带 entries 的榜单快照。未知结构显示可重试错误，不将错误 stack 或后端原始 message 暴露给用户。

榜单 entries 使用 key/rank/description/language/stars/dailyChange/status/error。点击项目先打开独立运行快照抽屉，按 `run.result.items[].queueKey` 读取对应正文与来源；STALE 归档项目即使没有实体也能查看。pending/failed 仅显示本次状态，不借用历史正文。快照打开后，以 sourceKey 单页查询实体元数据，查询失败或无实体都不阻断正文；找到时提供独立的实体历史入口。实体列表只依赖元数据，正文由详情接口提供。实体详情使用 sourceKey/sourceUrl/entityType/lastSeenAt/readme，版本使用 id/runId/observedAt/readme。README 始终使用 `v-text` 与 pre-wrap 作为文本展示，不解析 HTML/Markdown。来源链接只接受 http(s)，使用 noopener/noreferrer。

纯函数回归测试：`node --test apps/web/test/*.test.mjs`（运行快照、日程合法/非法输入、P2 DTO 兼容、时区时间展示、调度状态与 SKIPPED 终态；Node 24 原生 TypeScript 类型擦除，无额外依赖）。

手动执行 POST 带浏览器生成的 crypto UUID Idempotency-Key。并发点击受锁保护，失败后再次点击复用同一个 key，成功后才释放 key。Origin 不通过 JavaScript 设置。

375px 下使用卡片替代表格、可折叠菜单与全宽抽屉，正文 16px、主要操作触控区域至少 44px。不引入浏览器自动化测试依赖。

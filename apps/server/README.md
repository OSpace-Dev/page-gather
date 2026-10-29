# P2/P3/P4 中心服务

主体使用 Node 24 内置 HTTP、SQLite、crypto；标准 Web Push 仅由独立 `push-transport.js` 使用锁定的 `web-push` 运行依赖。仓库根运行 `node apps/server/server.js`；测试 `node --test apps/server/test/*.test.js`。Docker 使用仓库根上下文和 `apps/server/Dockerfile`，以 node 用户运行；数据库挂载目录需要对容器 UID 1000 可写。凭据文件由部署者生成并赋予最小读取权限，中心不会自动生成或打印密码。

## 配置

| 环境变量 | 说明 |
| --- | --- |
| PAGE_GATHER_ADMIN_PASSWORD_FILE | 必需，单管理员密码文件 |
| PAGE_GATHER_WORKER_TOKEN_FILE | 必需，独立 worker Bearer 文件；不可与管理员密码相同 |
| PAGE_GATHER_PUBLIC_ORIGIN | 必需，精确 Origin，无末尾斜杠 |
| PAGE_GATHER_COOKIE_SECURE | 默认随 HTTPS 启用；生产必须 true |
| PAGE_GATHER_WORKER_ID | 默认 worker-main |
| PAGE_GATHER_DATABASE_FILE | 默认容器约定路径 /data/database/page-gather.sqlite |
| PAGE_GATHER_HOST / PAGE_GATHER_PORT | 默认 0.0.0.0 / 3000 |
| NODE_ENV | 镜像默认 production，强制 HTTPS；loopback HTTP 开发需显式 development |
| PAGE_GATHER_PUSH_ENABLED | 默认 false；仅 true 时允许外部推送，站内通知不依赖它 |
| PAGE_GATHER_VAPID_FILE | 默认容器约定路径 /data/config/vapid.json，配对的 publicKey/privateKey，0600 |
| PAGE_GATHER_VAPID_SUBJECT | 启用推送时明确配置有效 mailto 或 HTTPS 联系方式 |

部署 `/run/secrets/admin-password` 和 `/run/secrets/worker-token` 是可选容器内约定路径，分别通过两个 FILE 环境变量指定。数据库只挂中心，不挂 worker。文件缺失、空值或生产安全配置不满足时启动失败，日志仅输出固定错误码。会话保存在内存，服务重启后重新登录，机器凭据读取一次。登录每个直接连接 IP 每分钟最多五次失败尝试，不信任代理头；代理部署共享该 IP 限制。

## 接线字段

接口前缀 `/api/v1`；API 路由、请求体按 [协作 API 规范](../../docs/02-design/DES-005-2026-10-25-p2-implementation-contract.md) 实现。管理员写请求必须带配置中的精确 `Origin`，worker Bearer 接口不要求浏览器 Origin。登录使用 `{username:"admin",password}`，会话 Cookie 为 `pg_session`。错误为 `{error:{code,message},requestId}`，message 仅错误码，不含内部异常。

- 列表为 `{items,nextCursor}`；limit 默认 50、最大 200；游标仅用于同一资源。GET entities 支持 q（sourceKey 子串）和 type。
- tasks 的创建/详情/修改为 `{task}`，plugins 列表仍为 `{items,nextCursor}`。任务需显式给 name/pluginId/pluginVersion，其余默认 main/启用/插件默认 config。预置 GitHub 任务启用但没有 run，不自动执行。
- POST tasks/:id/runs 要求 Idempotency-Key，返回 202 `{run}`。允许空请求体或 `{}`；幂等 hash 覆盖 taskId 和请求体，不随以后修改任务改变。取消允许空请求体。
- claim 请求 `{workerId,requestKey}`，requestKey 必需，返回 `{run,lease:{attempt,fencingToken,leaseUntil},action:"execute"|"finalize_only",requestKey,replayed}`，无可领任务 204。中心在同一事务中持久保存 workerId+requestKey 到原 run 及原 lease 的绑定；重试绝不领取另一个 run。租约失效、中心重启、取消或已有采集记录时重试只返回 finalize_only。worker 请求前将 ticket 原子保存到 spool，原 run pending 成功落盘后才清 ticket；重启先处理 ticket，再处理已有 pending。公开 GitHub 不要求站点登录，允许 PAUSED 状态；人工模式（含 MANUAL_REQUESTED）阻断领取。本地 runExternal 锁内 `busy:true/activeRunId:null` 允许领取，已有 activeRunId 仍阻断。run 含 id/taskId/pluginId/pluginVersion/profileId/config/taskSnapshotRef/deadline，以及 status/stage/phase/progress/cancelRequested。时间为 ISO UTC，租约 90 秒，心跳周期 15 秒。deadline 按任务只读预算计算，10 分钟至 1 小时，SDK 仍会收紧到 UTC 午夜。
- collection 返回 `{collectionId,collectionSeq,taskSnapshotRef}`。seal 返回 `{collectionId,collectionSeq,submissionId,payloadHash,lifecycle}`；提交返回 `{receipt}`，disposition 为小写 applied/stale。
- POST worker/runs/:id/recover-finalization 请求 `{workerId,stopped:true}`，无需 collection。原 worker 需持有本地 controller 锁，且最近 status 为 busy=true、activeRunId=该 run、非人工模式；stopped 是旧页面已停止的明确确认。返回 `{action:"finalize_only",run,lease}`，只授权 outcome/heartbeat，禁止登记、seal 或应用新提交。终态直接返回 `{action:"terminal",run,outcome}`；有其他 holder 则 blocked，不释放对方锁。
- recover 返回 `{action:"replay_receipt",receipt,run,lease?,outcome?}`、`{action:"authorize_upload"|"stale",run,lease}`、`{action:"terminal",run,outcome}` 或 `{action:"blocked",reason}`。终态 run 不重新打开，返回已保存的精确 outcome。仅原 worker 可请求；该请求表示原页面已停止。同一档案其他 run 仍占用或 worker 为人工/其他任务忙碌状态时 blocked；worker 持有同一 run 的本地 busy 锁允许恢复。已有收据优先重放；若该 run 尚未终态且无占用冲突，同时续发只允许上传/补报终态的 lease，避免提交响应丢失后永久持锁。SDK 本地 SEALED 而中心仍 OPEN 的情况可恢复，但立即固定原 submissionId/hash，授予的 lease 仅上传，不能登记新采集或续采。
- outcome 返回 `{run}`，status 支持 SUCCEEDED/PARTIAL/FAILED/CANCELLED；成功或部分成功需要收据。summary 可省略；允许简单计数、布尔及长度不超过 80 的字母数字枚举值，拒绝正文、路径和自由文本。errorCode 为大写错误码。取消后仍可封存提交已经采集的数据，outcome 最终保留 CANCELLED。worker 首次发送前持久化不可变 outcomeIntent（status/errorCode/summary），任何响应丢失均重放原意图，不能在恢复时覆写错误。outcome 支持额外 progress 对终态进度校准；heartbeat 从 SDK 本地 OPEN/SEALED 检查点计算 total=冻结队列数、completed=成功与终止失败的唯一项目数，不将 pending 计入；summary.succeeded/failed 单独表达成功和终止失败数。
- GET runs/:id 返回 `{run}`：`run.taskSnapshot` 是不可变任务快照，`run.configSnapshot` 是参数；`run.snapshot` 是最新已提交包的完整榜单（尚未提交为 null），`run.result` 是完整 SDK payload，另含 collections/submissions/receipts/errors/outcome/resultSummary。STALE 完整包也可查询，但不会改实体和水位。
- entities 使用 `entityType:"repository_readme"`，列表只返回 source/sourceKey/sourceUrl/currentVersionId/fingerprint/readmeStatus/firstSeenAt/lastSeenAt 等元数据，不读取或传输 README 正文。详情 `{entity,versions,nextCursor}`，entity 保留顶层 readme；版本含 id/entityId/runId/fingerprint/observedAt/sourceUrl/readme，移除重复 fields.readme。README 为 rendered_text，按文本展示；sourceKind 原样保留 file/rendered_page。版本默认 50，支持 limit/cursor；也提供 GET entities/:id/versions 返回 `{items,nextCursor}`。
- GET workers 的条目含 id/workerId/mode/busy/activeRunId/lastHeartbeatAt，不含 CDP 地址或秘密。POST worker/status 返回 `{worker}`。

## 一致性与本轮边界

SQLite WAL/FULL/FK/busy_timeout=5000。短事务包含档案锁、幂等判定、collection 绑定、实体/版本/事件/完整基线、收据及水位更新；hash 和 SDK payload 验证在事务外。内容不变、PARTIAL 和有效空结果都推进水位。旧包保存完整 archived_payload，不改变实体、基线或版本。当前内容相同时跳过版本，A→B→A 创建三次观察的变化版本。

正常 submissions 不持久化整份 README：payload 列只存带 storageVersion 的榜单/错误等外层元数据，submission_items 表以外键固定关联 version_id，并保存 queueKey/sourceKey/sourceUrl/rank/observedAt/contentHash 等原 item 元数据。正文只在版本 doc.readme 中保存一份；entity 仅存 currentVersionId/readmeStatus，readme 视图在详情查询时构建。getRun 使用固定版本关联还原完整 SDK items，验证原 payload_hash，不从当前版本猜测历史结果，重建后的原字段/hash 不变。STALE 完整包仅存 archived_payload，payload 列为小型归档标记。早期开发库在首次启动按提交逐事务迁移，保留身份/hash/收据，并移除旧 entity/版本 fields 中的正文副本。此迁移不自动执行 VACUUM，已经分配的旧磁盘页不会立即缩小；运行快照、元数据及明确变化的版本仍会正常增长。

启动将活动 RUNNING 置为 RECOVERING，租约失效同样保留档案锁。取消是请求停止，只有 worker outcome 确认后才释放活动锁。OPEN 不自动续采，失败不会自动创建新 run。无 sealed 包且失联的 run 保持 RECOVERING，直到原 worker 在 controller 锁下确认旧页面停止并取得仅终结授权；不根据租约到期猜测浏览器已停止，不提供匿名解锁接口。

附件未接，认证后的 artifacts 接口返回 501 `ARTIFACT_UPLOAD_NOT_IMPLEMENTED`，不会生成截图。P4 通知和推送接口见下文；不实现 P5 签到或新站点。这里的 HTTP/SQLite/SDK 测试不代表实际 GitHub 浏览器采集或服务器部署验收，页面和 worker 的真实闭环由主 agent 集成验证。

## P3 每日调度接口与生命周期

日程语义遵循 [DES-006](../../docs/02-design/DES-006-2026-10-29-p3-daily-scheduling.md)。任务 POST/PATCH 可提供完整 `schedule:{enabled:false,time:"09:00",timezone:"Asia/Shanghai"}`，只接受这三个字段；HH:mm 和运行时支持的 IANA 时区不合法返回 400（`INVALID_SCHEDULE` / `INVALID_TIMEZONE`）。省略时新建与旧任务迁移都关闭日程；任务本身 enabled 与日程 enabled 必须同时为 true 才安排自动执行。

任务列表、详情和写响应增加：

- `schedule`：规范配置；`scheduleRevision`：从 1 开始的修订号。
- `nextScheduledAt`：下一次 UTC ISO 时间，禁用为 null；`lastScheduledFor`：最近处理的计划 slot，尚未处理为 null。
- `scheduleStatus:{state:"DISABLED"|"SCHEDULED",created,skipped,lastReason}`：持久累计摘要。created 仅计实际进入队列的自动 run；skipped 含历史漏跑、占用、过期及修改而作废的队列。lastReason 为最近一次处理的跳过码，正常排队时清空，非错误正文。

仅修改名称/config 保留日程修订与 next，下一次自动 run 快照使用最新参数；修改日程或 task.enabled 则同事务修订并只算修改时刻之后的未来一次。旧 QUEUED 自动 run 转 SKIPPED / `SCHEDULE_CHANGED`，不修改手动 run，不取消 RUNNING，不释放档案锁。schedule 及这些派生字段不是客户端可任意写入的运行状态。

自动 run 保留 `trigger:"scheduled"`、`scheduledFor`（UTC）、`scheduledDate`（当地日期）、`scheduleRevision`，taskSnapshot 另含 schedule 与修订快照；手动 run 仍为 `trigger:"manual"`。SQL 唯一 `(task_id,scheduled_for)` 防重复，自动内部 requestKey 使用手动幂等键无法使用的保留命名空间。tick 创建 run 与推进 next 在同一事务；最近 24 小时内最多补最新一次，多年旧日程只累计摘要，不逐日创建 run。同 task 有 QUEUED/RUNNING/RECOVERING 时不创建 run，仅累计 skipped 摘要、记录 lastReason=`TASK_ACTIVE` 并推进 next；原 run 与档案锁保持不变。`SCHEDULE_DUPLICATE` 和窗口外 `SCHEDULE_EXPIRED` 仅计摘要，不再为同 slot 创建另一条 run。

MANUAL、档案锁或离线阻止实际领取，不阻止排队一个自动 run。claim 前重新校验自动队列：禁用为 `SCHEDULE_DISABLED`，旧修订为 `SCHEDULE_CHANGED`，超过 24 小时为 `SCHEDULE_EXPIRED`；均转 SKIPPED，attempt 保持 0，不访问网页。24 小时边界包含在窗口内。已领取的活动 run 按 P2 ticket/lease/SEALED/finalization 规则处理，不因调度修改擅自终止。自动 claim ticket 的 replay 分支同样核验日程启用、revision 与 24 小时窗口；不再符合时仅返回 finalize_only，保留 RUNNING 状态和档案锁，不能授权重开网页。manual replay 行为不变。worker outcome 不接受 SKIPPED，该状态仅由中心处理未执行的自动队列/slot。

`GET /api/v1/scheduler` 需要管理员 session，直接返回：

```json
{
  "enabled": true,
  "healthy": true,
  "lastTickAt": "2026-06-01T09:00:00.000Z",
  "lastErrorCode": null,
  "nextWakeAt": "2026-06-01T09:01:00.000Z",
  "stats": { "due": 1, "created": 1, "skipped": 0 }
}
```

enabled 表示服务开启调度循环，不表示所有任务启用。lastTickAt 是最近成功 tick；stats 是本进程启动以来成功 tick 的累计值，任务 scheduleStatus 的计数则跨重启持久化。失败后 healthy=false / lastErrorCode=`SCHEDULER_TICK_FAILED`，不返回 SQL、路径或异常原文；下一次成功恢复健康。公开 `/health` 仅增加 `scheduler:{enabled,healthy}`，健康为 200/status=ok，调度失败为 503/status=degraded，不暴露计划/任务/计数。

`Scheduler` 使用最近到期唤醒及最多 60 秒兜底，配置写入后立即重新计算；失败采用 1 秒起、最长 60 秒的指数退避，写配置不绕过退避。原 15 秒 expire 定时器合并到 tick，claim/recover 的即时过期检查保留。`server.close()` 调用即停止调度与推送 timer，并 abort sender；等待 HTTP 关闭及有界 sender 结束后才关闭自有数据库并调用 close callback。外部注入的 Store 仍由调用者在 close callback 之后关闭。可注入 `Store.now`、`Store.tick(now)` 和 `schedulerOptions` 时钟/timer 进行隔离测试，无改时/debug HTTP 端点。

时区计算使用有界 offset 采样、跃迁二分及有界缓存，不逐分钟常驻扫描；DST 重复选早一次，缺失分钟顺延到当天首个有效分钟（纽约 02:30→03:00，Lord Howe 02:15→02:30）。完整缺失的当地日期不生成 slot。

## P4 通知 API 与 DTO（frontend/main 接线）

遵循 [DES-007](../../docs/02-design/DES-007-2026-10-29-p4-notifications-pwa.md)。以下路径均在 `/api/v1` 下，仅管理员 session；写请求继续强制精确 Origin，worker Bearer 不能访问。成功和错误均 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`，错误只含固定安全码。GET 不要求 Origin，不开放 CORS。

### 规则和通知

- GET `/notification-rules` → `{items,nextCursor:null}`。规则为 `{id,name,enabled,taskIds,eventTypes,keywords,pushEnabled,createdAt,updatedAt}`。默认规则 enabled=true、全部任务、baseline/created/changed、keywords=[]、pushEnabled=false。taskIds=[] 表示全部；keywords 多个词按不区分大小写的任一词命中，匹配项目键、描述、受限 README 正文，不匹配时间/星数。
- POST `/notification-rules` 接受 `{name,enabled?,taskIds?,eventTypes?,keywords?,pushEnabled?}` → 201 `{rule}`；PATCH `/notification-rules/:id` 接受这些可写字段的子集 → `{rule}`；DELETE → `{ok:true}`。拒绝其他字段。名字最长200，数组最多100项、每项最长200；eventTypes 只接收 baseline/created/changed。删空规则后重启不重建默认规则。
- GET `/notifications?limit=&cursor=&unread=` → `{items,nextCursor}`，按创建序号倒序，limit 默认50最大200。unread 可省略、true 或 false，游标绑定该过滤。条目为 `{id,kind,title,body,taskId,runId,entityId,versionId,targetPath,createdAt,readAt,dedupeKey,matchedRuleIds,delivery}`，无 README 或订阅密钥。`delivery:{pending,retry,sending,accepted,failed,skipped}` 为设备计数。
- GET `/notifications/:id` → `{notification}`（同上小型 DTO）；GET `/notifications/unread-count` → `{count}`。PATCH `/notifications/:id` 只接受 `{read:true}` → `{notification}`，重复不改原 readAt；POST `/notifications/read-all` 接受空体或 `{}` → `{count}`（本次修改数）。不存在返回404 `NOTIFICATION_NOT_FOUND`。
- 业务目标固定为 `/runs?runId=:runId&entityId=:entityId&versionId=:versionId`；baseline 仅含 runId。打开原 run 的固定 submission/version，不使用 entity 最新版替换。测试通知目标 `/notifications`。通知 ID、run/version ID 全部由中心生成，不能提交任意外部路径。kind 为 baseline/created/changed/test，test 永不伪装业务事件。

### 设备和测试

- GET `/push/config` → `{configured,publicKey,enabled,reason}`，只返回公钥、安全配置码；不暴露私钥、subject 或密钥文件路径。
- POST `/push/subscriptions` 接受 `{subscription:{endpoint,keys:{p256dh,auth},expirationTime?},deviceLabel?}` → 201 `{subscription:{id,deviceLabel,enabled,createdAt,updatedAt,owned}}`；GET → `{items,nextCursor:null}`，同样仅含元数据。deviceLabel 最长100，无控制字符。允许标准 HTTPS/443、无凭据/fragment 的明确 FCM/Mozilla/Apple 推送服务端点，验证 P-256 公钥点和16字节 auth，过期订阅不能新增投递；发送时 transport 再校验 DNS 与公开地址。
- 设备归属当前登录 session（库内仅保存 session 摘要，不保存 Cookie）；列表含 owned，其他会话不能删除或发送测试。相同 endpoint 携带相同原 keys 可在重新登录后续绑新 session；仅拿 endpoint 而换 keys 返回409 `SUBSCRIPTION_CONFLICT`。新设备不会接收旧通知。
- DELETE `/push/subscriptions/:id` → `{ok:true}`，仅 owned；清除 secret、停用设备、跳过尚未完成投递。同归属重复删除幂等。其他设备不变。
- POST `/auth/logout` 可无体/`{}`，或 `{subscriptionId}`。提供 ID 时先校验本会话归属并解绑，再销毁 session；归属错误403且不会误删他机。不提供 ID 保持旧客户端兼容。浏览器自己的 unsubscribe 仍由 frontend 尝试，服务端不声称其一定成功。
- POST `/push/test` **必须** `{subscriptionId}` 与 `Idempotency-Key` → 202 `{notification}`，仅计划选定的一个 owned 设备。相同 key+device 重放原通知，相同 key 换设备409 `IDEMPOTENCY_CONFLICT`；无 Idempotency-Key、缺字段或夹带 kind/title/业务事件字段均拒绝。禁用/未配置分别409 `PUSH_DISABLED`/`PUSH_NOT_CONFIGURED`；设备不存在404、非本会话403、停用409 `PUSH_NO_DEVICES`。不会默认广播到其他设备。
- GET `/push/status` → `{enabled,healthy,running,lastTickAt,lastErrorCode,nextWakeAt,counts}`；counts 为上面的六类计数。enabled 表示全局已启用且配置完整，healthy 是循环本地健康，不表示外部服务或手机可达。网络错误仅固定诊断码，不让公开 `/health` 或站内 API 因 push 断网而失败。

## P4 事务、Outbox 与关闭边界

`notify-store.js` 独立维护 notification_rules、notifications、notification_outbox、push_subscriptions、push_deliveries、push_test_requests；notification_migrations 保存独立 P4 迁移标记，不改写 P2/P3 收据或回放历史 events，也不重置 P3 user_version。通知、规则匹配快照、设备计划与 submit 的版本/events/baseline/receipt/档案水位共用同一事务，任一步失败全回滚。首次 partial 无通知；首次 complete 只一条摘要；已有 baseline 后才提醒本次真正新建的版本。相同内容、rank/stars/observedAt 变化不发，A→B→A 保留新的回退版本。原收据优先重放，STALE 无业务通知。跨 task 使用首来源策略，version 事件归属固定为 versions.run_id 对应任务：onlyB 规则不会补发 A 先写、B 后提交同版本的 delta；B 自己首次完整基线仍可有独立 summary。baseline 的 task/scope 去重与 version ID 去重分开，首次 partial 不创建已通知标记。多规则同一版本只一条站内消息，保留命中 ID；站内记录不复制正文。

每条通知都有 Outbox 记录，但只在事件时 global enabled+configured、已命中的 rule pushEnabled、设备当时存在有效才生成唯一 `(notificationId,subscriptionId)` 投递。以后启用 push/规则或注册设备均不补发历史。全局关闭或配置失效时，配置应用及重启会持久 skip 所有旧 pending/retry/sending；disabled 后台不会留旧计划待 reenable 重发。测试分支只需全局启用/已配置与选定有效设备，不依赖业务规则。发送前仅复核原来 push 授权的 rule IDs 是否仍至少一条 enabled+pushEnabled，不重算关键词/task/eventTypes 等新过滤。禁用/删除规则或注销设备会永久 skip 不再授权的 pending/retry/lease，重新启用不会复活这些记录。已交给网络的发送无法撤回，不能承诺注销会撤销已经接受的请求。

`dispatcher.js` 单实例串行，每轮最多一条；短事务取得持久 lease 和 attempt，网络期间无 SQLite 事务。默认15秒网络上限、30秒 lease、空闲最多60秒兜底，入库/配置变化唤醒；本地循环异常有界退避。重启尊重未到期 lease，到期重领并累计 attempt。2xx 只标 accepted（推送服务接受），不改 readAt、不称手机展示成功。404/410 只清理该设备 secret；429/5xx/网络超时最多五次，指数退避并尊重最多一小时的 Retry-After；401/403/413 等永久失败保存固定诊断、不删正常设备、不无限重试。第五次 lease 若崩溃，到期直接 failed。成功已被外部接受但落库前崩溃可重复发送，稳定 notificationId、topic/tag 仅协助合并，语义为至少一次而非端到端 exactly-once。

锁屏 payload 只有 `{notificationId,kind,title,body,targetPath,tag}`：通用标题/摘要与 `/notifications?id=:id` 安全路径，不带项目名、README、endpoint 或 keys。transport 使用稳定 notificationId 产生 topic。站内详情再取得业务目标，登录与跳转由 frontend 处理。

`configuration(env)` 调用独立适配的 `loadPushConfiguration(env)`，`createServer` 使用 `createPushTransport(config)`；也支持注入 `pushConfig`、`pushTransport` 和 `dispatcherOptions` 供隔离测试。transport 接口为 async `send({subscription,payload,notificationId,signal})` → `{statusCode,headers}` 或抛固定 code/statusCode/headers；兼容已消毒 `safeRetryAfter` 秒。stop 立即停止 timer、abort sender，sender 即便不响应 signal 也由有界 race 收尾；不在停止后回写 DB，持久 lease 留待重启。close callback 在 sender 与 HTTP 关闭后才执行，自有 DB 此时才关闭；注入 DB 仍属调用者管理。

### 本地测试与尚未验收

`node --test apps/server/test/*.test.js`；P4 主要是 `test/notifications.test.js`（真实 HTTP、内存/临时文件 SQLite、合成设备和注入传输），另由适配 agent 的 `test/push-transport.test.js` 验证标准加密/配置/网络边界。通知测试覆盖 partial/baseline、多规则/过滤、跨任务、receipt/stale、A→B→A、升级不回放、事务回滚、分页/read、归属/metadata、logout、单设备 test 幂等、事件时设备计划、规则撤权、串行、重试/lease/restart、超时/关闭、禁用推送与安全 API headers。

这些测试不会向外部推送端点发送，不操作已有预览或 userdata，不代表真实 GitHub、iPhone 安装/锁屏/点击已验证；真机、浏览器授权和用户 P3/P4 手工验收仍待用户执行。P5 暂停。

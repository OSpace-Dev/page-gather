# P2/P3 中心服务

仅 Node 24 内置 HTTP、SQLite、crypto，无 npm 运行依赖。仓库根运行 `node apps/server/server.js`；测试 `node --test apps/server/test/*.test.js`。Docker 使用仓库根上下文和 `apps/server/Dockerfile`，以 node 用户运行；数据库挂载目录需要对容器 UID 1000 可写。凭据文件由部署者生成并赋予最小读取权限，中心不会自动生成或打印密码。

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

附件未接，认证后的 artifacts 接口返回 501 `ARTIFACT_UPLOAD_NOT_IMPLEMENTED`，不会生成截图。不实现推送、签到或新站点。这里的 HTTP/SQLite/SDK 测试不代表实际 GitHub 浏览器采集或服务器部署验收，页面和 worker 的真实闭环由主 agent 集成验证。

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

`Scheduler` 使用最近到期唤醒及最多 60 秒兜底，配置写入后立即重新计算；失败采用 1 秒起、最长 60 秒的指数退避，写配置不绕过退避。原 15 秒 expire 定时器合并到 tick，claim/recover 的即时过期检查保留。`server.close()` 调用即停止 timer，close 事件才关闭自有数据库；外部注入的 Store 仍由调用者在 server 关闭后关闭。可注入 `Store.now`、`Store.tick(now)` 和 `schedulerOptions` 时钟/timer 进行隔离测试，无改时/debug HTTP 端点。

时区计算使用有界 offset 采样、跃迁二分及有界缓存，不逐分钟常驻扫描；DST 重复选早一次，缺失分钟顺延到当天首个有效分钟（纽约 02:30→03:00，Lord Howe 02:15→02:30）。完整缺失的当地日期不生成 slot。

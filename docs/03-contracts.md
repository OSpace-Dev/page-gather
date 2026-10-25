# 插件、数据与接口设计 v0.1

本文件定义概念契约，不是已实现 API 或最终数据库迁移。字段与状态是开发基线，实现时可细化但应保持这里的幂等、互斥和恢复语义。

## 1. 插件结构

建议目录：`plugins/<plugin-id>/manifest.json`、`index.ts`、`schemas/`、`fixtures/`。插件在部署时安装，中心读取注册信息；执行器报告实际已安装版本，版本不匹配不得领取。

manifest 至少包含 id、version、engineApiVersion、名称、允许域名、参数 JSON Schema、输出 Schema、登录要求、能力（collect/query/checkin）和默认超时。任务固定插件版本，执行时保存参数快照；升级采用禁用旧任务、试跑新版本、再切换的流程，不能修改正在执行的代码。

示意契约：

```ts
interface SitePlugin {
  manifest: PluginManifest;
  checkSession(ctx: PluginContext): Promise<SessionCheck>;
  collect(ctx: PluginContext): Promise<CollectionResult>;
  queryAction?(ctx: PluginContext, action: ActionRequest): Promise<ActionCheck>;
  performAction?(ctx: PluginContext, action: ActionRequest): Promise<ActionResult>;
}

interface PluginContext {
  page: CdpPage;
  config: Readonly<Record<string, unknown>>;
  runId: string;
  deadline: string;
  signal: AbortSignal;
  log: StructuredLogger;
  artifacts: ArtifactWriter;
}

interface CollectionResult {
  scopeKey: string;
  completeness: 'complete' | 'partial';
  items: CollectedItem[];
  warnings: string[];
}

interface CollectedItem {
  entityType: string;
  sourceKey: string;
  sourceUrl: string;
  observedAt: string;
  fields: Record<string, unknown>;
  fingerprintFields: string[];
}
```

省略类型由 SDK 提供；这是接口草案，尚非可编译代码。`CdpPage` 是本项目基于直接 CDP 实现的轻量页面接口，不引用任何 Playwright 类型。其首版方法包括 navigate、waitForCondition、readText、click、captureScreenshot，统一接收超时与取消信号；低层命令由 CDP 适配层统一管理。click 需先验证元素存在、可见与可交互，计算目标位置并通过 Input 发送事件；不能因为命令已发送就认定业务操作成功。`SessionCheck` 至少区分 valid、login_required、challenge_required、unknown；无法判断不得默认有效。`ActionCheck` 至少区分 done、not_done、unknown，并携带站点业务日期与证据摘要。

平台创建和销毁页面、注入超时、收集附件、规范化字段、计算 hash、安排重试。插件不直接写数据库、不发推送、不管理无限重试，也不自行发送最终业务数据。所有浏览器步骤遵守 deadline 与取消信号。

定位优先使用稳定 DOM 属性和语义，避免固定屏幕坐标和长时间 sleep。CDP 适配层显式处理导航事件竞态、iframe 的执行上下文和独立 target、新标签页、节点失效及输入坐标换算；可配置的条件等待必须有截止时间，不依赖框架自动等待。页面有稳定且已授权可用的数据响应时，可读取当前浏览器会话中的响应；是否使用站点接口由插件实际验证，不假设可以脱离浏览器独立调用。

插件本身随部署安装。禁用插件后，停止生成或领取依赖它的新执行；已运行任务默认完成，需要立即停止时单独取消。卸载前先禁用，确认无活动执行、将引用任务归档或迁移，再删除对应版本文件。历史执行保留插件 ID、版本和配置快照，不级联删除业务数据；恢复历史执行必须重新安装相同版本。

## 2. 签到操作协议

操作键：`(profile_id, plugin_id, action_name, target_business_date)`，其中业务日期按目标网站规则计算。更换插件版本不能生成新的当天签到键。

1. 只读 `queryAction`，已签到则写 VERIFIED_DONE 并跳过。
2. 中心事务创建 PREPARED 操作，唯一键冲突则读取原操作并核验。
3. 在点击前写 DISPATCHING；执行器携带有效租约调用 `performAction`。
4. 插件只读核验，写 VERIFIED_DONE 或 VERIFIED_NOT_DONE。
5. 崩溃、取消或点击后超时，保留 DISPATCHING/UNKNOWN；恢复时只能先核验。
6. 未能证明成功或失败，进入人工处理。确认未执行且插件声明允许时，显式记录新一次尝试。

操作日志只能提供重复保护与审计，跨目标网站不能实现事务性的 exactly-once。界面区分采集结果与签到结果：采集成功、签到待核验时可保存数据，但整次执行为 PARTIAL/等待人工处理，不能简单显示全成功。

## 3. 概念数据模型

全部时间戳存 UTC；调度时区、站点业务日期额外保存。默认 SQLite：UUID 使用 TEXT，时间使用统一格式的 UTC ISO 8601 TEXT，业务日期为 `YYYY-MM-DD` TEXT；布尔使用 INTEGER 0/1 并加 CHECK，JSON 使用 TEXT 并由应用 Schema 校验，可用时增加 `json_valid` 检查。主键、NOT NULL、外键、唯一约束及索引通过迁移明确声明，每个连接启用外键检查。SQLite 不依赖原生 UUID、JSONB、枚举或行级锁特性；将来迁移 PostgreSQL 需要显式类型转换与数据验证。

可重试请求采用数据库唯一约束，不依赖前端防重。自动计划唯一索引仅覆盖自动执行，手动 request_key 使用非空唯一索引；不能依赖含 NULL 的联合唯一键来保护自动计划。所有数据库访问经中心服务，执行器不直接打开 SQLite 文件。

| 表 | 主要字段 | 约束与关系 |
|---|---|---|
| admin_user | id、login、password_hash | 首版单管理员 |
| browser_profile | id、name、volume_ref、mode、session_status、last_checked_at、committed_collection_seq | volume_ref 不接受任意客户端文件路径；提交水位初始为 0，仅入库事务可推进 |
| plugin_installation | plugin_id、version、manifest、enabled | 联合主键 plugin_id + version |
| task | id、plugin_id、plugin_version、profile_id、config、local_time、timezone、enabled、next_run_at | 引用插件和档案 |
| task_baseline | task_id、scope_key、established_at、last_complete_run_id | 唯一 task_id + scope_key |
| task_run | id、task_id、trigger、scheduled_for、request_key、status、phase、config_snapshot、plugin_version、attempt、lease_owner、lease_until、fencing_token | 自动任务唯一 task_id + scheduled_for；手动请求键唯一 |
| run_attempt | id、run_id、attempt、started_at、ended_at、error_code、summary | 唯一 run_id + attempt，保留每次失败证据 |
| collection | collection_seq、id、run_id、attempt、profile_id、config_snapshot_ref、registration_key、created_at | collection_seq 为 INTEGER PRIMARY KEY AUTOINCREMENT，id 唯一；run_id + registration_key 唯一；采集前由中心分配，绑定不可变 |
| run_submission | id、run_id、collection_id、submission_id、payload_hash、disposition、receipt、archived_payload | submission_id 唯一、collection_id 唯一；同键不同 hash 拒绝；APPLIED 或 STALE 收据不可变，STALE 保存完整业务载荷 |
| entity | id、source、profile_id、entity_type、source_key、current_version_id、first_seen_at、last_seen_at | 唯一 source + profile_id + entity_type + source_key |
| entity_version | id、entity_id、fingerprint、fields、observed_at、run_id | 相同内容不重复插入；变化 A→B→A 仍保留回退版本 |
| change_event | id、entity_version_id、kind、changed_fields | 对应版本事件唯一 |
| action_execution | id、profile_id、plugin_id、action_name、business_date、state、evidence、run_id | 操作键唯一，尝试记录另外保留 |
| notification_rule | id、enabled、sources、keywords、event_types | 首版个人规则 |
| notification | id、event_id、kind、summary、target、read_at、dedupe_key | dedupe_key 唯一；可指向数据或任务异常 |
| outbox | id、notification_id、state、next_attempt_at | 同一通知创建一次；数据库事务内写入 |
| push_subscription | id、user_id、endpoint、p256dh、auth、device_label、enabled | endpoint 唯一，密钥受保护 |
| push_delivery | id、notification_id、subscription_id、state、attempt、last_http_status | 唯一 notification_id + subscription_id |
| artifact | id、run_id、kind、storage_key、expires_at | 下载需认证，路径由服务端生成 |

entity_version 不对全部历史的 `(entity_id, fingerprint)` 设置唯一：当前版本相同才跳过，否则 A→B→A 的业务变化会丢失。事件基于新版本 ID 幂等去重。

模型关系图见 [数据关系图](diagrams/data-model.drawio)，图仅呈现核心关系，字段及唯一约束以本节为准。

## 4. 执行状态与错误分类

执行状态：QUEUED → RUNNING → SUCCEEDED / PARTIAL / RETRY_WAIT / WAITING_USER / FAILED / CANCELLED；租约异常先进入 RECOVERING，再按证据决定重试或人工处理。RETRY_WAIT 到期回 QUEUED；WAITING_USER 经检查可回 QUEUED，已保存的操作状态必须延续。

执行阶段：SESSION_CHECK、ACTION_CHECK、ACTION、COLLECT、UPLOAD、COMMIT。状态反映整体结论，phase 用于定位进展。

| 错误 | 默认处理 |
|---|---|
| LOGIN_REQUIRED / CHALLENGE_REQUIRED | 暂停档案，等待用户 |
| SELECTOR_CHANGED / SCHEMA_INVALID | 停止自动重试，修复插件；错误原始结果保留诊断 |
| NETWORK_TRANSIENT / READ_TIMEOUT | 只读阶段最多两次重试，建议 1/5 分钟退避 |
| ACTION_UNCERTAIN | 只读核验，无法确认则人工处理 |
| INGEST_UNAVAILABLE | 暂存结果，建议 1/5/15 分钟重传后按 1 小时间隔持续重试并显示积压 |
| WORKER_LOST | 先确认旧执行停止，再恢复；含副作用先核验 |
| DISK_FULL | 停止新任务并告警，不清除未确认结果 |

## 5. API 草案

所有接口使用 `/api/v1`。浏览器管理请求使用管理员会话；worker 接口使用单独凭据。列表接口游标分页；错误返回 code、message、requestId、retryable，不返回 Cookie 或内部堆栈。

| 接口 | 说明 |
|---|---|
| POST /auth/login；POST /auth/logout | 个人管理端认证 |
| GET /profiles；POST /profiles | 浏览器档案 |
| POST /profiles/:id/manual-session | 请求人工模式，返回受控会话信息；忙时返回等待状态 |
| POST /profiles/:id/manual-session/finish | 关闭人工访问并检查会话 |
| POST /profiles/:id/check-session | 请求只读探测；占用时排队，不并发操作 |
| GET /plugins；PATCH /plugins/:id/versions/:version | 已安装插件状态与启停；禁用阻止新领取 |
| GET /tasks；POST /tasks；PATCH /tasks/:id | 任务及参数，Schema 校验 |
| POST /tasks/:id/runs | 手动触发，要求 Idempotency-Key |
| GET /runs；GET /runs/:id；POST /runs/:id/cancel | 查询和取消 |
| POST /worker/claims | 原子领取，返回配置快照、token 和截止时间；无任务 204 |
| POST /worker/runs/:id/heartbeat | 续租和进度，返回取消/人工模式信号 |
| POST /worker/runs/:id/collections | 新采集前申请不可变 collection_id/seq；要求有效租约、档案独占和幂等请求键，重传申请返回原 collection |
| POST /worker/runs/:id/submissions | 提交采集结果；事务内检查档案提交水位，返回 APPLIED/STALE 收据；同 payload 幂等重传 |
| POST /worker/runs/:id/actions/prepare | 点击前记录稳定操作键，检查有效租约 |
| POST /worker/runs/:id/actions/:actionId/reports | 记录 dispatch、核验和证据 |
| POST /worker/runs/:id/outcome | 报告终态及分阶段结果 |
| POST /worker/runs/:id/recover | 核对暂存结果和操作状态，返回 replay_receipt / authorize_upload / blocked / stale；不为旧结果分配新采集序号 |
| GET /entities；GET /entities/:id；GET /entities/:id/versions | 数据和历史 |
| GET /artifacts/:id | 认证后下载附件 |
| GET /notifications；PATCH /notifications/:id | 站内消息与已读 |
| GET/POST /notification-rules；PATCH /notification-rules/:id | 关注规则 |
| GET /push/public-key；POST /push/subscriptions | 公钥和设备注册 |
| DELETE /push/subscriptions/:id | 解除本人设备订阅 |

任务执行、采集登记和数据提交使用不同幂等键。collection 登记请求键按 run_id 唯一，中心在创建 collection 的事务内记录该键；响应丢失时重试同键，不生成新序号。每次真正重新采集使用新键，纯恢复/重传绝不申请新 collection。

重复提交相同 submission_id + hash 返回原收据；同 ID 不同 hash、同 collection 不同 submission 返回 409。原收据优先于当前水位判断，已应用提交不能因后续更新而改判过期。有效身份可重取旧收据，新应用或归档必须满足当前租约或恢复授权。

入库按 [架构第 6 节](02-architecture.md#6-结果可靠上报)执行：一个 SQLite 短事务内完成幂等检查、collection 绑定与权限校验、水位比较、实体/基线/事件/通知更新及收据和水位提交。新 PARTIAL、内容未变或有效空结果同样推进水位；旧批次不修改业务数据，保存 archived_payload 与 STALE 收据。首版按档案整批拒绝旧结果，不做逐实体合并，与 run 终态及 worker 的 observedAt 无关。

收据至少包含 submissionId、collectionId、collectionSeq、disposition（applied/stale）、committedSeqAtDecision、归档确认和计数摘要。收据中的水位是决策时快照，重复返回不表示当前水位。worker 仅在收到 APPLIED 确认或 STALE 归档确认后清理 spool；暂时的 blocked、401、409 或服务故障均不能当作成功清理。

采集上报示例：

```json
{
  "submissionId": "uuid-stable-across-retries",
  "collectionId": "uuid-issued-before-collection",
  "collectionSeq": 42,
  "taskSnapshotRef": "immutable-snapshot-id",
  "attempt": 1,
  "fencingToken": 7,
  "payloadHash": "sha256-of-canonical-payload",
  "scopeKey": "announcements:all",
  "completeness": "complete",
  "items": [
    {
      "entityType": "announcement",
      "sourceKey": "notice-123",
      "sourceUrl": "https://example.com/notices/123",
      "observedAt": "2026-01-01T01:00:00Z",
      "fields": { "title": "示例公告", "status": "published" },
      "fingerprintFields": ["title", "status"]
    }
  ],
  "warnings": []
}
```

source、profile_id 和插件版本由任务快照确定，不信任上报覆盖归属。中心校验 manifest 输出 Schema、允许字段、大小限制、URL 域名与规范化 hash。首版小数据量整批原子提交；超过限制明确拒绝并保留 spool，之后再设计分块完成协议，不静默截断。

collectionSeq 仅作对照，服务端以 collection 记录为准；run_id、profile_id、采集顺序和参数快照必须匹配登记结果。payloadHash 只覆盖不可变业务载荷（collectionId、taskSnapshotRef、scopeKey、completeness、items、warnings），不包含可更新的 attempt、fencingToken 和恢复凭据。taskSnapshotRef 由登记响应返回并在上报中原样携带。

推送发送按设备持久化状态。设备接口与规则接口均校验当前用户归属。Web Push 可能发生重复投递，前端用通知 ID/tag 合并展示，但不能承诺跨系统 exactly-once。

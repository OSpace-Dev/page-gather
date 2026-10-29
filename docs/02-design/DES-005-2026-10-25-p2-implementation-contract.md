# P2 实施接口约定

> 文档编号：DES-005 | 建立日期：2026-10-25 | 最后更新：2026-10-29
> 类型：02-design | 状态：现有文档（功能状态与限制见正文）

本文件是当前P2各模块协作的实施契约，最终已实现内容与验收另记。默认单管理员、单worker、单浏览器档案，GitHub插件可信部署安装；Vue3/Naive UI静态页面由NGINX提供，同源代理API到server容器。中心用Node24原生HTTP与node:sqlite最小实现（Fastify为原选型建议，本阶段不额外增加运行依赖），SQLite绑定部署data/database。

## 用户接口

所有接口前缀 `/api/v1`。管理员用户名admin，密码从 `PAGE_GATHER_ADMIN_PASSWORD_FILE` 读取，部署者自行保密；worker凭据从 `PAGE_GATHER_WORKER_TOKEN_FILE` 读取。文件内容不进Git、不打印普通日志。会话Cookie HttpOnly/SameSite=Strict，生产外部HTTPS时Secure；不盲信代理头，写接口验证配置的 `PAGE_GATHER_PUBLIC_ORIGIN`，loopback开发origin显式配置。登录有速率限制。除health和login外用户接口需会话认证，worker接口需Bearer凭据，二者不可互换。

- GET `/health`：服务健康，无凭据/本机路径。
- POST `/auth/login` `{username,password}`；POST `/auth/logout`；GET `/auth/me`。
- GET `/plugins`：可信插件manifest。
- GET/POST `/tasks`；GET/PATCH `/tasks/:id`：name、pluginId、pluginVersion、profileId（P2固定main）、config、enabled。POST创建/PATCH必须显式校验plugin config；预置任务GitHub每日榜maxRepos25、delay5000，但不自动运行。
- POST `/tasks/:id/runs`：要求Idempotency-Key，创建一次手动run，返回202 `{run}`；无定时调度。
- GET `/runs?cursor=&limit=`；GET `/runs/:id`：`{run}`含snapshot/resultSummary/progress/error及collection信息；POST `/runs/:id/cancel`只停止后续操作，不撤销已入库结果。
- GET `/entities?cursor=&limit=&q=&type=`；GET `/entities/:id`：`{entity,versions}`，README是text，永不作为可信HTML。
- GET `/workers`：最近心跳、mode、busy、activeRunId，无CDP/密钥。

统一返回JSON；错误 `{error:{code,message},requestId}`，无stack/本机路径/页面正文。列表 `{items,nextCursor}`，稳定游标，默认50最大200。run状态QUEUED/RUNNING/SUCCEEDED/PARTIAL/FAILED/CANCELLED/RECOVERING，stage字段区分COLLECT/SEAL/UPLOAD。progress字段使用phase、itemKey、completed、total，网站正文不放日志。

## Worker接口

Bearer校验后解析JSON，默认大小上限10MiB（大于SDK8MiB并考虑授权包开销），超限413，未封存/载荷hash不匹配409。workerId固定部署配置，不接受凭据以外的匿名机器注册。

- POST `/worker/status` `{workerId,mode,busy,activeRunId}`，更新心跳。
- POST `/worker/claims` `{workerId,requestKey}`：worker在请求前将requestKey落本地claim-ticket，中心事务去重workerId+requestKey并绑定原run/领取；响应丢失时同key取回原结果，不能另领任务。确认run已写pending后才清ticket。没有任务204可清ticket；过期领取不自动开始网页，必须走仅终结恢复。平台检查worker未MANUAL、profile无其他持有者且task启用，原子领取FIFO，返回200 `{run,lease:{attempt,fencingToken,leaseUntil}}`。
- POST `/worker/runs/:id/collections` `{workerId,attempt,fencingToken,registrationKey}`：原子分配不可变collection序号，返回 `{collectionId,collectionSeq,taskSnapshotRef}`；重复registrationKey返回原登记。
- POST `/worker/runs/:id/heartbeat` `{workerId,attempt,fencingToken,progress}`：续租，返回 `{cancelRequested,leaseUntil}`。
- POST `/worker/runs/:id/collections/:collectionId/seal` `{workerId,attempt,fencingToken,submission}`：submission为SDK本地封存包 `{submissionId,collectionId,collectionSeq,payloadHash,payload}`。中心校验run快照/插件参数与归属，CAS固定封存身份/hash，同内容幂等。
- POST `/worker/runs/:id/submissions`：同上包，已封存后应用；返回 `{receipt:{submissionId,collectionId,collectionSeq,disposition,committedSeqAtDecision,archived}}`。原收据优先，旧批次STALE整批归档，实体/版本/基线/快照/收据/水位事务原子提交。
- POST `/worker/runs/:id/outcome` `{workerId,attempt,fencingToken,status,errorCode,summary}`：仅明确终态，不改变水位。SUCCEEDED/PARTIAL必须已有提交收据，取消竞争保留提交。
- POST `/worker/runs/:id/recover-finalization`：原worker确认旧页面已停止后，仅恢复终态上报权，不可登记collection、续采或改封存内容；中心检查身份和档案冲突后授予uploadOnly/终结租约，原terminal返回已保存outcome。worker将outcomeIntent在第一次发送前持久化，失败重启原样重放，不替换错误码。OPEN不继续抓取，确认收尾后才释放档案锁。
- POST `/worker/runs/:id/recover` `{workerId,collectionId,submissionId,payloadHash}`：用于SEALED的spool恢复，无页面访问；返回replay_receipt/authorize_upload/blocked/stale与新lease。仅原worker身份，确认没有其他持有者冲突；已确认旧收据可直接返回。P2首版不自动授权OPEN续采，保留检查点并将中断run标记待处理/失败；未来authorize_continue必须满足架构6.3全部条件，不能静默重新抓取。

凭据从配置文件读一次，需轮换时正常重启。API端口内网，公网只能通过认证入口。SQLite只有server打开，worker不挂database。

## Worker执行约定

轮询只能在控制器非MANUAL、无活动任务时领取。真正执行整个run持有现有控制器busy锁，不能绕过锁直接创建浏览器任务。注入signal、原deadline、独占页面与 `/data/spool` 存储给SDK；每15秒心跳，续租失败在失效前abort并停止页面；超时/断连清理失败锁定需要重启。人工模式中不会领取新任务，状态心跳不接管页面。

GitHub首次公开目标无需登录。默认deadline按任务数量/间隔计算并设上限，不能受P1短CLI的55秒限制。进度上传仅含项目键/阶段及从已持久化队列推导的completed/total，不含正文；completed定义为已处理（成功或终结失败），不是请求次数。只读失败可封存现有partial；封存后只重传同包，不能重跑网页。写入本地SDK SEALED后即使seal/API失败仍保留spool；重启先恢复sealed再领取新任务。当前不做无限自动重新采集、不在中心启动定时任务。

## 展示与验证

Web包括登录、任务参数/手动执行、运行进度与取消、完整榜单快照、按项目README详情及错误状态。列表和正文分离，pending/failed仍可见。GETentities列表只返回元数据、readmeStatus和currentVersionId，不携带正文；详情与历史再按需加载。STALE归档中的README可直接从原run结果打开，即使没有被应用为实体，也不依赖entity检索成功。页面每3秒轮询活动run，终态停止；页面后台降频/停止，防弱CPU空轮询。HTML使用文本转义，链接仅http(s)、noopener/noreferrer。

开发验收使用独立P2部署与data，不共享P1人工预览档案。静态NGINX入口仅宿主loopback18080，独立Chrome入口16080，两个Origin显式配置。用户服务器部署留以后；开发环境保留供用户查看采集效果。

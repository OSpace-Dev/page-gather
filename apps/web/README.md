# P3 每日计划与采集工作台

Vue 3 + TypeScript + Vue Router + Naive UI 静态前端。依赖与锁文件由根工作区统一安装维护。

```sh
npm run typecheck --workspace apps/web
npm run build --workspace apps/web
# 从仓库根目录构建静态服务
 docker build -f apps/web/Dockerfile -t page-gather-web .
```

默认通过 NGINX 访问，前端只请求同源 `/api/v1`，不需要独立 Node 生产服务。`vite dev` 不配置绕过同源的代理；开发入口应由 NGINX 统一提供。NGINX 上游名为 `server:3000`，代理保留完整路径与浏览器自动发送的 Origin。公开访问地址需要由后端允许的 Origin 配置显式授权。

浏览器预览使用独立入口，不通过本静态服务代理 WebSocket。当前页面在 localhost / loopback 上访问时显示 `http://127.0.0.1:16080/` 链接；其他主机默认隐藏链接。可通过构建参数 `VITE_BROWSER_PREVIEW_URL` 配置受控的 http(s) 预览入口，例如 Docker 构建时传入 `--build-arg VITE_BROWSER_PREVIEW_URL=...`，配置会进入静态文件，不能包含密钥。

## 页面与数据约定

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

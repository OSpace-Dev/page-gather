# 插件内核接口（首版）

这是独立、零第三方依赖的基础模块。P2已通过 `apps/worker/src/poller.js`、controller独占锁及 `apps/server/` 接通登记/封存/提交；本SDK仍由宿主注入租约和页面，不能自行接管浏览器。插件属于随部署安装的可信代码，不是沙箱；没有公共脚本上传或流程 DSL。

```js
import { runPlugin, sealPluginResult, readOpenDraft, readSealedSubmission, JsonCheckpointStore } from './packages/plugin-sdk/index.js';
import { withCdpPage } from './packages/plugin-sdk/cdp-page.js';
import githubTrending from './plugins/github-trending/index.js';

// host 必须先取得档案独占租约、排除 MANUAL，并从中心取得不可变 collection。
// host 是依赖注入示意，不是 controller 的直接方法；实际P2接线见worker poller。
const result = await runPlugin(githubTrending, {
  runId, collectionId, collectionSeq, taskSnapshotRef,
  config: { since: 'daily', maxRepos: 25, itemDelayMs: 5000 },
  deadline, signal,
  resume: false,
  // 返回 true 只能表示宿主已得到真实 authorize_continue；测试可注入授权桩。
  authorizeResume: request => host.authorizeContinue(request),
  // 容器约定路径，必须由宿主确认已挂载；本地由宿主显式传入临时目录。
  store: new JsonCheckpointStore({ root: host.spoolRoot }),
  withPage: async (use, lease) => {
    const page = await host.createTaskPage(lease);
    try {
      return await withCdpPage(page, use, {
        ...lease, allowedDomains: githubTrending.manifest.allowedDomains
      });
    } finally {
      await page.close();
    }
  },
  progress: ({ itemKey, code }) => host.progress({ itemKey, code })
});
```

结果只是一份 OPEN 草稿，`checkpoint.stateHash` 绑定产生它的本地状态；尚不能发送到中心 submissions。`sealPluginResult(plugin, options, draft)` 在不访问页面的情况下生成并原子保存本地 SEALED 包（固定 submissionId、payload、payloadHash）。P2宿主已实现中心seal CAS、丢失响应查询及提交授权；本地helper仍不代替中心事务。旧 stateHash 不能封存更新后的草稿；SEALED 后同 payload seal 幂等，不同 payload 拒绝，不能再 commit 或 resume，即使最终是 partial。`readSealedSubmission(plugin, options)` 只读原包用于未来重传/归档。取消后可用 `readOpenDraft(plugin, options)` 纯读检查点并选择封存 partial；该接口需要插件实现纯函数 `snapshotResult(ctx, state)`。

SDK 不发现 CDP 端点、不创建 Chrome、不改控制器模式，也不检测 GitHub 登录状态。`withPage` 的宿主必须处理租约取消、任务页面关闭及清理失败；不能传入人工使用中的页面。CDP 初始化每条命令均检查取消，等待中的命令晚返回也不会在清理后继续启用 Network/Fetch；适配器只清理请求拦截和监听，最终关闭任务 target 始终是宿主的 `finally` 责任。`withCdpPage` 只接收现有 `CdpPage`，通过直接 CDP 监听主文档 HTTP 状态、Retry-After，并在提取期间拦截图片和非允许域名请求。该严格拦截策略已在独立无账户Chrome中验证一次Trending及两个README页面，但不保证所有站点页面渲染兼容；本次成功smoke使用临时 `--disable-http2 --disable-quic`，未修改生产Chrome启动参数，默认网络参数下的GitHub访问仍待验证。不要复用其任务页面进行人工浏览。

插件提供 `manifest`、`validateConfig(input)`、`validateState(state)`、`async collect(ctx)`。`ctx` 提供规范参数、collection 绑定、可取消 `wait(ms)`、有界页面调用 `withPage(fn)`、共享 `throttle(ms)`（平台最低 3000ms）、`defer(until)`、安全 `progress(itemKey, code)` 和 `commit(state)`。插件可以自行分支、循环和访问任意数量页面。`commit` 是本地检查点事务，不是中心入库确认。

`checkpoint({ store, binding, validateState, maxBytes })` 也可独立使用，提供 `load()`、`commit(state)`、克隆的 `state`。默认文档大小上限8MiB，当前schemaVersion=3。OPEN保存工作state，SEALED仅保存binding、期限、stateHash与固定submission，不重复完整正文；SEALED的state为null，不能读取为OPEN草稿。OPEN接纳新state前按snapshotResult生成最终包并检查预算，超预算保留可封存partial。首次seal从持久state重建权威payload核对传入草稿，删改items/snapshot不能与原stateHash一起通过。v2检查点不自动迁移。存储约定为 `load(runId, collectionId)` 与 `save(runId, collectionId, document)`，可注入 `MemoryCheckpointStore` 或故障测试存储。文件实现的 `root` 只能来自受信宿主配置，默认 `/data/spool` 是容器约定挂载路径，对应部署目录的 `data/spool` bind mount；宿主启动时必须确认挂载存在，不能把默认数据落在容器可写层。不要将任务配置或用户传入路径透传到构造器。Windows/本地测试必须显式使用宿主创建的临时目录，例如 `new JsonCheckpointStore({ root: await mkdtemp(join(tmpdir(), 'plugin-spool-')) })`，并在测试结束后清理。文件位于 `<root>/<runId>/<collectionId>.json`，只接受严格 ID，逐级拒绝目录 symlink/junction 并拒绝读取符号链接检查点，采用临时文件、文件同步和原子 rename。它依赖宿主单写者及本地受信文件系统，不提供跨进程锁或断电事务保证。

GitHub 插件首次读取榜单后冻结有序 queue，并绑定配置 hash、插件版本、任务快照和原 collection ID/seq。每项的结果及完成状态写入同一文档，成功落盘才发送 COMPLETED。恢复使用 `resume: true`；任何已有 OPEN 文档（不论 resume 参数）还必须提供 `authorizeResume({ binding, stateHash, state, deadline })`，且回调明确返回 true。回调由宿主验证有效租约、旧持有者已停止、档案独占、未封存/无收据、原日期和期限、提交水位未达到原 seq，以及该档案没有更晚登记的 collection；即使后续 run 未提交也不能批准旧续采。SDK 无中心数据库，只检查本地绑定和日期/期限，不能自行证明这些中心条件。宿主同时负责以注入 signal 撤销失效租约，使每次页面步骤都受约束。文档不存在、绑定不符、原期限已过或跨 UTC 日期均拒绝恢复。P2中心收到stale决策后只授权归档原文档，不能再调用页面采集或为旧内容换序号。

SDK 在首次调用 `collect` 前持久保存文档元数据 `initialDeadline`，即使插件还没 commit 也不会丢失原期限；此时文档的 `state` 为 null，恢复仍需宿主授权，授权回调必须能处理该值。有效 deadline 为原期限与本次参数的较小值。恢复时传更短期限不会造成 binding mismatch，更晚期限不能放宽原期限。页面租约 signal、单步调用、等待和 commit 均受有效期限限制。GitHub 插件另将其收紧到冻结日期的 UTC 午夜及原 `expiresAt`，导航返回后、evaluate 前也检查；过期直接抛出，不允许先读取再拒绝。

首版瞬时失败初次立即返回 OPEN partial 草稿；下一次同 collection 的本地 resume 最多再读一次失败项。预算耗尽会持久加入 `terminalItemFailures` 并继续后续队列。仓库 HTTP 404 明确记为 `REPOSITORY_NOT_FOUND`，普通非 200 的 `HTTP_FAILED` 也作为项目终止失败继续；它们不会伪造 README not_found。重试预算在请求前持久化，因此进程崩溃或取消可能消耗一次预算；已经完成的项目不重抓，也不刷新榜单。403/429/挑战及 SELECTOR_CHANGED 保存 `blockedBatch` 并停止整批，后续 resume 只返回已保存部分结果。列表读取失败会直接抛错，尚未冻结时不伪造空队列。取消、deadline、存储失败均抛出，不包装为普通项目失败。

结果的独立 `snapshot.entries` 始终包含全部冻结队列，含 `key/url/rank` 和可见的 `description/language/stars/dailyChange`；不可见字段为 null，星数及 daily 变化保留页面文本，不推算数值。每条携带 `completed/pending/failed` 状态与 error；取消后读取 OPEN 草稿、最终封存 partial 也保留未处理和失败项目。README `items[].queueKey` 关联榜单 `key`，重命名落地身份另存 `sourceKey/sourceUrl`。结果区分冻结榜单观察时间 `observedAt`、UTC `capturedDate`、各项目实际观察时间和名次；GitHub daily 是滚动窗口，不是历史全天日榜。README 格式固定 `rendered_text`，读取页面实际 README 区域及文件链接，不猜分支/路径、不访问 raw/API、不跟随正文链接。`not_found` 只在识别到 GitHub 空仓库 `#repo-content-pjax-container .git-empty` 内 Quick setup 标题这一明确缺失证据时产生；仅仓库头存在而 README root 缺失会报 SELECTOR_CHANGED。来源分为两种：旧版已知header中的唯一README文件链接可用 `sourceKind=file`；现代页面通过Repository files导航中唯一当前README项、同区域semantic header和唯一可见正文article建立关联，来源为页面真实存在的README锚点，`sourceKind=rendered_page`、`fileSourceUrl=null`。不得从文件列表或正文普通blob链接推断原文件。现代分支已有独立无账户Chrome 2/2项目成功提取及封存读回；旧版header和其他变体仍主要依靠fixture验证，不声称覆盖所有页面。`truncated: null` 表示不能确认 GitHub 是否已截断正文；本地超过 512KiB 则返回 README_TOO_LARGE，不能声称完整原文件。`contentHash` 仅覆盖 README 内容及来源身份，rank、stars、时间和进度不参与。最终实体建模、版本去重与历史run固定版本引用已由P2中心实现；跨重命名的别名合并尚未实现，不将其描述为已验证能力。

验证命令：`node --test apps/worker/test/plugin*.test.js`。DOM fixture测试会运行插件实际编译的提取表达式，不保证未来GitHub结构稳定。本轮完整Windows100项（99通过/1POSIX跳过）、独立Linux100/100通过；线上只读smoke maxRepos2、间隔实际5002/5000ms，正文字符7552/5428、sourceKind均rendered_page，无真实登录账号。

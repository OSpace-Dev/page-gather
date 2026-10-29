# P2 插件流程设计：GitHub Trending 与 README

> 文档编号：DES-004 | 建立日期：2026-10-25 | 最后更新：2026-10-29
> 类型：02-design | 状态：现有文档（功能状态与限制见正文）

## 1. 本轮需求与阶段

本轮设计及SDK/插件基础代码已完成Reviewer复审，验证与限制见 [评审记录](../06-reviews/REV-004-2026-10-25-p2-plugin-workflow-review.md)。独立SDK公开目标smoke成功2/2时使用临时Chrome网络参数；后续P2完整链路已在默认HTTP2/QUIC配置下成功3/3，见 [最终开发验收](../05-verification/VER-002-2026-10-25-p2-development-verification.md)。

首个真实目标为 `https://github.com/trending`，采集每日热门项目及其 README。用户强调不同站点具有不同规则，插件必须能表达列表发现、逐项访问、间隔、分支、失败处理等完整流程，不能只配置选择器。

本文件最初记录插件基础设计，目前P2中心、SQLite、worker接线与Vue页面均已完成开发验收；阶段结果见 [P2验证记录](../05-verification/VER-002-2026-10-25-p2-development-verification.md)。P1人工预览始终独立保留，不复用或接管该MANUAL浏览器。

## 2. 扩展原则

插件是可信、版本固定的代码模块，拥有 `async collect(ctx)` 执行入口。函数内部可以使用普通分支、循环、组合函数和任意数量的页面步骤，不要求所有网站都遵循“列表/详情”模板，也不引入首版可视化DSL或通用RPA编排引擎。

| 插件负责 | 平台负责 |
|---|---|
| 网站DOM解释、登录证据与错误页面识别 | Chrome生命周期、页面独占、人工互斥、CDP连接 |
| 步骤先后、分页、逐项展开、条件分支 | 配置校验、deadline、取消与有界等待 |
| 站点业务日期、稳定业务键、重要字段 | collection登记、提交顺序、幂等收据、spool |
| 什么算README存在/缺失、何时可继续下一项 | 原子检查点存储、进度、错误分类、结果上报 |
| 申请站点所需的间隔或有限只读重试 | 限速下限、重试预算、站点退避上界 |

插件新增/删除通过部署注册完成；中心不写 `if (site === 'github')` 分支，页面也不依赖某个网站的字段。平台可根据插件的参数Schema生成任务配置，但网站业务展示由通用实体类型或独立展示适配器决定。

插件虽拥有流程控制权，也不能绕过人工锁、截止时间、站点限速和不确定副作用规则。SDK只给可信代码使用，不宣称是能隔离恶意插件的沙箱。

## 3. GitHub插件的采集路径

1. 将参数规范化为daily榜单、可选编程语言/口语筛选、最大项目数、间隔、README大小和执行期限。
2. 在中心分配的同一collection内，读取榜单并验证页面身份和结构。GitHub此页公开可读，本插件声明无需登录，不以公开DOM证明账号有效；未来需要登录的插件仍按任务绑定探测。
3. 提取有序仓库列表及榜单字段，形成不可变队列和listCapturedAt。保存检查点成功后才访问首个仓库。
4. 串行访问队列项目。两次主动页面访问之间遵守间隔，包含失败重试；等待可取消，并受deadline限制。低CPU服务器不并发开25个项目标签。
5. 打开实际仓库页面，从GitHub明确关联README标签/区域的渲染正文提取内容。保留实际渲染来源URL（含页面真实README锚点），`sourceKind=rendered_page`；只有文件标题或元数据能唯一确定原文件时才保存fileSourceUrl。不能拼接 `main/README.md` 或 `master/README.md`：分支名、大小写及GitHub认可的目录均可能不同。
6. 每项的输出和下一检查点一次原子提交到本地spool。只有成功落盘才算完成该项；发送进度不替代持久化。
7. 项目不存在、README明确缺失、可继续的单项错误分别标记；限流/验证码/访问限制停止后续访问并保留进度，不能把错误页当README。
8. 完成后输出完整性和计数；最终数据提交沿用原collection与不可变提交协议，网络重传不能重新访问网站。

### 默认参数建议

| 参数 | 首版建议 |
|---|---|
| since | 固定 daily，周/月榜单以后单独配置 |
| language / spokenLanguage | 默认不过滤 |
| maxRepos | 默认25，最多100，仅采当前页面实际条目，不虚构补齐 |
| itemDelayMs | 默认5000ms，下限3000ms；这是保守工程默认，不是GitHub官方认可速率 |
| 并发 | 1 |
| 只读瞬时重试 | 每项至多1次，仍经过间隔与总预算；限流或挑战不立即重试 |
| README格式 | rendered_text，GitHub页面渲染正文；raw_markdown未实现 |

参数上限、总时长、内容大小以插件manifest/实现校验为准。25个仓库至少需要约两分钟的间隔加页面加载时间；未来中心的任务超时应依据条目数和延迟计算，不能沿用P1短CLI命令的超时后悄悄让后台继续。

README的图片、外站链接、脚本不由插件主动递归访问，也不点击README中的命令或操作按钮。浏览器加载仓库页面时可能自动加载资源，不承诺零外部资源请求；若后续要拦截资源须另行验证不影响提取。

## 4. 数据语义

榜单快照与README内容分开建模：

- `trending_snapshot`：插件配置范围、listCapturedAt、UTC capturedDate、排名、owner/repo、描述、语言、stars展示值与daily变化展示值。日期是本平台观察日期，不能称为GitHub发布的历史日榜。
- `repository_readme`：稳定sourceKey、repoUrl、readmeUrl、sourceKind、可空fileSourceUrl、observedAt、contentFormat、正文、contentHash、readmeStatus、truncated和证据摘要。

首版只承诺GitHub页面实际可见/可提取正文。GitHub官方说明页面README可能截断超过500KiB的内容，本平台的大小限制还可能进一步截断；必须显式标记，不能称为完整原文件。渲染提取通常丢失Markdown语法、图像和部分排版。若未来需要原始Markdown，新增显式raw读取能力，不能在raw失败时悄悄用渲染正文冒充。

README渲染来源与原文件路径是不同字段：现代页面不一定暴露可唯一确定的文件链接，不能从目录中README.md/README.zh-CN.md任选一个。已确认的README section锚点可作为rendered_page来源；无法判断是否README正文时仍报结构问题，不退化成任意markdown-body提取。

正文内容指纹不包含榜单排名、stars、采集时间或任务进度；排名变化不制造README更新。缺失README使用 `not_found`，提取失败用 `failed/unknown`，两者不混淆。新项目有榜单条目但README未成功时仍可保留元数据和失败状态；不能把错误页保存为正文。

仓库链接只接受GitHub实际owner/repo路径，拒绝外站、带凭据或脚本URL。重命名/转移后记录规范URL与观察到的别名；最终跨别名实体合并由中心决定，不能把仅大小写变化制造成两份稳定实体。

## 5. 检查点、恢复与提交顺序

检查点绑定pluginId/version、规范参数hash、collectionId、任务快照和队列采集时间。首次队列只生成一次，恢复不能重新读取榜单后与旧结果混合。

存储内容包括有序队列、下一处理项、完成结果和有限尝试数；项目结果与检查点同文件原子替换。SDK接收受控spool目录和run/collection身份，不接受任意用户绝对路径。运行数据被忽略，不进Git或构建镜像。

- 同collection恢复：仅针对OPEN工作检查点，平台重新取得有效租约与独占，并校验绑定、日期、原deadline、提交水位、该档案无更晚登记collection后签发authorize_continue。沿原队列处理剩余项，跳过完成项；取消和限流不伪装完成。
- 已封存结果：SEALED后固定submission_id/hash，包括partial均不得再增补，只允许重传或归档。封存和中心接线见 [架构6.3](DES-001-2026-10-25-system-architecture.md#63-多步骤插件open续采与sealed重传)；本地checkpoint草稿不能直接当最终submissions提交。
- 配置或插件版本改变：拒绝恢复，不能覆盖原检查点。
- 跨UTC观察日或超出期限：首版拒绝继续网页访问，保留partial，由平台决定归档/新的只读采集，避免把多天数据拼成同一日观察。
- 中心已经判旧collection过期：停止网页访问，只归档；不能给旧结果申请新seq或重新贴时间。
- 真正新采集：申请新collection、建立新队列，原partial不自动注入新结果。

部分完成检查点可以处于OPEN以供授权续采，也可由平台选择结束并seal为不可变partial；两者必须在状态和界面上区分，不能一边声称已最终提交一边继续加项。

已评审的档案级提交水位仍生效：即使新结果PARTIAL或尚未报告run终态，旧collection也不能覆盖它。检查点是执行过程持久化，不是额外的中心提交权限，也不能代替最终收据。

## 6. 失败与进度

进度至少区分发现列表、等待间隔、访问仓库、提取README、保存检查点、完成/部分完成。显示total/completed/failed/currentRepo/nextEligibleAt；日志用项目键、阶段、错误码，正文不进普通日志。

| 情况 | 行为 |
|---|---|
| 列表结构不认识/为空但无明确空榜证据 | 停止并报结构问题，不伪造完整空结果 |
| 项目README确实不存在 | 保存not_found并继续 |
| 网络瞬时错误 | 有限重试；仍失败记单项失败，是否继续由插件规则明确 |
| 403/429/限流提示/验证码 | 停止当前批次，保留队列和进度，等待用户或退避策略 |
| 用户取消/deadline | 立即停止后续访问，当前未提交项不标完成，正常释放页面 |
| 检查点写入失败/磁盘满 | 停止，不报告该项已完成；保留上次可确认状态 |
| 最终上报断网 | 重传同结果，不能重抓网页 |

限流检测可来自实际主文档HTTP状态或站点明确提示，不能靠任意README正文出现“rate limit”就认定账号被限流。有限重试是站点插件可配置策略，取消、登录要求、结构错误不能套用网络重试。

## 7. 平台接线与本轮验收边界

第一步为可测试的SDK及GitHub插件实现，不改变P1控制器允许命令，也不让插件直接连接当前MANUAL浏览器。之后由平台worker在取得独占任务后创建受限ctx，注入页面、检查点、clock与取消信号，再交中心登记collection。

P2已落地Node中心容器、SQLite数据与提交协议、手动任务API、可信插件注册、worker任务接线和数据列表/详情。OPEN自动授权续采仍未开放，SEALED恢复只上传；附件诊断本轮提供错误码，上传接口明确501。每日调度属P3，PWA推送属P4，签到属P5。

本轮测试应覆盖：冻结列表、顺序与间隔、单项失败继续、完成项目跳过、检查点原子失败、绑定不匹配拒绝、跨日拒绝、abort不重试、限流/挑战终止、README缺失/过大、排名变动不改变正文指纹。公开GitHub实际DOM需要独立验证；合成fixtures或fake页面测试不能证明线上DOM长期稳定。

参考：

- GitHub README识别与显示规则：https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes
- GitHub使用政策：https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies
- 目标：https://github.com/trending?since=daily

本轮已读取上述官方README和使用政策文档。首次通用抓取超时；后续独立无账户Chrome确认Trending可读，11条列表且首仓库HTTP200，但旧#readme结构不匹配现代页面，因此首次线上smoke为partial/SELECTOR_CHANGED。没有把结构变化当作README缺失；现代结构适配后，两个仓库正文与实际README锚点来源提取、封存读回均通过；成功环境使用临时 `--disable-http2 --disable-quic`，未改变生产启动参数。因此生产默认网络兼容性仍待验证。

本地SDK的检查点版本与大小预算以SDK文档为准，SEALED不重复存放整份OPEN正文，OPEN接纳结果前为最终封存包预留预算；首次封存从已保存state重建权威载荷，调用方修改草稿不能改变最终内容。

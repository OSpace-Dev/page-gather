# P2 流程插件评审记录

> 文档编号：REV-004 | 建立日期：2026-10-25 | 最后更新：2026-10-29
> 类型：06-reviews | 状态：历史评审记录（保留原结论及验证边界）

## 范围

本轮围绕首目标GitHub Trending每日榜与项目README，交付可编排插件内核和GitHub插件基础。尚未形成中心API、SQLite、worker任务接线、前端闭环；不称P2完成。所有调试不得接管现有MANUAL预览或读取用户档案。

## 设计评审

首轮设计发现：

| 编号 | 级别 | 意见 | 处理 |
|---|---|---|---|
| WF-D1 | P1 | 同collection检查点续采与原“新页面采集必须新collection、恢复只能上报”冲突 | 修订架构6.3与契约，分OPEN授权续采、SEALED重传、新collection采集；设计复审关闭 |
| WF-D2 | P3 | 交付计划仍称当前P0/目标网站待指定 | 更新P1完成/P2插件内核进行及GitHub目标；设计复审关闭 |

设计复审通过：OPEN需重新取得有效租约、独占、旧持有者停止，匹配原日期/deadline、提交水位且无更晚登记collection；沿原seq与冻结队列继续。SEALED包括partial不再增补，CAS封存响应丢失查询原封存；重新采集必须新collection。SDK本地hook不代替中心事务。设计通过不等于代码验收。

## 代码首轮评审

| 编号 | 级别 | 意见 | 状态 |
|---|---|---|---|
| WF-C1 | P1 | 输出只有成功README项目，缺独立完整榜单和可见元数据 | 独立snapshot及完整manifest已补齐，最终复审关闭 |
| WF-C2 | P2 | README根选择器不存在即not_found，混淆页面结构变化 | 复审关闭 |
| WF-C3 | P2 | 可能把README正文里的普通blob链接当README文件来源 | 复审关闭 |
| WF-C4 | P2 | 单项重试预算耗尽后挡住后续队列，404未形成失败条目 | 复审关闭 |
| WF-C5 | P2 | 恢复传更晚deadline后导航越过原期限仍执行DOM读取 | 复审关闭 |
| WF-C6 | P2 | 取消CDP初始化后，底层异步初始化仍在清理后发送命令 | 复审关闭 |
| WF-C7 | P2 | 默认相对spool路径不能命中容器/data/spool持久挂载 | 复审关闭 |
| WF-C8 | P2 | manifest未覆盖snapshot、queueKey及新增状态字段 | 契约/Schema负例补齐，最终复审关闭 |
| WF-C9 | P2 | 首次seal未从持久state重建并核对payload，调用方改草稿仍可封存 | 从持久state重建权威payload，最终复审关闭 |
| WF-C10 | P2 | SEALED重复保存state/payload正文，OPEN可接纳结果却因体积翻倍封存失败 | v3去重及OPEN预留预算，最终复审关闭 |

最终修复复审通过：可作为SDK/GitHub插件基础代码交付，无新增P0/P1/P2；原设计和代码发现均已关闭。本轮不要求中心、controller或前端接线，不能因此称P2整体完成。

## 最终验证与线上限制

- Windows完整检查100项：99通过、1POSIX跳过、0失败，依赖和隐私扫描通过；Reviewer独立复跑同结果。
- 独立Linux Docker使用init回收进程，100/100测试通过；不使用init的初次POSIX进程测试失败，不把该初次结果写为通过。
- 首次独立线上smoke读到11条Trending，首仓库#readme缺失而markdown正文存在，结果为partial/SELECTOR_CHANGED。该失败推动现代DOM适配，没有把结构问题改成not_found。
- 修正后独立无账户Chrome使用maxRepos=2和>=5秒间隔，榜单与两个仓库均HTTP200，README2/2、complete，本地封存与读回校验通过；正文字符数7552和5428，未打印全文或任何账号信息。
- 现代结构按Repository files导航的当前README项、局部语义header与唯一可见article关联；来源使用真实 `#readme-ov-file`，sourceKind=rendered_page，fileSourceUrl=null，不猜原文件路径。
- 成功smoke临时Chrome使用 `--disable-http2 --disable-quic` 解决该环境网络超时，未更改生产启动参数；生产默认网络下访问GitHub仍未验证。该参数不是防检测方案。

Reviewer未独立重跑Linux或线上Chrome，线上和Linux结果来自开发执行记录及其断言审查。全部在线测试使用独立Chrome和临时spool，不触碰保留的MANUAL预览、用户data或真实账号。SDK/插件仍未接平台worker，不能直接从现有预览CLI启动该插件。

README当前为rendered_text，不能声称raw Markdown或完整原文件。GitHubDOM会变化，2个项目成功不证明全站永久兼容。本插件不要求用户先登录，也不使用公开DOM作为账号登录证据。

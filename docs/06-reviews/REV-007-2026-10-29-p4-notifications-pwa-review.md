# P4 通知与PWA评审记录

> 文档编号：REV-007 | 建立日期：2026-10-29 | 最后更新：2026-10-29
> 类型：阶段评审 | 状态：设计和代码修复复审通过；交付证据已补齐

## 范围

按 [DES-007](../02-design/DES-007-2026-10-29-p4-notifications-pwa.md)审查通知/基线、规则、Outbox、设备投递、VAPID/网络边界、Service Worker、PWA更新/缓存、页面及开发验收。P3用户手工验收保留待办，不作为P4阻碍；P5签到暂停，其他站点需求待P4后讨论。

## 设计评审

设计首审发现两项P2歧义，均经修订复审关闭，设计通过：

| 编号 | 意见 | 确定语义与关闭依据 |
|---|---|---|
| P4-D1 | 跨任务版本去重与taskIds过滤先后不明确 | 版本首次入库任务为固定来源，后续重复观察不补匹配；baseline按task/scope独立，partial不消耗已通知标记 |
| P4-D2 | 全局开关和多规则撤权缺统一条件 | 入队configured且enabled，保存原rule/device快照；send/retry至少一条原规则仍授权，全部撤权或全局关闭终止skipped，不追历史 |

Reviewer只读确认设计，未将其视为代码、外部推送或真机验收。

## 代码与集成评审

完整首审发现三项P2，无已确认P1，均已修复复审关闭：

| 编号 | 发现 | 修复方向 | 当前状态 |
|---|---|---|---|
| P4-S1 | EC私钥导出可能不足32字节，正常初始化随机失败 | 编码前左补0至32字节，固定短导出回归，保持不覆盖/不轮换 | 复审关闭 |
| P4-FE1 | PATCH已读完成时关闭/切换详情会丢弃列表及未读同步 | 分离当前详情更新与成功写入后的全局同步，保留卸载保护 | 复审关闭 |
| P4-FE2 | 设置表单标签未与实际input/switch关联 | 实际节点id/for或aria名称，当前SFC/真实Naive渲染回归 | 复审关闭 |

首轮本地主检查285项（Windows282通过、3平台项跳过）和前端构建通过，但未覆盖以上缺口。后端Reviewer独立执行82项中的80项通过、2权限相关跳过，修复复审又执行密钥6项中的5项；前端Reviewer独立选测25项、构建及组件复现，修复复审执行新增7项当前SFC/真实Naive SSR和历史版本2项，并通过typecheck。

Linux与WSL集成证据及限制见VER-005；iOS/iPadOS实机体验由用户以后验收。Reviewer未亲自重跑Docker、真实GitHub或外部push，不把开发执行报告称为Reviewer亲验。

## 关联

实际结果见 [VER-005](../05-verification/VER-005-2026-10-29-p4-notifications-pwa-verification.md)，用户待办统一在 [PLAN-002](../03-planning/PLAN-002-2026-10-29-current-execution-plan.md)。

## 交付证据补齐

最终核对提出P4-R1（P2）：成功补验未落入交付记录。现VER-005已保留首条FAILED/CDP_COMMAND_TIMEOUT及根因未确认，追加一次真实manual成功8.086秒、1项目/1receipt/0错误、唯一baseline、unread1→0、11ms原包重放不重复、readAt幂等，以及重启2runs/1notification/1submission/1baseline保持。来源为开发执行报告，主agent读取了汇总及截图，不称Reviewer亲验。

Linux307/307、helper6/6、init4及构建结果已记录。外部push未启用、无FCM/Apple accepted，原生系统点击、PWA双版本在线更新和iPhone真机均保留限制。P3/P4用户手工待办不阻塞开发交付，P5暂停。

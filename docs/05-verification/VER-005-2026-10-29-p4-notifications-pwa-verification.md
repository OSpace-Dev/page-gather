# P4 通知与PWA验证记录

> 文档编号：VER-005 | 建立日期：2026-10-29 | 最后更新：2026-10-29
> 类型：阶段验证 | 状态：开发闭环验收通过；人工体验/iPhone外部推送待用户

## 范围与来源

通知、规则、基线、事务Outbox、设备投递、VAPID、PWA静态缓存和页面。实际WSL结果来自开发agent执行报告，主agent读取了本地报告并检查通知/设备及375宽通知详情截图；Reviewer独立检查代码与部分回归，不冒称亲验Docker或iPhone。

## 测试与构建

| 检查 | 实际结果 |
|---|---|
| Windows Node24.22.1完整检查 | 307项，304通过、3平台项跳过、0失败 |
| Linux最终套件 | 307/307、0失败/跳过；最终确认再次通过 |
| VAPID helper Linux | 6/6；固定短私钥补零、不轮换、链接拒绝等 |
| 临时初始化 | 4项通过，未触碰旧data |
| 前端 | Vue类型检查、Linux生产构建通过；105项前端测试含当前SFC和Naive SSR回归 |
| 镜像与重启 | server/web/worker最终构建通过；保留本部署数据，重启正常 |
| 协议 | 实际web-push库AES128GCM合成接收端解密、VAPID ES256验签通过，不是外部投递 |

版本：最终Linux/helper Node24.22.1，worker Node24.15.0，Chrome156.0.8078.47，web-push3.6.7，Compose2.39.1。标准库依赖及VAPID代码修复见REV-007。Windows三项跳过为POSIX进程组、VAPID文件权限/链接、初始化符号链接；Linux均已补跑。

## 真实基线补验

独立P4部署 `page-gather-p4-dev` 位于WSL ext4，web 18082、浏览器人工入口16082；容器data和P1/P2/P3各自隔离。

第一次manual run为FAILED/CDP_COMMAND_TIMEOUT，在冻结榜单前失败，无submission或通知。失败记录原样保留，根因未确认，不能直接归因为网络或档案占用。

追加一次受控重跑前，确认本地CDP和fixture健康：整组109ms，controller无busy/fault、holder和pending无阻塞，目标创建/关闭后页面数量不变。没有清除锁或覆盖档案。主agent只授权最多追加一次；开发agent按正常API执行该次manual run，8.086秒SUCCEEDED：1项目、1receipt、0错误，创建唯一1条baseline站内通知，初始unread=1。HTTP2/QUIC保持默认0，未使用raw/API替代，没有无限重抓。

通知UI读取详情后unread从1变0，固定目标为成功的原run；点击查看原README使用已保存快照，正文12185字符且与run结果一致，无额外GitHub访问。重复PATCH保持首次readAt，已读后read-all是幂等空变更，不冒称另一轮正向未读转换。

同SEALED包重放11ms返回原receipt，通知仍1条、id/readAt不变。仅server正常重启后：2runs（原失败+新成功）、1notification、1submission、1baseline、1版本/事件，target/readAt保持不变，无holder，健康正常。没有往真实展示库注入合成项目或fake accepted。

## 页面与PWA

- 默认站内规则开启、pushEnabled=false，所有日程关闭，0设备/0投递。subject为空、全局push关闭，未轮换已有VAPID。
- 桌面1440及375宽通知中心、规则、设备和真实基线详情/原README截图通过检查，无横向页面溢出，未截图密码表单。首次7张界面截图加基线补验6张，保存在本部署data/artifacts，不进Git。
- manifest、真实192/512图标、SW注册、公开精确缓存及API/auth排除通过；离线只有公开提示，不展示个人通知卡片。登出清个人状态，auth/me返回401，无个人API缓存。
- 当前无真实等待更新版本，实际SW更新确认链路未做双版本在线验收；隔离测试覆盖用户确认后才skipWaiting/刷新。
- 独立Chrome实验权限覆盖+模拟push调用生产SW showNotification，取得通用通知对象；没有外部服务请求，不等于真实设备已展示。
- fake PushManager隔离页面加载时权限/订阅调用为0，实际CDP点击后按顺序调用一次权限及订阅；fixture拦截请求，不写真实设备库。
- 未注入客户端的合成notificationclick受Chrome用户手势限制，原生系统点击未通过验证；注入客户端的生产handler分支通过仅证明路径/focus逻辑，不冒称原生跳转通过。

## 事务与故障覆盖

临时SQLite/HTTP和注入传输测试覆盖partial→baseline、多规则、首来源过滤、receipt/STALE去重、历史升级不回放、原子回滚、端点/设备秘密隔离、注销、lease重启、有限重试与后台停止。故障模拟不是外部推送服务实际accepted。站内baseline、已读和重启数据保留另由上述真实集成验证。

## 证据与人工账目

本部署data/artifacts/acceptance-results.md保留首轮失败和补验结果；second-run-metadata.json、second-notification-ui.json、second-replay-results.json、second-persistence-results.json及baseline-*.png为补验索引。Linux日志和源码摘要仅本地保存，可能包含环境信息，不整段提交。部署副本无Git元数据，文档/隐私枚举检查用明确源码清单执行，不假称Git CLI在副本成功。仓库内文档与隐私检查由主agent另行执行。

P4三服务保留运行，独立测试Chrome/fixture已清理。外部push保持off、subject空，未声称APNs/FCM accepted或iPhone锁屏显示。当前入口及配置见 [RUN-007](../04-delivery/RUN-007-2026-10-29-p4-notifications-pwa-usage.md)。

P3用户手工体验、P4界面体验、iPhone主屏幕安装/授权/锁屏或关闭PWA接收/原生点击跳转均留待用户，见 [PLAN-002](../03-planning/PLAN-002-2026-10-29-current-execution-plan.md)。用户今天无空不阻塞开发，但不写成已验收。P5签到暂停，其他站点待P4后讨论。

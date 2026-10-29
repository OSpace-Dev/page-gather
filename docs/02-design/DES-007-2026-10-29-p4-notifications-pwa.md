# P4 通知、事务Outbox与PWA

> 文档编号：DES-007 | 建立日期：2026-10-29 | 最后更新：2026-10-29
> 类型：阶段设计 | 状态：已实现、修复复审通过；实测及真机边界见VER-005

## 1. 用户授权与验收边界

用户授权继续P4，并明确今天无空手工验收。P3开发已完成，但用户手工验收记为待办，不因其尚未执行阻塞P4。P5自动签到暂停，不自动排入下一阶段；P4完成后再与用户讨论其他站点需求。

P4范围是变化通知、订阅规则、站内消息、事务Outbox、标准Web Push、PWA安装与更新。沿用Vue/Naive UI、Node24/SQLite及现有Chrome/CDP，不引入Playwright。开发预览独立部署，数据在自身data子目录，不读取或迁移旧P1/P2/P3账号档案。HTTPS由已有前置设施提供，当前不部署用户服务器或签发证书。

## 2. 通知生成与基线

通知生成必须在接受submission的同一SQLite事务中，与数据版本、事件、基线、收据及档案水位一起提交；HTTP推送发送在事务外。重复submission/原收据重放不再生成通知，STALE归档不生成业务变化通知。

首次完整采集按task/scope建立基线，只产生一条汇总消息，不逐条发送历史项目。首次partial可保存数据，但不建立完整基线、不发逐条历史提醒；随后完整采集发一条基线摘要。已有P2/P3数据库的历史事件不在升级时批量重放；新提交发生的变化才参与通知。

基线建立后，按新entity_version生成created/changed事件；相同内容和rank/stars/时间变化不发README更新。基线摘要按task/scope独立去重，业务通知按不可变version身份去重，两者不相互消耗资格。业务事件的来源任务固定为该version首次入库的run所属任务；规则taskIds筛选这个首次来源，不按后续重复观察重新匹配。通知一旦生成保留原run/version，后续观察不覆盖目标。

例如规则仅订阅B，A先写入新版本、B随后观察同版本，则不会为B补发该版本的created/changed通知；若B尚无完整基线，其第一次完整结果仍可按baseline规则产生B自己的摘要。这是首版单来源事件的明确取舍，不是“任意任务看到即提醒”。首次partial不创建已通知标记，其版本由该来源任务后续完整基线摘要覆盖；不会靠内容hash或ruleId标记为已通知。

A→B→A的新version可正常提醒，不把旧spool回放当变化。初次partial尚未通知的实体，在完整基线摘要中覆盖，不靠后续重复产生相同版本补通知。

## 3. 规则与站内消息

单管理员规则包括name、enabled、taskIds（空=全部）、eventTypes（baseline/created/changed）、keywords（可空）、pushEnabled。默认一条站内全来源规则，pushEnabled=false；站内通知不要求VAPID或浏览器授权。关键词匹配项目键、描述、README正文等受大小限制的业务字段，不匹配抓取时间；规则命中同一事件只生成一条站内消息，保留命中规则身份，避免多规则重复。

规则变更只影响之后事件，不把历史事件自动重新通知。通知保存id、kind、title/body简短摘要、run/entity/version目标、createdAt、readAt、dedupeKey及投递摘要；不保存一份重复README。分页列表不包含正文或推送订阅密钥。打开原通知时查看原run/版本，不用最新实体覆盖历史；无权限先登录，记录不存在时显示明确提示。

## 4. API协作契约

全部在 `/api/v1` 下，沿用管理员session及写请求Origin验证，不给worker通知管理权限。列表 `{items,nextCursor}`，limit默认50最大200，错误沿用安全错误码。

- GET/POST `/notification-rules`；PATCH/DELETE `/notification-rules/:id`：创建/更新/停用或删除规则，不能提交任意SQL、代码或文件路径。
- GET `/notifications?cursor=&limit=&unread=`：分页站内消息；GET `/notifications/unread-count` 返回 `{count}`；GET `/notifications/:id` 返回 `{notification}`；PATCH `/notifications/:id` `{read:true}`；POST `/notifications/read-all` 显式标记已读。
- GET `/push/config` 返回 `{configured,publicKey,enabled,reason}`，只含公钥与安全状态；POST `/push/subscriptions` `{subscription:{endpoint,keys:{p256dh,auth},expirationTime},deviceLabel}` 返回 `{subscription:{id,deviceLabel,enabled,...}}`；GET `/push/subscriptions` 只返回设备元数据；DELETE `/push/subscriptions/:id` 解除订阅。
- POST `/push/test` `{subscriptionId}` 需Idempotency-Key，仅向用户显式选定的设备产生明确kind=test的站内/设备测试通知，不能冒充业务采集事件；无配置/无设备返回可解释错误，不静默成功。前端无需自动调用测试接口。
- GET `/push/status` 返回投递循环健康、pending/retry/accepted/failed计数和固定错误码；不返回endpoint、auth或私钥。
- 登出增加可选 `subscriptionId`，在销毁session前解绑本设备；前端还尝试PushManager.unsubscribe，不将失败误称设备已成功退订。其他设备不受影响。

API中的具体字段在实现时保持前后端一致；若需调整，在本契约和相应测试中同步，不用大量隐式容错掩盖DTO不一致。

## 5. Outbox与设备投递

通知与Outbox事务内保存，按notificationId+subscriptionId唯一创建设备投递。业务投递入队要求 `configured && enabled`，且事件创建时至少一条命中规则授权push、至少一台有效设备存在。保存当时授权规则ID和设备ID快照，后来新规则或新设备不补历史。

发送及每次重试前重新核验全局开关、配置和设备有效状态，以及原授权规则中至少一条仍为enabled且pushEnabled；停用、关闭push或删除其中一条但另有原规则授权时仍可继续。全部原授权消失或全局关闭后，尚未发送投递终止为skipped，重新开启也不恢复旧投递。已经发出的网络请求不承诺可撤回。明确kind=test的投递不依赖业务规则，但同样要求全局开关、配置和选定设备有效。

单中心有界串行发送，发送前持久lease/尝试数，网络操作不持SQLite事务。成功只标记推送服务accepted，不能声称手机已展示或用户已读。404/410停用并清理失效订阅，429/5xx/超时有限退避（最多5次，Retry-After有界），401/403或413明确失败并保留诊断，不无限重试或删除全部设备。

进程在推送服务已接受但本地未记状态时重启，可能重复投递；使用稳定notificationId/topic/tag合并，明确至少一次而非端到端exactly-once。站内通知始终为事实记录。循环无任务时低频等待、配置/入库后唤醒，停止时取消或有界等待网络后关闭数据库。未配置push时站内功能正常，不把push禁用显示为整个服务故障。

## 6. VAPID、依赖与网络边界

使用已核对的 `web-push@3.6.7`（MPL-2.0）处理标准加密和VAPID，不自行拼接不完整的加密协议。服务端workspace只新增这一项明确依赖，审查间接依赖并锁版本；worker不安装前端/推送依赖。仍禁止直接/间接Playwright等框架。

VAPID私钥保存在部署 `data/config/vapid.json`，0600、与管理员密码和worker凭据分离；初始化只生成一次且不打印。subject由用户明确配置有效mailto或HTTPS联系方式，不写真实个人地址到仓库。P4默认 `PAGE_GATHER_PUSH_ENABLED=false`；缺少subject或密钥时configured=false，不能伪造发送成功。公钥可提供给已登录前端，私钥不进入API、日志、构建、Git或截图。备份和轮换需考虑已有设备重新订阅。

订阅只接受标准HTTPS端点、443、无凭据和片段，限制为已支持推送服务域（FCM、Mozilla Push、Apple Push的明确域/后缀）；拒绝任意用户URL和内部地址，不跟随跨域重定向。发送时继续验证域名解析为可公开路由地址，不能只靠注册时一次DNS检查。日志不输出订阅URL或密钥。测试使用注入传输与合成订阅，不向未知服务盲发。

## 7. PWA与前端

新增通知页、规则管理、设备/推送状态与安装引导；触控至少44px、375宽可用。manifest包含稳定id、name、start_url、scope、standalone、192/512图标。由浏览器能力检测决定按钮，不凭UA承诺设备支持。

Service Worker负责push展示、notificationclick深链接、公开静态app shell缓存和显式更新。只缓存版本化静态资源，API、认证响应、正文和通知数据永不进入SW/NGINX共享缓存；离线只展示公开shell/离线提示，不展示个人数据缓存。

请求通知权限和PushManager.subscribe只能由用户点击触发，不在页面加载、登录或安装时自动弹授权。拒绝/不支持/非安全上下文有明确状态和指引。iOS/iPadOS 16.4+需添加到主屏幕并从图标打开，再主动授权；真机行为需要用户后续验证。

每次收到push必须展示可见通知，包括无效载荷的通用回退提示；不做静默后台采集。锁屏载荷默认通用短摘要和安全应用路径，不携带README全文或敏感项目详情。点击只打开本应用允许路径，拒绝外站/脚本/双斜线跳转；需要登录时保留目标，已读由前端成功查看后回传。

新版本可提示更新，但不自动刷新未保存表单；用户确认后skipWaiting/刷新。登出清理个人前端状态及本设备绑定，不能清空其他设备。推送测试、安装和更新状态应可在页面查看，无需用户到console猜测。

## 8. 开发验证与人工验收记账

验证事务回滚、重复提交、基线/partial/多规则/跨任务去重、历史升级不回放、设备退订、Outbox lease重启/重试/失效清理、端点约束、加密payload构造、SW可见通知和安全深链接、静态缓存排除API、PWA更新与UI响应式。

开发WSL独立P4副本（建议18082管理页、16082浏览器），不复制旧用户数据、不开旧日程。一次真实GitHub低量采集可验证基线站内通知；变化和外部推送故障用隔离数据库/模拟传输，不向用户库塞入假项目。真实推送服务可用性以实际网络结果记录，不用mock或permission override冒称iPhone锁屏通过。

用户手工待办至少包括：P3界面/日程体验；P4站内通知体验；iPhone添加主屏幕、主动授权、锁屏/关闭PWA后推送及点击跳转。用户今天无空，因此这些保留待办，开发验收与人工验收分开。P5签到暂停，P4后讨论新站点再确定下一阶段。

参考：
- WebKit iOS Web Push：https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- web-push库：https://github.com/web-push-libs/web-push
- Service Worker push事件：https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/push_event

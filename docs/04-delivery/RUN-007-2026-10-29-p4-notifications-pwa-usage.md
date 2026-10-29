# P4 通知与PWA使用说明

> 文档编号：RUN-007 | 建立日期：2026-10-29 | 最后更新：2026-10-29
> 类型：使用手册 | 状态：开发交付完成；用户体验及外部推送/iPhone待验收

## 1. 范围与验收记账

P4提供站内通知、关注规则、设备订阅及PWA。即使不配置Web Push、不允许浏览器通知，也能登录查看站内消息。P3用户手工验收未执行，P4体验与iPhone真机验收也保留待办，见 [PLAN-002](../03-planning/PLAN-002-2026-10-29-current-execution-plan.md)。P5自动签到暂停，其他站点需求待P4后再讨论。

## 2. 站内通知与规则

通知中心支持全部/未读、分页、详情和全部已读。首次完整采集只有一条基线摘要，不逐条推送历史项目；之后按规则提醒新增或README重要变化。相同正文、重复提交和STALE归档不生成重复业务通知。规则变化只影响之后事件，不追溯通知旧数据。

规则可设置任务、baseline/created/changed事件类型、关键词与设备推送开关。任务过滤按版本首次入库的来源任务；同版本后来在另一个任务出现，不重新通知该版本。多条规则命中同事件只一条消息；基线摘要按task/scope独立。默认规则站内启用、设备推送关闭。

通知固定关联原run/version，点击不会用最新README替换历史正文。通知摘要不复制整份README。测试推送明确kind=test，不是采集结果。

## 3. 独立开发部署

使用Linux/WSL ext4中的完整部署目录，要求Python3、Docker/Compose、非root UID/GID1000:1000和Chrome沙箱。不能在Windows挂载盘存活动Chrome档案，不与旧P1/P2/P3共享data。

初始化保留旧文件，不覆盖账号密码或轮换VAPID：

```sh
bash scripts/init-p4.sh
```

该脚本先初始化P2私有数据，再用无网络、非root的Node辅助容器生成一次 `data/config/vapid.json`，权限0600，不输出密钥。Node辅助镜像可通过受信配置PAGE_GATHER_KEYGEN_IMAGE指定；现有文件的权限、配对、canonical编码错误时拒绝，不悄悄重建。

在部署根本地 `.env` 设置P4开发入口，例如：

```dotenv
CHROME_VERSION=156.0.8078.47-1
PAGE_GATHER_NODE_ENV=development
PAGE_GATHER_PUBLIC_ORIGIN=http://127.0.0.1:18082
PAGE_GATHER_COOKIE_SECURE=false
PAGE_GATHER_WEB_PORT=18082
PAGE_GATHER_P2_BROWSER_PORT=16082
PAGE_GATHER_NOVNC_ORIGINS=http://127.0.0.1:16082
VITE_BROWSER_PREVIEW_URL=http://127.0.0.1:16082/vnc.html
PAGE_GATHER_PUSH_ENABLED=false
PAGE_GATHER_VAPID_SUBJECT=
```

Chrome版本仅为已使用的完整版本，构建前确认官方仍可下载；不要认为所有旧包永久保留。启动：

```sh
docker compose -p page-gather-p4-dev -f compose.p2.yaml -f compose.p4.yaml config --quiet
docker compose -p page-gather-p4-dev -f compose.p2.yaml -f compose.p4.yaml build
docker compose -p page-gather-p4-dev -f compose.p2.yaml -f compose.p4.yaml up -d
```

站内页面入口为 **http://127.0.0.1:18082/**；已保留真实基线通知，验证边界见VER-005。用户名admin，密码在本地私有文件，用户在可信终端自行查看即可，不提供给助手：

```powershell
wsl -d Ubuntu-22.04 -- docker exec page-gather-p4-dev-server-1 head -n 1 /run/secrets/admin-password
```

`/run/secrets/...`为容器内约定路径，不是宿主真实路径。P4使用自己data/config的密码，不复用P3。测试日程默认关闭，P4开发不自动开启每日采集。

## 4. 启用设备推送

服务端先明确配置 `PAGE_GATHER_PUSH_ENABLED=true` 和有效的 `PAGE_GATHER_VAPID_SUBJECT`（用户自己的mailto或HTTPS联系方式），在没有活动采集时重新创建server容器以应用环境变量；仅 `docker restart` 不会读取新的.env：

```sh
docker compose -p page-gather-p4-dev -f compose.p2.yaml -f compose.p4.yaml up -d --force-recreate server
```

私钥继续来自只读挂载的VAPID文件，不写入.env或代码。当前默认false、subject为空是刻意保留，不能显示为已经可投递。

配置完成后，在页面主动点击“开启本机通知”，按浏览器授权并保存PushManager订阅。没有点击，不自动弹权限；拒绝后仍能看站内。设备列表仅元数据，不显示端点或密钥。旧会话重新登录后，可主动续绑当前浏览器的原订阅，不能仅凭设备ID代替授权。

“测试推送”只向本会话选定的本机设备创建测试消息，不广播其他设备。推送服务accepted只表示上游接受，不保证手机已展示或已读。锁屏载荷用通用简短提醒，登录后才能看账号内容。

当前支持FCM、Mozilla Push和Apple Web Push的明确端点范围，不接受任意URL。投递有限重试，失效设备清理；关闭规则push、删设备或全局关闭会撤销未发投递，重新开启不会补发旧消息。登出会尝试退订及解绑本设备，不影响其他设备；失败有提示，不伪称已经成功。

## 5. PWA、更新与离线

PWA提供manifest及图标，可使用浏览器安装/添加到主屏幕。新版本提示需用户确认后更新，不在未保存表单时自动刷新。只缓存公开app shell、精确版本化JS/CSS和图标；API、认证、README与通知数据不进入SW或NGINX共享缓存。离线只保证公开shell/提示，不承诺可读个人数据。

推送事件始终尝试显示通用可见通知，不做静默采集。点击只打开应用允许的通知页，需要登录则保留安全目标；前端成功读取后再标已读，不由SW绕过认证。

## 6. iPhone手工待办

iOS/iPadOS16.4起需把HTTPS站点添加到主屏幕，从图标打开后主动授权。Windows上的localhost不等于iPhone上的localhost；真机验证需用户以后安排设备可访问的既有HTTPS域名/NGINX入口，本轮不代部署或申请证书。

添加主屏幕、授权、锁屏/关闭PWA接收、点击跳转均未因mock、开发Chrome或权限覆盖而视为通过。用户今天无空，UAT账目保持待办，不阻塞开发。初次无推送配置时显示未配置/禁用是正常边界，不是站内通知故障。

## 7. 备份与限制

部署data内保存SQLite、Chrome档案及私有配置，Git和构建上下文排除它们；备份只放backups或部署外。VAPID私钥需随配置安全备份，丢失/轮换可能使设备重新订阅；不得复制活动Chrome目录宣称迁移一致。

正常停止全部服务并核验退出后再整体备份/迁移，保留权限、所有权和符号链接。当前开发预览保留运行，未经用户要求不清理旧预览或数据。

设计见 [DES-007](../02-design/DES-007-2026-10-29-p4-notifications-pwa.md)，实际结果与限制见 [VER-005](../05-verification/VER-005-2026-10-29-p4-notifications-pwa-verification.md)，评审见 [REV-007](../06-reviews/REV-007-2026-10-29-p4-notifications-pwa-review.md)。

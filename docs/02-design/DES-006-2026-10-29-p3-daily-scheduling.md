# P3 每日调度与稳定执行

> 文档编号：DES-006 | 建立日期：2026-10-29 | 最后更新：2026-10-29
> 类型：阶段设计 | 状态：已实现、已评审（开发验收证据见VER-004）

## 1. 已授权范围与默认值

用户已授权开始P3。当前真实插件为公开的GitHub Trending，不要求登录；本阶段新增每日调度、漏跑补偿、计划幂等、可见运行状态及恢复稳定性，不实现推送、签到或新的登录站点插件。P2手动执行和已封存投递保护必须继续有效。

每天具体时间尚未由用户指定。页面初始值为09:00、Asia/Shanghai，属于可编辑建议，不是用户已确认的日程；所有既有任务迁移后schedule.enabled=false，未经明确保存启用不自动访问网站。首次启用只安排未来时刻，不追补启用前的日程。

## 2. 用户与API契约

沿用任务GET/POST/PATCH接口，新增：

```json
{
  "schedule": {
    "enabled": false,
    "time": "09:00",
    "timezone": "Asia/Shanghai"
  }
}
```

schedule配置只接受这三个字段；服务端校验HH:mm和运行时支持的IANA时区，返回400而不是500。任务响应额外包括scheduleRevision、nextScheduledAt、lastScheduledFor及精简的scheduleStatus；这些都是中心派生字段，用户不能覆盖。任务enabled=false与schedule.enabled=false都会阻止未来自动运行，但不撤销正在运行的任务；单独取消才停止后续操作。手动运行不改变每日计划或水位。

GET `/api/v1/scheduler` 为管理员只读状态：enabled/healthy、lastTickAt、lastErrorCode、nextWakeAt、due/created/skipped摘要等，无SQL、路径、凭据和页面正文；健康接口仅提供不敏感的调度健康摘要。开发诊断可通过应用注入的clock和Store.tick(now)模拟时间，生产HTTP不提供任意改时、强制跑时钟或绕过认证的测试端点。

## 3. 持久化与幂等

计划使用独立SQLite表保存规范schedule、revision、下一次UTC时刻和历史处理摘要，避免依赖JSON全库扫描计算。任务新建/编辑与计划更新同一事务，迁移版本必须兼容P2现有数据库，不重置实体、任务、收据或档案水位。

自动run为trigger=scheduled，保留scheduledFor、scheduleRevision、task快照和实际createdAt；手动run仍trigger=manual。数据库唯一约束保护 `(task_id, scheduled_for)`，即使服务重启、两个调度循环或重复tick也不产生两次计划执行。run创建与推进nextScheduledAt在同一事务内提交，故障全部回滚。

修改时间/时区、启停schedule或task时，计划修订并从修改时刻重新安排未来一次，不把旧next当新计划漏跑。仅改任务名称或采集参数时保留下一次时刻，下次run使用创建时的最新参数快照；历史run不被修改。已QUEUED的旧自动run在调度被停用或时刻被修改时由中心改为SKIPPED，原因SCHEDULE_CHANGED，防止恢复任务enabled后执行旧计划；RUNNING不自动取消。若时刻后来改回同一UTCslot，唯一约束仍禁止该slot再次创建，按“同计划时刻至多一次”处理。

## 4. 漏跑、积压与人工模式

### 状态兼容契约

P3新增SKIPPED作为**中心独占的run终态**，只用于已创建但尚未开始的自动run：过期为SCHEDULE_EXPIRED、日程修改/停用为SCHEDULE_CHANGED。worker的outcome仍只允许P2原有SUCCEEDED/PARTIAL/FAILED/CANCELLED，不能通过请求伪造SKIPPED。claims只返回可执行QUEUED；旧claim-ticket重放若不再可执行只返回finalize_only，不开放新的页面访问。SKIPPED参与终态判断，不能在页面被当作运行中无限轮询。

尚未创建run的slot遇到同任务占用或超出窗口，只记调度摘要与原因，不额外创建可领取的“跳过任务”。用户手动取消仍为CANCELLED，不与日程SKIPPED混淆。DES-005的原P2状态集合是历史范围，P3扩展以本节为准。


- 固定补偿窗口24小时；持久next到期后，选最新的已到计划时刻，若其年龄不超过24小时才补一次，更早日程计入摘要并跳过，不逐日创建多年积压。
- 同一task若存在QUEUED/RUNNING/RECOVERING自动或手动run，则本次自动计划标记为被占用/跳过并推进到下一次，避免积压；跳过原因必须可见。自动调度不能抢占人工或任务锁。
- 若浏览器处于MANUAL/忙/离线，调度可以创建至多一个QUEUED自动run，worker原有锁继续阻止访问页面。自动run领取前再次核验任务/schedule仍启用、revision一致、scheduledFor不超24小时；过期队列转SKIPPED并记录原因，不再访问网站。
- 重启仅恢复持久计划和原run，不因重启制造新requestKey；旧claim-ticket、lease/fencing、SEALED重传及仅终结恢复仍由P2负责，不能在tick里释放档案锁或自动重抓OPEN。
- 暂停后恢复日程从新的未来时刻开始，不追补停用期间的任务。

## 5. 时区与夏令时

时间配置以IANA时区计算，当地日期与UTC scheduledFor均保存。对夏令时重复分钟只取较早一次；不存在的本地分钟顺延到当天首个有效时刻（例如02:30不可用则03:00），不能自动变成03:30。算法须用有界计算和缓存，不使用不断扫描每个UTC分钟的高CPU常驻循环。

至少验证Asia/Shanghai、UTC、America/New_York的缺失/重复时刻、跨年、闰日和小时/半小时偏移。原始规范时区保存在配置中，不假设服务器操作系统时区与用户计划相同。

## 6. 执行与错误策略

每日计划先使用插件现有有限只读重试和SDK预算；本阶段不增加无限整任务自动重跑。403/429/验证挑战、选择器变化保留partial/错误并等待用户，不通过循环访问解决。SEALED投递断网只重传；OPEN中断保持可见并走既有收尾，不绕过授权续采。界面提供上次结果、下一次时间、任务触发方式、漏跑/占用/过期原因与调度健康状态。

中心后台采用最近到期时间休眠、配置写入后唤醒、低频兜底检查及异常退避，不按毫秒轮询数据库。关闭HTTP服务时先停止timer与新调度，再等待短事务结束，不能关闭数据库后timer继续访问。维护循环失败更新lastErrorCode，不吞错后仍显示健康。

## 7. 本轮验收与边界

使用临时SQLite和可注入时钟，验证唯一slot、事务回滚、重启补最近一次、停用不补跑、参数/日程修改、占用跳过、过期不领取、manual不影响schedule，以及DST语义。真实WSL验收与原P1/P2用户预览及data隔离，故障使用合成fixture/临时库，不为测试改用户服务器时钟或放开测试HTTP。

开发预览更新要保留原P2数据库与账号文件，不自动开启旧任务的日程、不修改旧手动run。新增能力经Reviewer完整评审和修复复审后才标记开发完成。用户服务器以后自行部署；新站点真实登录、iPhone推送和签到均不在本轮已验证范围。

## 8. 技术依据

- Node国际化与ICU支持：https://nodejs.org/api/intl.html
- SQLite唯一索引语义：https://sqlite.org/lang_createindex.html

本轮使用运行时Intl时区数据和SQLite唯一约束，实际算法与迁移结果以VER-004为准；Node/ICU升级后仍需复测时区边界，不能以引用文档替代项目测试。

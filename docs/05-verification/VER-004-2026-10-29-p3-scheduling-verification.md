# P3 调度验证记录

> 文档编号：VER-004 | 建立日期：2026-10-29 | 最后更新：2026-10-29
> 类型：阶段验证 | 状态：开发验收完成（服务器与新站点登录不在本轮范围）

## 范围

每日计划、时区/DST、24小时最新一次补偿、唯一slot、任务/日程修改、人工/离线排队、过期领取检查、SQLite升级及低CPU调度循环。保留P2手动执行、claim-ticket、封存收据、水位、仅终结恢复等回归。

P3不新增站点登录、推送、签到或无限整任务重抓，不修改用户服务器时钟，不让测试接口出现在生产HTTP中。

## 验证结果

| 类别 | 目标 | 实际结果与证据边界 |
|---|---|---|
| 计划持久化 | P2数据库迁移，旧日程默认关，手动结果/收据不变 | 真实临时SQLite回归通过；旧P1/P2部署未被修改 |
| 幂等/事务 | 同slot唯一，创建run与next推进同事务 | 重复tick/重启/回滚回归通过；真实UTC slot仅1个run |
| 时区 | Shanghai/UTC/纽约缺失与重复/半小时/跨年闰日 | 算法回归通过；Store到前端GMT/CET/utc混合DTO回归通过 |
| 补偿 | 只补最近24h最新一次，停用期不补 | 可注入时钟和文件SQLite重启回归通过，未改系统时钟 |
| 竞争 | 同task占用只摘要；MANUAL不被抢占；过期不领取 | 真实Store/Poller/Controller合成回归通过，含修复后无多余run断言 |
| 修改 | 时间/时区/启停跳过旧排队，参数编辑保留next | SQLite/HTTP回归通过；开发任务测试后关闭，历史slot保留 |
| 稳定性 | 重启、错误退避、关闭停止timer，失败不显示健康 | timer故障回归通过，开发server重启后65秒无重复/补跑 |
| 开发集成 | 独立WSL P3副本、真实计划触发一次、旧环境不动 | 一次scheduled run成功1/1；原P1/P2检查前后均停止，未改变状态 |
| 页面 | 日程表单、下一次/trigger/skip、桌面及375宽 | 原生CDP截图与UI检查通过；SKIPPED来自隔离临时真实应用库 |
| 评审 | Reviewer完整审查和发现闭环 | 两项P2修复复审关闭，无剩余阻断；见REV-006 |

## 本地与Linux检查

初始211项测试虽通过，仍未覆盖首审发现的占用多建run、时区别名契约不一致，两项均补回归并修复。

修复后Node24.22.1完整214项：Windows213通过、1项POSIX进程组测试跳过、0失败；Vue类型与生产构建通过。独立WSL Linux完整214/214通过、0跳过，初始化临时测试4/4通过，Linux前端构建成功。文档和隐私检查通过。

Reviewer首审独立执行64项选定测试与前端构建；修复复审执行Web54项及相关调度10项。不将开发执行的完整Linux/线上结果写成Reviewer亲验。

## WSL最终集成

- 独立project为 `page-gather-p3-dev`，完整部署副本位于WSL ext4；全部持久化在该副本 `data/`，未复用原P1/P2数据库、密码或Chrome档案。
- 管理页 **http://127.0.0.1:18081/**，浏览器人工入口16081。P3三服务保留运行供用户验收。原P1/P2在本轮开始时已停止，结束保持其状态，不把它们描述为本次启动成功。
- 最终运行相关68个源码文件摘要与验收快照一致，server/web已包含两项评审修复。
- 实际版本：测试Node24.21.0、server Node24.22.1、worker Node24.15.0、Web构建Node24.22.2，Chrome156.0.8078.47、NGINX1.28.3。
- 通过正常任务API设置下一UTC分钟，未调用手动run接口、未改系统时钟或直改真实业务库。slot为 `2026-10-29T03:47:00.000Z`，65秒内创建并领取；trigger=scheduled，同slot1条，manual0条。
- 真实GitHub任务SUCCEEDED、1/1，1实体/1版本，README found、rendered_text长度12185字符。未打印正文、Cookie或凭据。HTTP2/QUIC兼容开关保持0，不用raw/API替代页面，没有反复重跑。
- 验证后已保存 `schedule={enabled:false,time:'09:00',timezone:'Asia/Shanghai'}`、nextScheduledAt=null，不让测试变成未经确认的持续日程。历史run保留UTC日程快照，不因当前任务改回Shanghai而被改写。
- 正常重启server后观察65秒，run/版本文档hash不变、没有重复或补跑，SQLite完整性检查通过。
- 24张1440/375截图覆盖表单、验证提示、下一次时刻、真实run/README/版本、SKIPPED隔离fixture与重启后状态。截图不包含已填写密码，存于本部署 `data/artifacts/p3-acceptance/`，不进Git。主agent复核日程表单、结果及移动任务卡。

## 证据索引与保留资源

本部署 `data/artifacts/p3-acceptance/summary.json` 为汇总，`scheduled-result.json` 为计划执行记录，`restart-checks.json` 为重启对照；日志/截图/源码摘要都仅本地保留。三个P3服务和data保留，临时UI/fixture容器及专用测试浏览器档案已清理，不影响实际采集档案。

## 结果与限制

本次完成P3开发与WSL验收，未操作用户服务器或真实GitHub账号。其他内核、网络和时区数据版本仍需用户以后部署核验，不作为当前开发门槛。README是页面文本，不承诺原始Markdown或原文件完整性。

跨日、十年漏跑、DST、回滚、调度错误与人工竞争使用可注入时钟/临时SQLite/合成页面验证，不宣称真实等待多天/十年或实际遭遇全部故障。窄屏的100%进度文字仍可能换行，无横向溢出，不阻断操作。

完整评审与修复记录见 [REV-006](../06-reviews/REV-006-2026-10-29-p3-scheduling-review.md)，使用入口见 [RUN-006](../04-delivery/RUN-006-2026-10-29-p3-daily-scheduling-usage.md)。当前测试日程关闭，用户选择实际时间后手动启用。

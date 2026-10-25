# P2 完整链路评审记录

## 范围

中心HTTP/认证/SQLite、worker任务接线与spool、Vue/NGINX、P2Compose、初始化及依赖锁。P3定时、P4推送、P5签到不在本轮；原P1预览与账户保持独立。

## 首轮发现

| 编号 | 级别 | 发现 | 状态 |
|---|---|---|---|
| P2-R1 | P1 | 过期OPEN无法终结/FAILED终态响应丢失被覆写错误码，永久pending | 仅终结恢复授权与不可变outcomeIntent修复，复审关闭 |
| P2-R2 | P1 | claims响应丢失后无本地run记录，档案锁孤立阻塞 | 持久ticket及workerId+requestKey事务去重修复，复审关闭 |
| P2-R3 | P2 | STALE独有项目无法从榜单查看已归档README，错误依赖实体存在 | 直接run快照drawer，不依赖实体，复审关闭 |
| P2-R4 | P2 | 实体列表携带双份大正文，弱CPU和手机负担大 | 仅元数据，详情单份正文，大文本体积回归，复审关闭 |
| P2-R5 | P2 | 实际worker未提供completed/total，页面数量进度不能工作 | 持久检查点推导计数及终态校准，复审关闭 |

首轮134项测试（Windows133通过/1POSIX跳过）及前端构建通过，但未覆盖上述真实失败路径；不能以原测试全过宣称修复。Reviewer通过真实Store和Poller补充复现确认，完整结论需修复复审。

## 修复方向

领取前持久化claim requestKey，中心事务绑定原领取，响应丢失可取回；非SEALED使用仅终结授权，不开放续采；终态发送意图持久化并原样重放。实体列表不传正文，原run归档直接打开；进度从持久队列的已处理项目计数。

## 开发环境验证与复审

最终Reviewer修复复审通过：原5项关闭，无新确认P1/P2，具备P2开发交付条件。Reviewer独立执行148项（Windows147通过/1POSIX跳过）、依赖/隐私检查和Vue类型/构建。真实HTTP回归覆盖中心已提交但响应丢失，非宽松FakeApi。

最终WSL修复版148/148通过，server/worker/web镜像重建；GitHub新运行SUCCEEDED、榜单3/README3、终态进度3/3；历史结果保留，两次运行仍为3实体/3版本/3事件。默认Chrome网络参数访问成功，compat开关0。桌面与375宽截图复核通过。最终验收详细记录见 [P2验证记录](../P2-verification.md)。

正常路径、故障回归与Reviewer复审共同支持P2开发环境交付完成；不将服务器部署或P3–P5计为本轮已实现。Reviewer未亲自重跑Docker/线上GitHub，不操作用户服务器；原P1预览保持独立。

# P2 验证记录

## 当前状态

P2开发环境闭环已完成，Reviewer完整评审及修复复审通过。修复后WSL镜像重建、真实GitHub采集、持久化与页面验证通过；保留独立开发预览供用户查看。服务器部署验收以后由用户进行，不作为当前开发门槛。原P1预览未接管、未共享档案。

## 本地检查

- `npm test`：修复后148项，Windows147通过、1POSIX专属跳过、0失败（首轮134项不足以覆盖补充发现，最终以148项为准）。
- 中心及真实HTTP恢复回归包含HTTP登录/Origin、worker凭据隔离、SQLite幂等与提交水位、旧spool恢复、取消、正文版本引用去重；补充中心提交后丢弃claim/outcome响应、过期OPEN取消及中心重启故障用例。
- worker任务测试覆盖任务锁、claim-ticket→collection→seal→submit→outcome、网络响应丢失、SEALED恢复不重新访问网页、仅终结恢复、413、取消及停机，实际进度从持久检查点推导。
- 前端5项快照helper测试覆盖STALE独有项目、按queueKey关联、不借用其他版本正文、pending/failed和缺失判定。
- `npm run web:build`：Vue类型检查和Vite静态构建通过。
- 初始化在WSL独立临时目录4项通过，覆盖私有凭据创建/重复执行不覆盖及权限/链接拒绝。
- 新增前端依赖经根工作区锁定，server/worker使用Node原生功能；依赖检查仍禁止直接/间接Playwright等框架。

隐私启发式扫描、文档链接与git whitespace在交付前再次执行。单元和模拟测试不替代真实Chrome、NGINX或用户界面验收。

## Reviewer

完整评审发现2P1和3P2均已修复，最终复审通过，无剩余阻断，见 [P2完整评审记录](reviews/p2-integration-review.md)。Reviewer独立复跑Windows检查和前端构建，不将开发执行的Docker/线上结果称为Reviewer亲验。

## 真实开发环境初测

独立WSL ext4部署、项目page-gather-p2-dev，前端18080、独立worker桌面16080，不共用P1档案。server Node24.22.1、worker Node24.15.0、Chrome156.0.8078.47、NGINX1.28.3。初测3项目/3README成功，幂等请求与同包重传不新增版本；server/worker正常重启后数据保留。默认HTTP2网络可访问GitHub，无需开启兼容参数。初测发现进度0/未知，已修复；最终镜像进度与新增148项Linux复验待回填。

## 最终开发验收

最终修复版在WSL ext4部署副本执行，Compose project `page-gather-p2-dev`。关键源码hash与同步清单一致，保留旧数据库，没有以空data覆盖。

| 项目 | 实测结果 |
|---|---|
| 镜像 | server/web/worker全部重建成功 |
| Linux测试 | 148/148通过，0失败、0跳过 |
| 初始化临时测试 | 4/4通过，不修改活动data |
| 前端 | Linux按根lock执行npm ci及Vue类型/生产构建通过 |
| 入口 | Windows侧18080及/api/v1/health为200；NGINX静态页面/API同源 |
| 真实GitHub | 手动任务3项目/5000ms，SUCCEEDED；完整snapshot3、README3 |
| 正文 | 三份字符数7551、5428、4499；不打印全文或凭据 |
| 数量进度 | 新运行终态3/3落盘、页面100%；中间轮询未取得有效计数样本，不将其称为实测连续进度 |
| 去重 | 重复run requestKey返回原run；重复claim requestKey返回同run/finalize_only；同SEALED包重复提交返回原收据 |
| 数据库 | 两次实际运行后2runs、2collections、2submissions；3entities、3versions、3events，第二次相同正文不新增版本 |
| 恢复与重启 | server/worker正常重启后两次结果完整保留；recover为replay_receipt，无额外页面访问 |
| 页面 | 桌面榜单与README抽屉、375宽移动卡片/运行快照抽屉已截图复核，无横向溢出；未截图密码表单 |
| 资源 | web/server running、worker Docker healthy，API健康200；server/web没有配置Docker healthcheck，不称Docker healthy |
| P1隔离 | 原6080预览未操作，P2独立profiles/database/config/spool |

版本：server Node24.22.1，worker Node24.15.0，Chrome156.0.8078.47（deb156.0.8078.47-1），NGINX1.28.3。P2默认HTTP2/QUIC参数已成功访问GitHub，兼容开关均保持0；先前SDK临时网络参数限制不再用于本轮正常链路结论，但不保证所有宿主网络兼容。

截图和汇总位于本部署data/artifacts，仅本地保留、不进Git；最终桌面run显示3/3，移动README使用“本次运行·项目README”抽屉。当前SQLite只有公开仓库内容，config和Chrome档案仍按敏感数据保护。凭据由用户在自己的可信终端读取，不写入文档或聊天。

领取响应丢失、过期OPEN收尾、outcome响应丢失、STALE无实体查看等故障通过真实HTTP/Store/临时spool回归验证，未向真实展示库注入伪造故障数据。Reviewer独立检查代码及Windows测试，不声称亲自执行上述Docker/线上验收。

## 保留入口与限制

开发管理页面 **http://127.0.0.1:18080/**，用户名admin；登录方式见 [P2使用说明](P2-usage.md#2-登录管理页面)。P2浏览器16080只有人工模式时开放，默认任务可领取状态下不开桌面入口。保留web/server/worker运行；旧P1 Chrome预览6080仍独立。

本轮未实现每日自动调度、PWA推送或签到。README为rendered_text，原文件完整性/原始Markdown不作承诺。OPEN不自动授权续采、附件接口明确501，均如使用说明所述；本轮完成的是手动采集、可靠上报、SQLite去重和可见效果。没有操作实际服务器或真实网站账号。

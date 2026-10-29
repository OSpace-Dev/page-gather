# Page Gather / 拾页

个人网站采集项目，采用真实有界面 Google Chrome 与直接 CDP，复用用户在该浏览器手动登录的持久目录。默认将运行数据绑定到部署目录 `./data/{profiles,spool,artifacts}`，SQLite使用 `./data/database`；不依赖默认 Docker 命名卷。不会保证防检测或不封号。

**P1–P3开发交付、WSL验收和Reviewer评审均已完成。当前预览为P3管理页18081，支持每日计划、手动采集、榜单和README查看。日程默认关闭，只有用户保存启用后才自动运行。P4推送与P5签到尚未开始；服务器部署以后由用户执行。**

## 计划与文档入口

- **[当前执行计划：接下来做什么](docs/03-planning/PLAN-002-2026-10-29-current-execution-plan.md)**
- **[交付路线图：P0–P5阶段安排](docs/03-planning/PLAN-001-2026-10-25-delivery-roadmap.md)**
- **[文档总导航：需求、设计、计划、手册、验证、评审](docs/README.md)**

文件按类型编号和建立日期归档，维护规则见 [AGENTS.md](AGENTS.md#文档维护与命名规范)。P3已开发交付，实际每日时间由你确认后在页面启用，执行与后续阶段状态统一维护在PLAN-002。

## P3 每日计划与当前预览

- 管理页：**http://127.0.0.1:18081/**，用户名admin；该P3副本使用独立私有密码文件。
- [RUN-006 P3使用与登录说明](docs/04-delivery/RUN-006-2026-10-29-p3-daily-scheduling-usage.md)。
- [VER-004 开发验证](docs/05-verification/VER-004-2026-10-29-p3-scheduling-verification.md)与[REV-006 完整评审](docs/06-reviews/REV-006-2026-10-29-p3-scheduling-review.md)。
- 已保存一次真实每日触发结果（1项目/1README），测试后日程关闭，填写值09:00/Asia/Shanghai，不会未经确认持续运行。
- P3独立部署和data，不共享原P1/P2档案；原两个环境本轮检查时已停止，未被启动或改变状态。

## P2 页面与采集效果（历史交付入口）

- P2历史开发入口：**http://127.0.0.1:18080/**，是否可访问以旧环境实际运行状态为准；当前请优先使用上方P3预览。
- [P2使用与登录说明](docs/04-delivery/RUN-005-2026-10-25-p2-usage.md)：用户名admin，密码在本地私有文件，不写入仓库或聊天。
- [P2验证记录](docs/05-verification/VER-002-2026-10-25-p2-development-verification.md)及[完整评审记录](docs/06-reviews/REV-005-2026-10-25-p2-integration-review.md)。
- `compose.p2.yaml`：独立server（Node/SQLite）、web（Vue/NGINX）、browser-worker（Chrome/CDP），全部持久化位于该部署副本data内。

P2浏览器入口16080仅人工模式开放；原P1预览6080保留，不共享账号档案。接入真实服务器及后续阶段时再按相应文档执行。

## P1 快速入口

- [部署目录持久化说明](docs/04-delivery/RUN-004-2026-10-25-deployment-storage-migration.md)：data 子目录、初始化、旧卷迁移和校验。
- [WSL 开发环境直观验收](docs/04-delivery/RUN-003-2026-10-25-p1-local-preview.md)：访问保留的 Chrome 容器及人工模式操作步骤。
- [P1 中文使用说明](docs/04-delivery/RUN-001-2026-10-25-p1-usage.md)：amd64 容器构建、人工 noVNC、显式 CLI、持久化、安全边界和验收步骤。
- [P1 服务器部署手册](docs/04-delivery/RUN-002-2026-10-25-p1-server-deployment.md)：由用户亲自部署，复用现有设施，不涉及远程代部署。
- [P1 开发评审记录](docs/06-reviews/REV-003-2026-10-25-p1-development-review.md)：完整评审、问题修复和最终复审结论。
- [P1 验证记录](docs/05-verification/VER-001-2026-10-25-p1-development-verification.md)：准确区分已验证、静态检查、待验证和限制。
- `infra/browser/Dockerfile`、`compose.yaml`：Chrome/Xvfb/Openbox/VNC/noVNC/Node 同容器，非 root，CDP 仅容器 loopback，noVNC 只发布宿主 loopback。
- `apps/worker/src/`：原生 WebSocket CDP SDK、互斥控制器、进程监督与显式 CLI。零第三方 npm 依赖。

```sh
npm ci --ignore-scripts
npm run check
```

需 Node 24；Docker 启动需明确指定可用的完整 Chrome deb 版本，详见使用说明。开发环境允许使用 WSL 内 Docker；容器、沙箱及远程桌面的实际验证结果见验证记录。真实服务器由用户亲自部署，真实账号登录只能由用户验证。

## P2 流程插件基础

- [插件流程设计](docs/02-design/DES-004-2026-10-25-plugin-workflows.md)：插件自行控制分支、循环、间隔和检查点，不限定为选择器配置。
- [SDK接口与边界](packages/plugin-sdk/README.md)：OPEN续采、SEALED封存、取消/限速及受信页面租约。
- `plugins/github-trending/`：冻结榜单，串行读取README，独立保存榜单与正文来源。
- [本轮评审和验证](docs/06-reviews/REV-004-2026-10-25-p2-plugin-workflow-review.md)：记录插件基础代码的设计及修复复审；其中早期网络限制以该报告范围为准，完整P2的后续实测见VER-002。

完整P2已接通中心和worker，收据、水位、seal与版本存储均有实现及回归；P2仍不自动续采OPEN工作检查点，已SEALED则只重传。SDK本身不绕过平台租约或接管MANUAL预览。

## 分类文档

全部文档编号、日期及链接集中维护在 [文档总导航](docs/README.md)，不在多个入口复制登记表。图形编辑源和预览见 [图形导航](docs/07-diagrams/README.md)。

需求与设计目录保留基线和机制说明；当前已实现范围以阶段验证记录及当前执行计划为准。P3每日调度已交付，P4推送与P5签到尚未实现。服务器部署与真实账号验证由用户在后续适当时间执行，不作为当前开发交付或下一开发阶段的前置门槛。

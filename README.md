# 浏览器自动化与数据中心

本仓库当前处于设计阶段。目标是为个人账号提供每天运行的网站采集、少量签到操作、数据查看和 iOS PWA 通知。面向 CPU 资源较低、内存充足的服务器，默认采用 SQLite 嵌入中心服务，浏览器任务串行运行。浏览器控制使用直接 CDP，不使用 Playwright。

## 文档入口

1. [需求与功能设计](docs/01-product-design.md)：范围、使用流程、页面、验收标准。
2. [系统架构设计](docs/02-architecture.md)：部署、浏览器会话、调度、恢复、安全和技术决策。
3. [插件、数据与接口设计](docs/03-contracts.md)：插件边界、数据模型、接口及幂等协议。
4. [实施与验证计划](docs/04-delivery-plan.md)：分阶段落地、验证场景和待确定事项。
5. [图形设计说明](docs/diagrams/README.md)：可编辑 draw.io 图和阅读指引。
6. [设计评审记录](docs/reviews/design-review.md)：评审意见、P1 修订方案与暂缓项。
7. [技术选型与容量评估](docs/05-technology-evaluation.md)：SQLite 增长、Vue/React 与组件库、现有 NGINX 接入及 Chrome 容器边界。

设计版本：v0.1。用户已确认的约束见需求文档，其余默认值是建议，可继续讨论调整。此版本不包含业务实现、实际站点账号或凭据。

推荐阅读顺序：需求 → 架构图 → 架构说明 → 执行流程图 → 接口设计 → 实施计划。

# Page Gather / 拾页

个人网站采集项目，采用真实有界面 Google Chrome 与直接 CDP，复用用户在该浏览器手动登录的持久目录。不会保证防检测或不封号。

**阶段：P1 开发交付及开发环境合成验收完成，Reviewer 完整评审通过；WSL 容器保留供用户直观验收。服务器部署验收以后再做，不是当前开发门槛。P2–P5 未实现。** 当前没有中心服务、Web 管理端、每日调度、业务采集插件、入库或推送，不会默认访问真实站点或自动点击。

## P1 快速入口

- [WSL 开发环境直观验收](docs/P1-preview.md)：访问保留的 Chrome 容器及人工模式操作步骤。
- [P1 中文使用说明](docs/P1-usage.md)：amd64 容器构建、人工 noVNC、显式 CLI、持久化、安全边界和验收步骤。
- [P1 服务器部署手册](docs/P1-deployment.md)：由用户亲自部署，复用现有设施，不涉及远程代部署。
- [P1 开发评审记录](docs/reviews/p1-development-review.md)：完整评审、问题修复和最终复审结论。
- [P1 验证记录](docs/P1-verification.md)：准确区分已验证、静态检查、待验证和限制。
- `infra/browser/Dockerfile`、`compose.yaml`：Chrome/Xvfb/Openbox/VNC/noVNC/Node 同容器，非 root，CDP 仅容器 loopback，noVNC 只发布宿主 loopback。
- `apps/worker/src/`：原生 WebSocket CDP SDK、互斥控制器、进程监督与显式 CLI。零第三方 npm 依赖。

```sh
npm ci --ignore-scripts
npm run check
```

需 Node 24；Docker 启动需明确指定可用的完整 Chrome deb 版本，详见使用说明。开发环境允许使用 WSL 内 Docker；容器、沙箱及远程桌面的实际验证结果见验证记录。真实服务器由用户亲自部署，真实账号登录只能由用户验证。

## 设计文档

1. [需求与功能设计](docs/01-product-design.md)
2. [系统架构设计](docs/02-architecture.md)
3. [插件、数据与接口设计](docs/03-contracts.md)
4. [实施与验证计划](docs/04-delivery-plan.md)
5. [技术选型与容量评估](docs/05-technology-evaluation.md)
6. [图形设计说明](docs/diagrams/README.md)
7. [设计评审记录](docs/reviews/design-review.md)

01–05 为原设计基线；其中“当前仅设计”等历史描述指设计交付时点。本轮只按用户授权新增 P1 最小实现，不代表其中中心服务、幂等上报、水位、调度、通知等设计已落地。服务器部署和真实账号验证由用户在后续适当时间执行，不作为当前开发交付或下一开发阶段的前置门槛。

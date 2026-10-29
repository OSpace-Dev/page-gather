# 文档总导航

> 更新日期：2026-10-29。按开发生命周期组织，阶段内迭代维护。
> 当前基线：P0设计、P1和P2开发交付已完成；P3–P5未开始。服务器以后由用户部署，不阻塞开发。

## 先找执行计划

| 你要做什么 | 从这里开始 |
|---|---|
| **看接下来做什么、哪些事还没开始** | **[PLAN-002 当前执行计划](03-planning/PLAN-002-2026-10-29-current-execution-plan.md)** |
| **看P0–P5阶段与交付边界** | **[PLAN-001 交付路线图](03-planning/PLAN-001-2026-10-25-delivery-roadmap.md)** |
| 打开P2页面、登录、手动采集和查看README | [RUN-005 P2使用说明](04-delivery/RUN-005-2026-10-25-p2-usage.md) |
| 找WSL Chrome桌面及人工模式操作 | [RUN-003 P1本地预览](04-delivery/RUN-003-2026-10-25-p1-local-preview.md) |
| 查是否真实验证通过、有哪些限制 | [VER-002 P2验证记录](05-verification/VER-002-2026-10-25-p2-development-verification.md) |
| 查评审发现及修复结果 | [REV-005 P2集成评审](06-reviews/REV-005-2026-10-25-p2-integration-review.md) |
| 看目录、文件名、编号与日期规则 | [AGENTS.md 文档维护规范](../AGENTS.md#文档维护与命名规范) |

## 目录地图

```text
docs/
  README.md             # 总导航：先找计划，再找分类文档
  01-requirements/      # REQ：需求与范围
  02-design/            # DES：架构、契约、技术选型
  03-planning/          # PLAN：路线图、当前执行计划
  04-delivery/          # RUN：使用、预览、部署、迁移手册
  05-verification/      # VER：实际验证记录与待验收场景
  06-reviews/           # REV：评审、修复与复审证据
  07-diagrams/          # FIG：原生图源与预览
```

## 文档登记表

文件名统一为 `类型-三位编号-建立日期-英文短名`；更新日期在文档头，不反复重命名。2026-10-25为既有文档Git首次提交日期，2026-10-29为本次整理及新计划建立日期，不回填虚构的旧日期。

### 01 需求

| 编号 | 文档 |
|---|---|
| REQ-001 | [需求与功能设计](01-requirements/REQ-001-2026-10-25-product-requirements.md) |

### 02 设计

| 编号 | 文档 |
|---|---|
| DES-001 | [系统架构](02-design/DES-001-2026-10-25-system-architecture.md) |
| DES-002 | [插件、数据与API契约](02-design/DES-002-2026-10-25-plugin-data-api-contracts.md) |
| DES-003 | [技术选型与容量评估](02-design/DES-003-2026-10-25-technology-capacity-evaluation.md) |
| DES-004 | [流程插件与GitHub采集设计](02-design/DES-004-2026-10-25-plugin-workflows.md) |
| DES-005 | [P2实施接口契约](02-design/DES-005-2026-10-25-p2-implementation-contract.md) |

### 03 计划

| 编号 | 文档 | 维护边界 |
|---|---|---|
| PLAN-001 | [交付路线图](03-planning/PLAN-001-2026-10-25-delivery-roadmap.md) | 长期P0–P5方向与阶段边界 |
| PLAN-002 | [当前执行计划](03-planning/PLAN-002-2026-10-29-current-execution-plan.md) | 当前状态、下一步、待确认项与完成判据 |

### 04 交付手册

| 编号 | 文档 |
|---|---|
| RUN-001 | [P1使用说明](04-delivery/RUN-001-2026-10-25-p1-usage.md) |
| RUN-002 | [P1服务器部署手册（以后部署时使用）](04-delivery/RUN-002-2026-10-25-p1-server-deployment.md) |
| RUN-003 | [P1本地预览](04-delivery/RUN-003-2026-10-25-p1-local-preview.md) |
| RUN-004 | [部署目录持久化与迁移](04-delivery/RUN-004-2026-10-25-deployment-storage-migration.md) |
| RUN-005 | [P2使用与开发预览](04-delivery/RUN-005-2026-10-25-p2-usage.md) |

### 05 验证

| 编号 | 文档 | 注意 |
|---|---|---|
| VER-001 | [P1开发验证记录](05-verification/VER-001-2026-10-25-p1-development-verification.md) | 原阶段实测与限制 |
| VER-002 | [P2开发验证记录](05-verification/VER-002-2026-10-25-p2-development-verification.md) | 完整链路实测与限制 |
| VER-003 | [跨阶段验收场景矩阵](05-verification/VER-003-2026-10-29-cross-phase-acceptance-matrix.md) | 包含未来场景，不代表全部通过 |

### 06 评审

| 编号 | 文档 |
|---|---|
| REV-001 | [原始设计评审](06-reviews/REV-001-2026-10-25-design-review.md) |
| REV-002 | [技术选型评审](06-reviews/REV-002-2026-10-25-technology-review.md) |
| REV-003 | [P1开发评审](06-reviews/REV-003-2026-10-25-p1-development-review.md) |
| REV-004 | [P2插件流程评审](06-reviews/REV-004-2026-10-25-p2-plugin-workflow-review.md) |
| REV-005 | [P2完整链路评审](06-reviews/REV-005-2026-10-25-p2-integration-review.md) |

### 07 图形

图源、PNG预览及维护说明见 [图形导航](07-diagrams/README.md)。图源与预览共用编号：

| 编号 | 图源 | 预览 |
|---|---|---|
| FIG-001 | [系统架构](07-diagrams/FIG-001-2026-10-25-architecture.drawio) | [PNG](07-diagrams/FIG-001-2026-10-25-architecture.drawio.png) |
| FIG-002 | [每日执行与恢复](07-diagrams/FIG-002-2026-10-25-execution-flow.drawio) | [PNG](07-diagrams/FIG-002-2026-10-25-execution-flow.drawio.png) |
| FIG-003 | [核心数据关系](07-diagrams/FIG-003-2026-10-25-data-model.drawio) | [PNG](07-diagrams/FIG-003-2026-10-25-data-model.drawio.png) |

图形是架构设计视图，不自动证明对应能力已实现；实际状态看VER与当前执行计划。生成器在 `scripts/docs/generate-diagrams.py`。

## 本次整理记录

2026-10-29按生命周期移动原文档，保留历史需求、验证与评审内容。新增当前执行计划，原路线图中的长验证矩阵独立为VER-003；修复相对链接和源码README引用，统一图源/预览及生成脚本路径。命名与维护规则写入AGENTS，后续以本登记表分配编号，不再在docs根目录散放P1/P2文件。

本次文档整理经Reviewer复审通过；图形日期校验遗漏已修复，6项工具回归通过。实际检查21份正式文档、3张图、123处本地链接/标题锚点，无错误；PNG内嵌图形标签与图源一致，隐私扫描通过。以上仅为文档与工具检查，没有重跑业务验收或启动P3。

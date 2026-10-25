# 部署目录绑定持久化修订

## 当前方案

持久化从 Docker 命名卷改为部署目录子目录 bind mount：

| 宿主相对部署目录 | 容器内约定路径 | 用途 |
|---|---|---|
| ./data/profiles | /data/profiles | Chrome 档案 main/ 和 worker 状态 |
| ./data/spool | /data/spool | 暂存，P1 仅预留 |
| ./data/artifacts | /data/artifacts | 诊断截图 |
| ./data/database | /data/database | 后续中心服务 SQLite，P1 未使用 |

前三个挂载均 `create_host_path: false`，先用 `bash scripts/init-data.sh` 初始化；脚本只初始化当前部署根内固定目录，拒绝已有错误权限，不递归改权。要求 Linux/WSL、Python3、当前用户1000:1000及0700目录，实测 Unix权限、Chrome符号链接和Unix socket能力。

代码与data可以在停止服务后一起复制迁移，需保留符号链接、所有权和权限。跨机器网站会话仍可能要求重登。data、部署来源标记、备份不进入Git或Docker构建上下文。

## WSL 预览迁移实测

Windows 挂载盘未通过初始化能力检查，未放宽权限。将完整部署副本放在WSL ext4，data仍在该部署副本内部，不采用部署外部的数据位置。源码checkout与运行部署副本是两个目录，操作入口见 [直观验收说明](P1-preview.md)。

迁移过程正常停止Chrome，三个旧命名卷只读复制到新空目录，逐项比较内容SHA256、条目类型/权限/所有权、符号链接与硬链接关系，校验全部通过。不打印档案内容、不访问真实站点，不自动改写登录状态。三个原命名卷完整保留，作为回退依据，不再是当前运行数据源。

迁移后容器检查：三个挂载均为bind且来自同一部署目录内data；health通过，恢复MANUAL，预览仍为 http://127.0.0.1:6080/vnc.html 。用户可能已在预览手动登录，不能将新data或原卷视为公开的纯合成资料。

## 验证

- 初始化及Compose边界12项通过：创建、重复执行、已有错误权限/所有权拒绝、目录链接拒绝、权限与链接/socket能力、备份忽略和集成复制排除。`create_host_path:false` 是Compose规范化配置的静态契约检查，不宣称已实测缺失源目录启动行为。
- Linux50项回归通过；Windows49通过、1 POSIX跳过。
- 真实bind集成通过：有效Chrome沙箱、CDP、noVNC输入与撤销、Origin防护、正常停止、同目录重建Cookie/localStorage持久化。
- 自动集成使用唯一project、独立临时部署根和默认16080端口，测试data在自己的部署根，不触碰6080人工预览与用户data。

以上开发验证不等于真实网站会话或服务器部署验收；当前不要求进行服务器验收。普通复制活动Chrome目录不能作为一致性迁移。

## 评审

首轮本轮评审发现两项P2和一项P3：部署内备份缺少忽略规则、备份步骤未确认正常停机、当前修订评审状态表述不清。已补齐backups及归档的Git/Docker/临时副本排除，备份前校验Running/PID/ExitCode为false/0/0，并限定原评审与本轮修订状态；12项安全临时测试通过，Reviewer修复复审通过，两项P2及一项P3均已关闭，未发现新增阻断项。Reviewer独立复跑两项新增排除测试；完整12项、真实bind集成及迁移校验属于开发执行结果，Reviewer未重新操作用户预览或档案。

旧卷不自动删除，回退时要先停止新容器，并考虑迁移后新data可能已产生新登录状态，不能简单覆盖。

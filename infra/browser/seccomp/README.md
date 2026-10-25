# Chrome user namespace 的项目级 seccomp 例外

此目录仅供本项目 Linux **amd64** Chrome worker 使用；不修改 Docker daemon，不添加 capability，不使用 privileged，不关闭 Chrome 沙箱。当前依据为实测 Docker Engine **28.3.3**。升级 Engine、Chrome 或内核后必须重新审阅和验收，不能将固定旧 profile 当成未来 Engine 的最新默认策略。

## 来源与可审阅差异

- 官方基线：[Moby v28.3.3 default.json](https://github.com/moby/moby/blob/v28.3.3/profiles/seccomp/default.json)，原样保存为 `moby-v28.3.3-default.json`。
- 基线文件 SHA256：`01536f1d1df938ae611eba20d6349e0de7a99b6ecdee1549427a0b01b8301e28`。
- 官方许可保留于 `LICENSE.moby`（Apache-2.0）。派生文件为 `chrome-userns-amd64.json`。
- [Docker 官方 seccomp 说明](https://docs.docker.com/engine/security/seccomp/)解释默认策略为何限制 namespace 系统调用。官方基线实际将 namespace clone、unshare、setns 的放行条件关联到 CAP_SYS_ADMIN；本项目不授予该 capability。
- [Chromium NamespaceSandbox 源码](https://chromium.googlesource.com/chromium/src/+/1d17a2e2ee147bb7d6ae2ab6abdb3a2510c17775/sandbox/linux/services/namespace_sandbox.cc)的 namespace 类型为 USER/PID/NET，另通过 PID namespace fork 建立沙箱。可参考[官方 Linux sandbox 说明](https://chromium.googlesource.com/chromium/src/+/main/docs/linux/sandboxing.md)。源码用途是解释所需标志，实际放行范围以下述 Chrome 实测为准。

保留原基线全部规则，只在末尾增加两条 amd64 条件规则：

| 调用 | 新增允许条件 | 保留的限制 |
|---|---|---|
| `clone` | 参数 0 满足 `(flags & 0x0e020000) == 0` | 从原 namespace mask `0x7e020000` 仅移除 USER `0x10000000`、PID `0x20000000`、NET `0x40000000` 三位；MOUNT、CGROUP、UTS、IPC namespace 标志仍被过滤 |
| `unshare` | 参数 0 **精确等于** `CLONE_NEWUSER (0x10000000)` | 不允许 unshare 其他标志或组合 |

没有新增 `setns` 规则；`clone3` 保留无 CAP_SYS_ADMIN 时返回 ENOSYS 的原规则。没有新增 mount、ptrace、bpf 等权限。seccomp 只能过滤调用及标量参数，不能按“Chrome 进程”识别调用者；这两条例外适用于容器中所有进程，并扩大 user namespace 的内核攻击面。它们仍需宿主的 userns/LSM 支持，不能绕过 AppArmor 或内核禁令。

在仓库根运行以下命令可重建或只读校验差异，无需第三方包：

```sh
node scripts/derive-chrome-seccomp.js --check
# 审阅规则后重建：
node scripts/derive-chrome-seccomp.js
```

生成器校验基线原始字节的 SHA256，并确定性追加上述规则；`--check` 比较完整派生文件。Compose 只给本服务指定此 profile。实际验收脚本另核对运行中容器的 profile 与文件内容相等，且 `Privileged=false`、没有 capAdd。

## 本次诊断证据

所有临时容器均使用项目 image、非 root node 用户、合成临时 profile、无发布端口，并带 `page-gather-p1-dev` project 标签；诊断结束已删除。

| 安全策略 | 实际现象 |
|---|---|
| Docker builtin 默认 | `unshare -Ur true` 失败 EPERM；Chrome namespace 初始化失败 |
| **仅临时诊断** `seccomp=unconfined` | `unshare -Ur true` 与 `unshare -Urnpf true` 成功；此配置没有写入 Compose 或验收默认 |
| 官方基线 + 仅 allow unshare | userns 成功，Chrome 仍失败 |
| 官方基线 + 仅 allow clone | userns 失败，Chrome 仍失败 |
| 官方基线 + allow clone/unshare | Chrome 启动；setns 无须放行 |
| clone 限 USER/PID/NET，unshare 限 USER | Chrome 实际启动且 `chrome://sandbox` 显示 Namespace、PID/NET、Seccomp-BPF、TSYNC 全部有效 |
| clone 不允许 USER（只允许 PID/NET） | Chrome 仍失败 |

WSL 宿主 `unshare -Ur true` 成功，`user.max_user_namespaces=63293`。Docker security options 自报 seccomp builtin/cgroupns；`/sys/module/apparmor/parameters/enabled` 为 `N`，`kernel.apparmor_restrict_unprivileged_userns` 和 `kernel.unprivileged_userns_clone` sysctl 不存在。本环境对照证据支持默认 seccomp 是所遇 EPERM 的阻碍，未发现额外 AppArmor 阻碍；不代表其他 Linux 宿主没有 LSM 限制。

本次无需 `--disable-setuid-sandbox`，默认 Chrome 参数已选用有效 Namespace sandbox；保留镜像中的 root-owned 4755 helper。关闭 setuid helper 本身不等于关闭全部 Chrome sandbox，但任何此类变更都必须重新核验 `chrome://sandbox`，不能只以启动成功判断。

若目标宿主仍失败，检查 user namespace 配额、内核配置、AppArmor userns 审计记录及运行时版本。不要修改全局 daemon、全局 AppArmor/userns 开关，也不要默认改成 unconfined、SYS_ADMIN、privileged 或 `--no-sandbox`；无法验证安全修复时停止。目标服务器的独立验收仍由用户执行。

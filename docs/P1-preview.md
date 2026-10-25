# WSL 开发环境直观验收

P1 开发交付与自动化合成验收已通过，Reviewer 完整评审通过。当前保留 WSL 测试容器供用户直观查看；服务器部署验收以后再做，不是当前开发工作的门槛。

## 1. 打开 Chrome 桌面

Windows 浏览器访问：

**http://127.0.0.1:6080/vnc.html**

点击 Connect，即可看到 WSL Docker 容器中的真实有界面 Chrome。地址须使用 `127.0.0.1`，默认 Origin 白名单不接受 `localhost`。本轮已确认该地址返回 HTTP 200，实际人工 UI 操作由用户查看。

保留容器名：`page-gather-p1-dev-browser-worker-1`，独立 Compose project：`page-gather-p1-dev`。原 profiles/spool/artifacts 卷保留，当前人工模式 MANUAL，无自动采集、周期调度或签到；session 显示 unknown，不把测试标记当真实登录。

Chrome 地址栏可访问容器内测试页 `http://127.0.0.1:8080/`，也可打开 `chrome://sandbox` 查看沙箱。这里 8080 是容器内 fixture 地址，未发布到 Windows。人工模式中可按自己需要手动访问网站，登录状态会进入 profiles 卷；勿将账户截图、Cookie 或用户目录提交仓库。

## 2. Windows 终端查看状态

```powershell
wsl -d Ubuntu-22.04 -- docker exec page-gather-p1-dev-browser-worker-1 node apps/worker/src/cli.js health
wsl -d Ubuntu-22.04 -- docker exec page-gather-p1-dev-browser-worker-1 node apps/worker/src/cli.js status
```

MANUAL 期间运行页面命令会拒绝，关闭浏览器窗口不会退出人工模式。

## 3. 手动切换到 CDP 测试

先保存自己正在浏览的内容，再结束人工入口；这会关闭 noVNC 的现有连接：

```powershell
wsl -d Ubuntu-22.04 -- docker exec page-gather-p1-dev-browser-worker-1 node apps/worker/src/cli.js manual-finish
wsl -d Ubuntu-22.04 -- docker exec page-gather-p1-dev-browser-worker-1 node apps/worker/src/cli.js navigate
wsl -d Ubuntu-22.04 -- docker exec page-gather-p1-dev-browser-worker-1 node apps/worker/src/cli.js read --selector h1
wsl -d Ubuntu-22.04 -- docker exec page-gather-p1-dev-browser-worker-1 node apps/worker/src/cli.js screenshot
```

这些命令只导航默认本地 fixture。页面命令创建并关闭临时标签，不关闭人工留下的标签。截图保存到容器 artifacts 卷，不直接显示到网页。此时 PAUSED/unknown 正常，因为没有提供真实站点探测配置。

再次打开人工入口：

```powershell
wsl -d Ubuntu-22.04 -- docker exec page-gather-p1-dev-browser-worker-1 node apps/worker/src/cli.js manual-start
```

刷新 noVNC 页面重新连接即可。

## 4. 保留与停止

当前保持容器运行；Docker/WSL 关闭后容器可能停止，因为 Compose 配置不自动重启。再次启动在 **WSL 内仓库根目录**执行，不需要重建：

```sh
CHROME_VERSION=156.0.8078.47-1 docker compose -p page-gather-p1-dev up -d --no-build browser-worker
docker compose -p page-gather-p1-dev exec browser-worker node apps/worker/src/cli.js manual-start
```

仅重启现有容器也可使用 `docker start page-gather-p1-dev-browser-worker-1`，等待 health 正常后执行 manual-start。每次重启人工入口默认关闭，登录状态重新视为 unknown。需要主动停止时：

```powershell
wsl -d Ubuntu-22.04 -- docker stop --time 30 page-gather-p1-dev-browser-worker-1
```

不要删除卷或执行 `down -v`。自动化 `scripts/verify-p1-container.sh` 会管理并清理自己项目的容器，而且已有预览容器时会拒绝运行；需要重跑时先明确停止、移除该开发容器，避免打断人工操作。当前无需重新运行该脚本。

此入口仅供可信本机用户，不公开发布、不修改真实服务器或现有 NGINX。后续部署时参考 [服务器部署手册](P1-deployment.md)，当前不用执行。

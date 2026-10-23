# 部署

```
浏览器 ──HTTPS──> Caddy（香港服务器 :443）──> frps 127.0.0.1:17690 ──隧道（TLS + 令牌）──> frpc（本机）──> vesper-web 127.0.0.1:7690
```

模板在 `deploy/`：`frps.toml`、`Caddyfile`（服务器），`frpc.toml`（本机）。验证用的版本是 frp v0.71。

## 1. 服务器

1. 安装 frps 和 Caddy。防火墙只开 80、443（Caddy 申请证书和 HTTPS）和 7000（frps）。17690 不开：`proxyBindAddr = "127.0.0.1"` 让它只监听本机，外面的人绕不过 Caddy。
2. 把 `deploy/frps.toml` 的 `auth.token` 换成随机值（`openssl rand -base64 32`），启动 frps。
3. 把域名的 A 记录指向服务器，把 `deploy/Caddyfile` 里的 `vesper.example.com` 换成你的域名，启动 Caddy。

用 nginx 代替 Caddy 时，下面几行不能少：

```nginx
location / {
    proxy_pass http://127.0.0.1:17690;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 1d;
}
```

## 2. 本机

### Windows

1. 设置密码：`npm run set-password`。现在是公网服务，用 16 位以上的随机密码。
2. 构建：`npm run build`。
3. 停掉正在跑的 Vesper：关掉 `npm run demo` 的窗口，再运行 `npm run stop-host`。
4. 在"以管理员身份运行"的终端里部署：

   ```
   npm run deploy -- --origin https://vesper.example.com --start
   ```

   - 运行所需的文件会复制到 `C:\Program Files\Vesper`。这个目录只有 SYSTEM 和 Administrators 能改，普通权限的会话改不了以后会以管理员身份运行的代码。
   - 同时注册计划任务"Vesper"：登录 Windows 时以最高权限在后台启动，没有窗口；用电池时也启动，运行多久都不会被停掉。
   - 日志在 Vesper data home 的 `logs/`（`web.log`、`ptyd.log`），默认 `%LOCALAPPDATA%\vesper\logs\`。
   - 会话数据由 ptyd 的 `vesperHome()` 决定：`VESPER_HOME` 优先，否则 `%LOCALAPPDATA%\vesper`。部署前后保持同一个目录；若旧部署使用 `%USERPROFILE%\.vesper`，先显式设置 `VESPER_HOME` 指向旧目录，不会自动迁移。
   - 更新：重复第 2–4 步。卸载：`npm run undeploy`，会话数据保留。
5. frpc：把 `deploy/frpc.toml` 的 `serverAddr` 和 `auth.token` 改好，和 frpc.exe 放在一起（比如 `C:\Program Files\frp\`），用计划任务开机自启：

   ```
   schtasks /Create /TN "Vesper frpc" /SC ONLOGON /TR "\"C:\Program Files\frp\frpc.exe\" -c \"C:\Program Files\frp\frpc.toml\"" /F
   ```

   frpc 不需要管理员权限。它的窗口会出现在桌面上，可以最小化。

部署之后不要再在本机运行 `npm run demo`：两者共用同一个数据目录和 7690 端口。开发时先 `npm run undeploy`，或者结束已部署的 node 进程。

### Linux（普通用户，systemd --user）

**前提**：Node.js **>=24.19.0**（含 `node:sqlite`）、npm、`python3`、`make`、`g++` 和正常工作的用户 systemd / D-Bus。请使用部署账号自己的登录终端，不用 root / sudo。编译工具若未安装，由你按发行版要求准备；CLI 不安装系统软件、不提权、不创建 `/etc/systemd/system` 服务。

`node-pty@1.1.0` **没有 Linux 预编译包**：`npm ci` 会通过 node-gyp 在目标 Linux 构建 `build/Release/pty.node` 和 `spawn-helper`，需要上述工具（以及首次构建时可下载对应 Node headers）。不要使用 `--ignore-scripts`，不要直接复制 Windows 的 `node_modules`。Node、CPU 架构或 libc 改变后，在目标环境重新 `npm ci` / build / deploy。

1. 在源码仓库根目录，以普通用户准备依赖、构建和密码：

   ```sh
   node --version
   python3 --version
   make --version
   g++ --version
   npm ci
   npm run build
   npm run set-password
   ```

   数据 home 与 ptyd 的 `vesperHome()` 完全相同：`VESPER_HOME` 优先，否则 `$XDG_DATA_HOME/vesper`，未设 XDG 时为 `~/.local/share/vesper`。自定义环境变量必须在设置密码、停止 host、部署/卸载时一致使用。home 必须是短的绝对路径（Unix socket 路径有长度限制）；不要把它放进安装目录。

2. 确保旧 web 和 ptyd 都已停止，再部署。前台 web 用 Ctrl+C；已部署 web 用下面的 stop。**只有确认终端中的工作可以结束后才执行 `stop-host`**，它会结束 ptyd 及活动终端，保留磁盘数据不等于保留正在运行的 shell：

   ```sh
   # 首次安装且尚无 unit 时跳过这一行
   systemctl --user stop vesper.service
   npm run stop-host
   npm run deploy -- --origin https://vesper.example.com
   ```

   默认只安装并 `enable`，**不会立即启动**。准备好以后由你运行：

   ```sh
   systemctl --user start vesper.service
   # 或部署时显式允许启动
   npm run deploy -- --origin https://vesper.example.com --start
   ```

   首次已启动后不要再直接执行第二个 deploy；运行中的 web / ptyd 会使安装与卸载拒绝执行，不会代你停止进程。

3. 安装布局与安全边界：
   - 运行文件默认 `~/.local/lib/vesper`；用 `--dir /绝对/路径` 修改。必须是普通用户拥有且可写的独立目录，与源码、Node、本次/原 data home 和用户 unit 路径分离。仅空目录或带匹配安装标记的旧部署可以替换，卸载只认匹配标记。
   - unit 在 `${XDG_CONFIG_HOME:-~/.config}/systemd/user/vesper.service`。安装/卸载命令始终使用 `systemctl --user`，不操作系统服务；`--no-task` 只适用于 Windows，Linux 不接受。
   - 部署时保存 Node 的绝对路径、当前 **PATH**、home、origin 和日志路径。服务不是登录 shell，不会自动加载 `.bashrc` / nvm / mise 初始化；部署前把 Node、shell、git 及 CLI 工具所在路径放好，之后 PATH/Node 位置变化需要重新安全部署。
   - home / logs / runtime 保持私有；拒绝相互覆盖、控制字符、危险路径、符号链接和非本人可控目录，不会跟随已有日志链接。共享 sticky 目录（如 `/tmp`）下必须已有当前用户或 root 拥有、其他用户不可写的直接子目录，不能使用尚不存在的 `/tmp/任意名称/...`；建议使用自己的 home。异步运行检查后、复制完成及删除前重新核对路径、安装标记与目录归属；这不是对同 UID 恶意并发进程的隔离。unit 对 `%`、引号、反斜杠做 systemd 转义，并禁用 ExecStart 的 `$` 展开，不经 shell 拼接命令。
   - 日志在 data home 的 `logs/web.log`、`logs/ptyd.log`；启动前错误用 `journalctl --user -u vesper.service -n 100 --no-pager` 查看。状态用 `systemctl --user status vesper.service`。
   - `runtimePackages` 遍历运行时依赖及实际安装的 optionalDependencies；`copyRuntime` 对第三方包**整目录递归复制**，保留 node-pty 的 `build/Release` / helper / 执行权限、koffi 的 `build/koffi` 或 `@koromix/koffi-linux-*` 平台包（嵌套依赖随父包复制）。不会在部署目录再次 npm install；必须先在目标 Linux 完成 `npm ci` 和构建。

4. 重启 web 与升级/卸载不同：

   ```sh
   # 仅重启 web，保留独立 ptyd 和正在运行的会话
   systemctl --user restart vesper.service
   ```

   unit 明确使用 `KillMode=process`：systemd stop/restart 只停止 web 主进程，不杀整个 cgroup；不使用会连带结束 ptyd 的默认 `control-group`。systemd 官方通常不推荐 process 模式，这里是为了会话跨 web 重启存活的有意选择。停止 unit **不表示 ptyd 已停止**。

   升级时先 build、停止 web、确认可结束终端后 `npm run stop-host`，再重复 deploy。卸载同样先停两者，然后从源码根目录执行：

   ```sh
   npm run undeploy
   # 自定义安装位置时附加 -- --dir /原安装/路径
   ```

   卸载 disable 并移除所属用户 unit、安装文件；**不删除 home、会话、密码库、日志或其他数据，也不停止进程**。不要为了开发而边运行边替换部署；使用相同 home 的开发版与部署版不能并行。

5. `enable` 让服务在用户管理器启动时拉起，一般随用户登录；想在未登录时随开机运行且退出登录后继续，由你自行了解发行版策略并选择配置 **linger**（`loginctl show-user "$USER" -p Linger` 查看，`loginctl enable-linger "$USER"` 可能需要管理员授权）。这是可选系统管理操作，CLI 不执行、不自动调用 sudo。没有可用 user manager（例如部分容器、未启用 systemd 的 WSL，或 SSH 会话缺少用户总线）会明确失败，不会降级成 root/system 服务。即使设置 linger，重启机器也不会保留原 shell 进程。

frpc 在 Linux 同样作为该普通用户运行，使用 `deploy/frpc.toml`；是否给 frpc 单独配置用户服务由你决定。Vesper 的 deploy 只管理 Vesper，不会替你启动 frpc 或服务器软件。

**已验证**：Windows 构建与回归通过（662 项通过、9 项跳过），包含 plan/escaping、mock systemctl 安装/卸载、运行中拒绝和原生文件复制 fixture。Ubuntu 22.04.5 x86_64 的隔离普通用户（Node.js 26.8.2、npm 11.19.1）已完成 `npm ci`、构建、Linux/CLI 定向测试（42 项通过、1 项跳过）与全仓回归（597 项通过、74 项跳过）；跳过项不计为通过。另在无用户总线的真实环境验证了 deploy 在复制 runtime、创建 data home / unit 前拒绝执行；普通与带空格、引号、`%`、`$` 路径的生成 unit 均通过 `systemd-analyze --user --man=no verify` 离线检查（退出码 0，但缺少 runtime dir 时会打印 `Failed to bind private socket`）。

**安全补丁验证（2026-10-21）**：上述目标服务器结果先于路径竞态补丁。补丁新增 5 个已验证 RED→GREEN 的回归（覆盖/删除保护及成功 rename 后不再清理旧 stage 路径），另有 1 个 Linux 专用 Vitest 用例尚未在目标服务器运行；独立安全及代码复核在各自范围内无剩余 HIGH/CRITICAL。本地构建通过，CLI 最终 33 项通过、1 项跳过，全仓 `npm test -- --maxWorkers=2` 为 667 项通过、10 项跳过。首次默认并发全仓有 2 项 Windows PTY 测试失败，之后两文件串行及低并发全仓重跑通过，未通过修改测试放宽断言。补丁上传被权限模式拦截，尚未在目标服务器复验。

**补充本地预检（2026-10-22）**：WSL Ubuntu 22.04 普通用户 UID 1000 对构建后的路径校验模块完成 7 项真实文件系统检查，覆盖 sticky 共享祖先、缺失父目录、符号链接、硬链接和共享写权限；该环境 Node.js 22.23.2 低于项目要求，只补充文件系统证据，不计为完整 Linux 运行时验收。隔离验收辅助脚本另有 10 项预检在 Windows / WSL 通过，包含归档内容绑定、web 优先停止、等待进程退出及清理失败不报成功；这 10 项中的进程清理断言使用 mock。另在 WSL 完成 6 项真实子进程检查，直接复用 smoke 的 `/proc` 身份与终止函数，验证精确入口 / home 筛选、starttime 不匹配时不发信号、SIGTERM / SIGKILL 后等待退出及排除对象未受影响；只对本次预检创建的子进程发信号，已清理这些进程与临时目录。上述预检不替代真实 Vesper smoke，也不计入产品全仓测试数量。两份隔离验收辅助脚本的窄范围静态安全复核已完成，无可证实的剩余 HIGH/CRITICAL；该结论不是整项 Linux 移植的安全验收。补丁包仅包含 3 个 CLI 文件，尚未上传。

**仍待验收**：测试账号没有 `/run/user/<uid>`、D-Bus 或活动用户管理器；离线 unit 解析不能替代真实 enable/start/stop/restart、ptyd 跨 web 重启存活、登出/linger 和公网链路测试。Linux 全仓跳过了部分进程与 web/浏览器集成测试，尚未验收复制后的真实运行时、HTTP→WebSocket→PTY 链路、zsh/fish 或外部 agent；已准备隔离 smoke，但未执行。本轮未启用 linger、未启动正式服务，也未降级为 root/system 服务。最近一次 Windows 覆盖率检查因分支 76.08% 未达 80% 门槛失败，未降低门槛；补丁后未重测覆盖率，也未测 Linux 覆盖率。

实现参考：[systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)、[systemd.exec](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)、[systemd.kill](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html)、[node-pty v1.1.0](https://github.com/microsoft/node-pty/tree/v1.1.0)。本轮 freedesktop 页面抓取受限，已改用 gh 读取 systemd 官方仓库 man XML / 解析代码确认 quoting、Environment 与 KillMode 语义。

## 3. 公网验收

用手机流量（不经过本机网络）打开 `https://你的域名`：

- 能登录、开标签、打字；刷新页面后会话还在。
- 终端页反复打开／收起软键盘、切换横竖屏后，最后一行和底部快捷键都可见，刘海与底部手势条不遮挡操作；双指缩放仍可用。
- 连续点 Esc、Tab、方向键时不意外关闭软键盘；切换标签后按键只进入当前会话，查找期间不会把快捷键误发给 shell。Ctrl+C/D/Z 会中断、退出或挂起程序，请在可结束的临时会话里验证。这些手机行为尚未实机验收，前端构建通过不代表验收通过。
- 设置页的设备列表里，手机显示的是它的公网 IP，不是 127.0.0.1。
- 输错 5 次密码后被限速（提示稍后再试）；审计日志里有这几次失败和对应的 IP。
- 在设置页注销手机，手机上的页面立即断开，需要重新登录。
- 在本机重启 frpc 或断网再恢复，页面会自己重连。

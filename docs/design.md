# Vesper 设计方案（v0.2，2026-10-14 已确认）

> 方案已确认，按第 12 节分期实施。

## 1. 目标与范围

目标：
- 在网页里使用这台 Windows 电脑的终端和 agent（Claude Code / Codex / Gemini / 自定义命令）
- 会话常驻：没人连着也照常运行，换一台电脑打开网页接着用
- 同一个会话可以在多台设备上同时打开，每台都能输入
- 项目 = 一个文件夹，相当于一个"浏览器窗口"；会话 = 标签页。一个项目里可以开多个终端和 agent
- agent 需要确认或已完成时，在网页里提醒
- 输入手感接近直连 SSH，外观照 Windows Terminal 默认
- 通过你自己的服务器反代访问，不经过任何第三方中转

本期不做：WSL、远程 SSH 主机、多账号和权限、手机推送和 IM 机器人、TOTP（预留开关）。

## 2. 总体架构

```
浏览器 ──HTTPS/WSS── 你的服务器（caddy 或 nginx）──frp 隧道── 本机 frpc
                                                          │ 127.0.0.1
                                          vesper-web（Node 24）
                              登录鉴权 · API · 网页 · WebSocket · 提醒
                                                          │ 命名管道 + 令牌
                                          vesper-ptyd（Node 24）
                ConPTY 会话 · headless 屏幕镜像 · 输出日志 · agent hook 接收 · SQLite
                                                          │
                     PowerShell / cmd / Git Bash / claude.exe / codex.exe / gemini
```

- 拆成两个进程：ptyd 只管终端，代码尽量小，协议带版本号，很少改动；web 可以随时重启、升级，终端不受影响。
- ptyd 装到 `%LOCALAPPDATA%\vesper\host\` 下运行，不在代码目录里，升级 web 时不会被覆盖或结束。
- 两个进程都由"登录时触发"的计划任务启动。web 发现 ptyd 不在时把它拉起；连续崩溃有退避限制，避免死循环。
- web 和 ptyd 之间每 5 秒心跳一次。ptyd 无响应时只告警、不强杀，因为杀掉它会结束所有会话；只有 ptyd 进程确实不在了，web 才重新拉起它。
- ptyd 退出时，它名下的 shell 和 agent 一起结束，不留无人管理的进程。

## 3. 终端宿主 ptyd

- **ConPTY**：node-pty 1.1.0（免编译的 N-API 预编译包），开启 `useConptyDll`，使用它自带的 OpenConsole 1.23，避开 Win10 旧版 conhost 的渲染问题和每次退出泄漏一个 conhost 的 bug（node-pty#965）。启动时预热一次 `cmd /c exit`。
- **屏幕镜像**：每个会话一份 `@xterm/headless` 镜像加 serialize 插件，服务端保留最近 5000 行。有设备连上时先发屏幕快照，再接实时输出。
- **终端查询只由 ptyd 回答**：DA1、光标位置、颜色等查询都由 headless 镜像回复给程序。这样没人连着时 ConPTY 也不会卡住（新版启动要等 DA1 回复），多台设备同时连着也不会各回一份、往 shell 里注入重复字符。浏览器端用 xterm.js 的 parser hook 吞掉这些查询，不回包。
- **输出序号**：每个会话累计输出字节数作为序号，内存环形缓冲保留最近 2 MiB 原始输出，用于断线补发；超出范围就改发快照。
- **持久化**：ptyd 自己每秒批量追加 `output.log`，定期写快照 checkpoint（先写临时文件再改名）。电脑重启后，标签里先显示上次的内容和一条"已恢复历史"分隔线，再在原目录启动新 shell，agent 用 resume 接回原对话。web 没运行期间的输出也不会丢。
- **元数据**：项目、会话、提醒存在 SQLite（Node 24 自带的 `node:sqlite`，WAL 模式），位置 `%LOCALAPPDATA%\vesper\data\`。
- **启动 shell**：
  - PowerShell 5.1：`-NoLogo -NoExit -EncodedCommand <引导脚本>`。脚本整段随命令行传入，不落地 .ps1 文件，所以不受执行策略限制；你的 profile 照常先加载，脚本再在外面包一层 prompt。脚本把控制台编码设为 UTF-8，并输出 VS Code 格式的 OSC 633 标记：提示符开始和结束、命令开始、当前目录。命令结束时另报真实退出码，因为 VS Code 的 633;D 只给 0 或 1。
  - cmd：`/K chcp 65001>nul`，并通过 `PROMPT` 变量在提示符里输出当前目录（OSC 9;9，WT 官方文档里的做法）。
  - Git Bash：`--login -i`，加 `CHERE_INVOKING=1` 和 `chcp 65001`，用 `PROMPT_COMMAND` 输出当前目录。
  - 当前目录用于标签显示、在同一目录新开标签，以及重启后在原目录恢复。
  - 统一环境变量：`TERM=xterm-256color`、`COLORTERM=truecolor`、`VESPER_SID=<会话 ID>`，并去掉重复的 Path。
- **启动 agent**：直接启动可执行文件（`claude.exe`、`codex.exe`、`node gemini.js`），不经过 cmd。这样进程号和 Claude 登记文件里的一致，退出也能准确捕获。agent 退出后标签页保留，提供"重新启动 / resume / 在此目录开 shell"。自定义命令（比如你的 ccswitch 脚本）用 `cmd.exe /c` 启动。
- **结束进程**：用 Job Object 结束整棵进程树。这需要调用 Win32 API；没有编译工具，计划用带预编译包的 FFI 库 koffi，在 M0 验证。不可行时退回 `taskkill /T`，并先核对进程创建时间，防止误杀复用了同一进程号的其他进程。

## 4. 连接与协议（稳定性优先）

- **连接划分**：每个浏览器窗口开一条控制连接，负责项目列表、状态和提醒。每个正在显示的终端标签另开一条数据连接。会话之间互不排队，一个会话刷大量输出，不会拖慢另一个会话的回显。后台标签只保留状态，不开数据连接；切回来时按序号补发，或者直接拿快照。这样也不会撞上浏览器对同一域名 WebSocket 数量的上限。
- **帧格式**：二进制帧，开头 1 字节表示类型。输入帧是原始 UTF-8；输出帧是 8 字节序号加原始字节。resize、心跳、ack 用很小的固定格式，不给每个按键套一层 JSON。
- **低延迟**：
  - 按键立刻发送，不合并。
  - 输出在 ptyd 里最多合并 2ms 再发。
  - 关闭 permessage-deflate。ws 服务端默认就是关的，并且会自动设置 setNoDelay，关掉 Nagle。
  - 浏览器用 WebGL 渲染，不支持时退回 DOM 渲染。
- **心跳**：web 每 10 秒发一次 ping，期间收到任何数据都算连接正常。10 秒比 nginx 默认的 60 秒空闲超时和常见 NAT 超时都短。
- **断线检测和重连**：
  - 浏览器连续 2 个心跳周期没收到任何数据，就判定断线，直接丢掉旧连接重新连，不等 close 事件。死掉的 TCP 连接，close 事件可能很久才来。
  - 重连间隔从 0.25 秒开始指数退避，最长 10 秒，加随机抖动，不限次数。网页切回前台（visibilitychange）或网络恢复（online）时立即重连。
  - 断线期间显示"重连中"。这时输入的按键先存起来，重连后按顺序发出；存了超过 5 秒的按键会丢弃并提示，免得过时的按键（比如一个 y）被误送给 agent。
- **补发规则**：重连时带上会话 ID 和最后收到的序号。缺的那段还在缓冲区里，就只补这一段；已经不在了，就发一份新快照和当前序号。这样输出既不丢也不重复。
- **背压（按确认序号）**：
  - 浏览器在 xterm 解析完数据后，回报已处理到的序号，每 32 KiB 或每 50ms 回报一次。
  - 服务端对每台设备限制"已发出但未确认"的数据不超过 512 KiB。超过就暂停给这台设备发送，确认追上后继续；落后太多、缺的那段已经不在缓冲区里，就改发快照。
  - 不能只看服务端的发送缓冲：在反代后面，数据会先被本机的 frpc 很快收走，发送缓冲看起来总是空的。
  - shell 本身不会被暂停，其他设备也不受影响。只有 headless 镜像处理不过来时，才暂停 pty。
- **终端尺寸**：会话尺寸跟随最近一次输入的设备。其他设备按这个尺寸显示：窗口小就出现滚动条，窗口大就留白，不会自己去改会话尺寸。
- **本地回显预测**（参考 VS Code 的 typeahead）：
  - 只在普通 shell 标签里使用。往返延迟的中位数达到 30ms 时自动开启，低于 15ms 时关闭。VS Code 的关闭条件写成了除以 0.5（注释写的是乘 0.5），延迟在 30–60ms 时开和关的条件互相冲突，这里改掉。
  - 预测范围：可打印 ASCII、行尾退格、左右移动和按词移动。遇到中文输入法、Tab、上下键、Ctrl 组合键就停止预测。
  - 预测的字符先用暗色显示，回显到达后替换；对不上就整组回滚；超过 max(500ms, 1.5 倍延迟) 还没确认也回滚。
  - 全屏程序、vim/nano、密码提示和 agent 标签里都不启用。
- **WebSocket 鉴权**：
  - 浏览器先带 Cookie 请求 `POST /api/ws-ticket`，换一张一次性票据，60 秒内有效。
  - 票据放在 `Sec-WebSocket-Protocol` 里传过去，服务端回一个固定的协议名，同时校验 Origin。
  - 这样即使 frp 或 nginx 改写了 Host，鉴权也不受影响，令牌也不会出现在 URL 里。

## 5. 数据模型（SQLite）

- `projects`：项目 ID、名称、文件夹路径、排序、创建时间。
- `profiles`：启动配置。
  - 类型分 shell、agent、自定义三种，记录可执行文件、参数、环境变量，以及 agent 种类（claude、codex、gemini 或无）。
  - 第一次启动时，从 WT 配置导入 PowerShell、cmd 和 ccswitch-codex-fanren-grok，再加上 Git Bash 和三个 agent。
- `sessions`：
  - 基本信息：会话 ID、所属项目、profile、标题、工作目录、worktree 路径。
  - 状态：运行中或已退出；agent 状态分工作中、等待确认、已完成、空闲。
  - agent 会话 ID，用于 resume。
  - 进程号加进程创建时间，cols/rows，最后的输出序号。
  - 创建时间、退出时间、退出码。
- `events`：提醒和状态变化，记录所属会话、类型、内容、时间、是否已读。
- `auth`：
  - 密码哈希（scrypt）。
  - 设备会话：Cookie 哈希、设备名、最后活跃时间、IP。
  - 登录尝试记录、审计日志。
- 文件，都放在 `%LOCALAPPDATA%\vesper\` 下：ptyd 的会话表 `data\host.db`；每个会话的 `data\sessions\<id>\checkpoint.json` 和输出日志 `out-<incarnation>-<起始序号>-<列>x<行>.log`（尺寸一变就换新文件，恢复时在同一处 resize）；web 的数据（项目、登录）从 M2 起放 `data\vesper.db`。

## 6. 界面

- **首页**：
  - 每个项目一张卡片，显示会话数和待处理的提醒数。
  - "新建项目"：在默认根目录 D:\code\work_space 下新建文件夹，或者选择一个已有的文件夹。
  - "外部会话"区：列出 vesper 之外正在运行的 claude、codex、gemini，可以一键接管，流程见 7.4。
- **项目页**：
  - 每个项目有自己的网址 `/p/<项目>`，可以单独在一个浏览器窗口里打开，对应"一个项目 = 一个浏览器"。
  - 顶部是仿 WT 的标签栏，每个标签是一个终端或 agent。状态点：工作中转圈，等待确认是橙点，已完成是绿点，已退出变灰。
  - "+" 新开默认 shell，旁边的下拉菜单选择 shell 种类或 agent。项目是 git 仓库时，新建 agent 可以勾选"独立 worktree"。
  - 标签可以拖动排序，也可以重命名。
- **断开和关闭的区别**：关掉浏览器的标签页或窗口只是断开连接，会话继续运行。点标签上的 × 才会结束进程；进程还在运行时会先让你确认。
- **提醒中心**：右上角的铃铛列出所有项目的待处理提醒，点一条就跳到对应的标签。
- **快捷键**：
  - 照 WT 的习惯：Ctrl+Shift+T 新建标签，Ctrl+Tab 切换标签，Ctrl+Shift+W 关闭标签，Ctrl+Shift+F 搜索。
  - Ctrl+C 在有选中内容时复制，没有时发送中断；Ctrl+V 粘贴。
  - agent 标签里 Shift+Enter 发送 `ESC CR`，Claude Code 会把它当作输入框里的换行。其他 agent 在 M3 逐个核实。
  - 限制：浏览器会抢占 Ctrl+W、Ctrl+T、Ctrl+N。Chrome 和 Edge 全屏时可以用 Keyboard Lock 把这些键拿回来，实现时验证。平时在 bash 里删除一个词用 Alt+Backspace 代替 Ctrl+W。
- **设置**：默认项目根目录；每个 profile 的启动参数、进程权限（管理员 / 普通）、Claude 是否加 `--dangerously-skip-permissions`；提醒声音；本地回显开关。
- 中文界面，以电脑为主；手机上可以查看和做简单输入。

## 7. agent 集成

### 7.1 启动、注入与信号

| agent | 启动与注入（只作用于本次启动） | 需要确认 | 已完成 | 会话 ID / 续接 |
|---|---|---|---|---|
| Claude Code | `claude.exe --settings '<内联 JSON>'`，用 HTTP hook 发到 `127.0.0.1:<端口>/hook/claude`，请求头带会话令牌 | PermissionRequest；PreToolUse(AskUserQuestion、ExitPlanMode)；Notification(idle_prompt 等) | Stop、StopFailure | 用 `--session-id` 预先指定；续接用 `--resume <id>` |
| Codex | `codex.exe -c notify=[node, vesper-notify.js] -c tui.notifications=true -c tui.notification_method="osc9" -c tui.notification_condition="always"` | ptyd 解析输出里的 OSC 9 | notify 收到 agent-turn-complete（按 thread-id 过滤） | 从 notify 或 rollout 文件取 ID；续接用 `codex resume <id>` |
| Gemini | `node gemini.js`，环境变量 `GEMINI_CLI_NO_RELAUNCH=true`、`GEMINI_CLI_SYSTEM_DEFAULTS_PATH=<vesper 配置>`。配置里写 hook，并关掉自动更新 | Notification(ToolPermission) | AfterAgent | 用 `--session-id` 预先指定；续接用 `--resume <uuid>` |

- 兜底信号，在 hook 没触发时使用：窗口标题的符号（Claude ✳/◐，Codex ⠧，Gemini ◇/✦/✋），以及 OSC 9/777 和 BEL。
- hook 接收端在 ptyd 里，只监听 127.0.0.1 的随机端口，每个会话一个随机令牌。接收端出错时不阻塞 agent。Claude 走 HTTP hook，不额外起子进程，避免窗口标题被子进程短暂改掉。
- Codex 的 `-c notify` 会覆盖你原有的 notify 设置。如果你原来配了 notify，vesper-notify.js 处理完之后会转调原来那个程序。
- 你全局 settings 里已有的 hook（比如 Orca 装的）会和 vesper 的一起执行。预计不会有影响，M3 时在本机核实。
- 自定义命令（比如 ccswitch 脚本）没法注入参数，只能靠兜底信号判断状态。如果脚本能把额外参数透传给 codex，就能和普通 Codex 一样注入。

### 7.2 状态机与提醒规则

- 状态有四种：空闲、工作中、等待确认、已完成。
- 只在两种变化时提醒：从"工作中"变成"等待确认"，和从"工作中"变成"已完成"。
- "已完成"要先等 250ms，并等输出停下约 1 秒再发，避免收尾时的输出触发误报。
- 同一个会话的重复提醒合并成一条。
- 有设备正在看这个标签时，那台设备上不弹提醒，只更新状态点。

### 7.3 网页提醒

- 浏览器系统通知：要求 HTTPS，第一次使用时需要授权。
- 提示音。
- 标签和项目上的角标；网页标题加上数字，比如 `(2) vesper`。
- 提醒中心里的未读提醒一直保留，直到被处理。
- 所有在线设备都会收到提醒；在任意一台设备上标记已读，其他设备同步。

### 7.4 接管外部会话

- **Claude**：
  1. 读取 `~/.claude/sessions/*.json`，只保留进程还活着、而且进程创建时间对得上的记录。
  2. 等它的状态变成空闲。
  3. 结束原进程。你在本机时，也可以在原窗口里输入 `/exit` 退出。
  4. 在同一目录启动 `claude.exe --resume <id> --settings … <原启动参数>`。
  5. 检查 SessionStart 的 source 是 resume、会话 ID 没变。如果变成了新 ID，说明原进程没退干净，提示你处理。
- **Codex / Gemini**：从进程命令行，或该目录下最新的会话文件推断会话 ID；你确认后，退出原进程，再 resume。
- 等空闲后再结束原进程，正在执行的那一步就不会被打断。
- 接管后的会话按工作目录归入对应项目；没有对应项目时新建一个。

### 7.5 worktree

- 新建 agent 时勾选"独立 worktree"，会执行 `git worktree add <项目父目录>/<项目名>-worktrees/<名称> -b vesper/<名称>`，项目文件夹本身不会多出东西。
- 关闭这个标签时，会问你是否删除 worktree。分支上有未合并的提交时保留分支。

## 8. 安全

- 服务只监听 127.0.0.1。公网入口只有你服务器上的 HTTPS。
- 单用户密码：第一次运行时在本机命令行设置（`vesper set-password`），用 scrypt 保存哈希。建议用 16 位以上的随机密码。
- 登录限速：同一 IP 每分钟最多 5 次；连续失败 10 次锁定 15 分钟。另有一个全局上限，防止分散 IP 猜密码。
- Cookie：HttpOnly、Secure、SameSite=Strict，30 天滑动过期。网页里能看到已登录的设备列表，可以单独注销某台设备。
- 防 CSRF：所有写操作校验 Origin 和一个自定义请求头。WebSocket 校验 Origin 和一次性票据。
- 真实 IP：经过 frp 进来的连接，来源都显示为 127.0.0.1，所以只信任来自本机连接的 X-Forwarded-For。
- hook 接收端：只监听 127.0.0.1 的随机端口，每个会话一个令牌。
- 响应头：CSP、`frame-ancestors 'none'`、`Referrer-Policy: no-referrer`。
- 审计日志：记录登录、设备、会话的创建和结束、接管。
- 进程权限：设置里按 profile 选"管理员"或"普通权限"。降权的具体做法（`runas /trustlevel:0x20000` 或受限令牌）在 M0 验证。
- TOTP 预留开关。
- web 与 ptyd 之间（M1 已实现）：
  - 管道名是可推算的，另一个账户可能抢先占用这个名字，所以连接时双方互相证明持有令牌：各自用令牌对对方的随机数做 HMAC。令牌本身不在管道里传；冒名的 ptyd 拿不到任何东西，web 也不会把输入发给它。
  - 认证通过之前，单条消息最多 64 KiB；被拒绝的连接会立即断开。
- 来自程序输出的内容都不可信（M1 已实现）：
  - 当前目录的报告带每个 shell 单独生成的随机数，普通输出伪造不了。只接受本地盘符路径：`\\server\share` 这样的路径一被访问，就会把你的 NTLM 凭据发给对方。
  - 标签标题去掉控制字符和双向文本控制符。
- 令牌（M1 临时方案，M2 换成密码登录）：
  - 正确的令牌永远可用。错误的才计数，同一来源 1 分钟内错 10 次之后回 429。经过反代的请求来源都是 127.0.0.1，如果先查锁定，任何网页都能把你锁在外面。
  - 只认自己的 Host 名（本机地址和 `VESPER_ORIGINS` 里的域名），防 DNS 重绑定。响应带 COOP/CORP。
  - 换令牌：停掉 vesper-web，删除 `%LOCALAPPDATA%\vesper\web\token`，再启动。
- 以管理员身份运行时要注意：同一用户的普通权限程序能读到令牌文件，再通过 127.0.0.1 拿到管理员 shell，相当于绕过 UAC。建议 web 和 ptyd 用普通权限运行，需要管理员的 profile 再单独提权（M2 的进程权限设置）。
- 剩余风险：密码一旦泄露，这台电脑的 shell 就交出去了。

## 9. 部署

- **本机**：ptyd、web、frpc 都用"登录时触发"的计划任务启动。默认端口 7690，避开本机已被占用的 7680，可以改。
- **frpc**：`type = "tcp"`，把本机 `127.0.0.1:7690` 映射到服务器上的 `127.0.0.1:7690`。服务器这一端只在本机监听，不直接对公网开放。frp 的传输层开启 TLS 和 token。
- **服务器（推荐 caddy）**：caddy 自动申请证书，WebSocket 不需要额外配置：
  ```
  vesper.example.com {
      reverse_proxy 127.0.0.1:7690
  }
  ```
  用 nginx 的话需要配置：`proxy_http_version 1.1`、`Upgrade` 和 `Connection` 头、`proxy_read_timeout 3600s`、`proxy_buffering off`、`X-Forwarded-For`。
- **服务器**：在香港，不需要 ICP 备案，可以直接用 80/443 端口加域名。从内地访问的往返延迟通常是几十毫秒，M4 实测。
- **断线处理**：frp 自身的心跳和重连由 frp 负责，vesper 的重连机制再兜一层底。

## 10. 外观（照 Windows Terminal 默认）

- 配色用 Campbell：PowerShell 和 cmd 在 WT 里默认都是这套，黑底 #0C0C0C、前景 #CCCCCC、光标 #FFFFFF。不是蓝底的 Campbell Powershell。

  | | 黑 | 红 | 绿 | 黄 | 蓝 | 紫 | 青 | 白 |
  |---|---|---|---|---|---|---|---|---|
  | 普通 | #0C0C0C | #C50F1F | #13A10E | #C19C00 | #0037DA | #881798 | #3A96DD | #CCCCCC |
  | 亮色 | #767676 | #E74856 | #16C60C | #F9F1A5 | #3B78FF | #B4009E | #61D6D6 | #F2F2F2 |

- 字体用 Cascadia Mono v2407.24 的 woff2 文件（常规体的可变字体，加斜体），随网页下发，附带 OFL 1.1 许可文本。M0 的演示暂时用 `@fontsource-variable/cascadia-mono@5.3.0`（同为 OFL 1.1），M2 换成官方文件。中文回退字体依次是 Microsoft YaHei UI、PingFang SC、Noto Sans Mono CJK SC。
- 终端参数：
  - 字号 16px，即 WT 的 12pt，按字体数据算出的单元格约 9×19 像素，实现时实测核对
  - 行高 1，bar 光标，内边距 8px，滚动历史 9001 行，灰度抗锯齿
  - `windowsPty: { backend: 'conpty', buildNumber: 19045 }`，并启用 unicode11
- 标签栏用 WT 的暗色主题：
  - 标签栏底色 #2e2e2e，窗口失焦时 #333333
  - 选中的标签用终端背景色，未选中的透明
  - 界面文字用 Segoe UI，其他系统用 system-ui
- 不做 Win11 的 Mica 效果：那是系统层的窗口特效，你这台是 Win10，网页里也做不了。

## 11. 技术栈与目录

- 运行环境：Node 24.19（本机现有），TypeScript 5.x（7.0 刚出大版本，暂不用），npm workspaces。不用 pnpm，因为 pnpm 11 默认不让依赖执行安装脚本，而 node-pty 需要。
- 依赖全部锁死确切版本：
  - ptyd：`node-pty@1.1.0`、`@xterm/headless@6.0.0`、`@xterm/addon-serialize@0.14.0`、`node:sqlite`（Node 内置）
  - web：Node 内置的 http 加 `ws@8.22.0`，不引入大框架
  - 前端：React 19 + Vite、`@xterm/xterm@6.0.0`、`addon-webgl@0.19.0`、`addon-fit@0.11.0`、`addon-unicode11@0.9.0`、`addon-web-links@0.12.0`、`addon-search@0.16.0`、`addon-clipboard@0.2.0`
  - 测试：Vitest、Playwright
- 目录（D:\code\work_space\vesper）：
  ```
  packages/protocol   帧格式与类型（ptyd、web、ui 共用）
  packages/ptyd       终端宿主
  packages/web        HTTP/WS 服务、鉴权、提醒
  packages/ui         网页前端
  packages/cli        vesper 命令：set-password、install-tasks、status、attach
  docs/               设计文档、部署说明
  ```

## 12. 分期

每期结束都要过测试和代码审查，再交给你验收。

- **M0 验证**：
  - 搭好项目骨架
  - ptyd 能启动 PowerShell、cmd、Git Bash，DA1 自动回复，中文输出不乱码
  - 验证用 koffi 调 Job Object
  - 验证降权启动 shell，以及降权后能否正常读写你的文件
  - 浏览器单会话打字延迟实测
- **M0 结果（2026-10-15，已完成）**：
  - 打字回显（WebSocket → ConPTY → shell → 回显，本机）：
    - cmd：p50 1.0ms，p99 2.5ms
    - PowerShell：p50 1.7ms，p99 3.9ms
    - Git Bash：约 16.5ms（MSYS 自身的输入轮询）
  - 真实浏览器（Edge，从按键到画面画出）：中位约 2.1ms。
  - PowerShell 约 2.8 秒才出提示符，几乎全花在加载用户的 profile 上；不加载 profile 只要约 0.3 秒。
  - 结束会话时，Job Object 会连同它脱离出去的子进程一起结束；服务进程退出时，它启动的 shell 也全部结束。
  - `runas /trustlevel:0x20000` 不能用来降权：完整性级别仍是 High，而且会另开一个窗口。M2 改为写一个启动器：在 pty 里运行，用 `CreateProcessAsUserW` 以 Medium 完整性启动 shell，不新开窗口。
  - 测试：59 个全部通过；覆盖率 语句 91.6%、分支 85.6%、函数 91.9%、行 95.8%。
- **M1 常驻与重连**：
  - web 和 ptyd 拆成两个进程，走命名管道协议
  - 快照加序号补发、心跳重连、背压
  - 多设备同时打开，终端尺寸规则
  - 持久化，电脑重启后恢复
- **M1 结果（2026-10-15）**：
  - 两个进程：vesper-ptyd 监听命名管道 `\\.\pipe\vesper-ptyd-<数据目录的哈希>`，每条连接的第一条消息带令牌和协议版本，令牌每次启动重新生成，写在 `run\ptyd.json`。同一个数据目录只能有一个 ptyd，第二个以退出码 3 退出。vesper-web 发现 ptyd 不在就把它拉起，每 5 秒心跳一次，没有回应只告警。
  - 重启 web：会话不断，网页自己重连，按序号续传。重启或强杀 ptyd：shell 会结束；下一个 ptyd 用 checkpoint 加之后的日志恢复屏幕，加一条"已恢复历史"分隔线，在 shell 最后报告的目录里重新启动。三种 shell 都在提示符前报告当前目录（OSC 7690，带每个 shell 的随机数，见第 8 节）。
  - 续传：重连时带上 incarnation 和序号，缺的那段还在 2 MiB 环形缓冲里就只补这段，否则发快照。每台设备未确认的数据最多 512 KiB。断线期间的按键：重连到的是同一个 shell 且没有超过 5 秒才发出，否则丢弃并提示。
  - 多设备尺寸：跟随最近输入的设备。ConPTY 默认打开焦点报告（DECSET 1004），窗口得到焦点时发出的 `ESC [ I` 不算输入。
  - 发现：node-pty 自带的 ConPTY（1.23）resize 时不重绘，假定终端按它的方式挪动各行；xterm.js 挪法不同，之后的输出会写到错的行上。改为 resize 在输出流的固定位置生效：ptyd 先暂停输出，等镜像解析完，追加一段把行挪到 ConPTY 位置的输出，再记一个尺寸事件；浏览器、镜像和日志都在同一个字节处 resize。
    - 先按实测的行数规则挪。
    - 但 ConPTY 改宽度时会把整个缓冲区重新折行，光标落到哪一行从外面算不出来；改过宽度之后，行数规则也会差一行。所以每次 resize 之后，都等 ConPTY 下一次定位光标：第一个落在光标所在列的绝对定位，就是它眼中的光标行。ptyd 在这个定位前面插一段输出，把各行挪过去。变窄后，上面几行旧输出可能被挪进滚动区；屏幕顶上偶尔会多出空行。
    - resize 前先等输入输出停 50ms（最多等 250ms）。否则刚敲的键的回显会落在 resize 之后，被当成 ConPTY 的定位。等待期间的输出照常对齐上一次 resize。
    - 回归测试覆盖：宽度连续变化、宽度变了再变高度、resize 等待期间的输出。修复前这些测试都会失败。
  - 已知问题（上游）：ConPTY resize 后，Git Bash 会丢掉紧接着的第一个按键。直接用 node-pty、不经过 Vesper 也能复现。resize 后约 150ms 写一个 NUL 字符可以把它吞掉，但这等于替用户往 shell 里输入，暂未采用。
  - 延迟（本机，WebSocket → web → 命名管道 → ptyd → ConPTY → 回显）：cmd p50 1.16ms、p99 3.4ms；PowerShell p50 1.79ms、p99 4.6ms，比 M0 单进程多约 0.1ms。浏览器（Edge，WebGL，按键到画面画出）中位约 3.3ms；退回 DOM 渲染约 13.5ms。
  - 与原设计的差异：
    - ptyd 的会话表单独放在 `data\host.db`（SQLite，WAL）。web 的项目和登录数据从 M2 起另放，两边各管各的。
    - 鉴权暂用持久令牌：第一次打开 vesper-web 打印的 `#token=` 链接，令牌存进浏览器；API 走 Authorization 头，WebSocket 走 Sec-WebSocket-Protocol，不出现在 URL 和服务器日志里。M2 已换成密码登录、Cookie 和一次性票据。
    - 输出没有做 2ms 合并：ConPTY 自己按帧合并，实测不需要。
    - 会话列表页每 2 秒轮询一次；控制连接放到 M2 和项目界面一起做。
    - ptyd 暂时从代码目录运行；装到 `%LOCALAPPDATA%\vesper\host\` 和计划任务自启在 M4。
- **M2 项目与界面**：项目、标签、profile，WT 外观，提醒中心，快捷键，登录。分两轮验收。
- **M2a 结果（2026-10-17）**：
  - 登录：`npm run set-password` 在本机设置密码（scrypt N=2^17）。登录后每台设备一个 Cookie（`__Host-vesper`，HttpOnly、Secure、SameSite=Strict，30 天滑动续期）；Edge 在 `http://127.0.0.1` 上也接受。写操作要求 Origin 在白名单内并带 `x-vesper: 1` 头。WebSocket 用一次性票据（60 秒）。同一 IP 每分钟 5 次，连错 10 次锁 15 分钟；全局只放慢、不锁死。改密码、退出登录会断开这台设备的所有连接。
  - 项目就是命名的文件夹。新建时可以在默认目录下新建文件夹，或从本机磁盘选一个已有文件夹（不允许网络路径）。删项目会结束里面的会话，文件夹保留。
  - 标签：每个标签是一个 ptyd 会话，可拖动排序、双击改名。只有前台标签保持连接和 WebGL；切回后台标签时从断开处续传。不属于任何项目的会话放在"未归类"。
  - profile：第一次启动时从 WT 的 settings.json 导入（只读名字和命令行），补上 PowerShell、命令提示符、Git Bash 和已安装的 Claude Code、Codex、Gemini。网页只能选 profile，不能发送命令行。
  - ptyd 协议 v3：除了三种 shell，也能启动 profile 里的命令。ptyd 重启后，shell 照旧在历史下面重新启动；命令不会自动重跑，显示"已结束"，可以在标签里点"重新启动"。新增 OSC 9 和 OSC 777 提醒（M2b 的提醒中心会用到）。
  - 界面改用 React 19；字体改用官方 Cascadia Mono（v2407.24，OFL）。
  - 延迟（本机，含登录后的完整链路）：cmd p50 1.98ms，p99 3.0ms。
  - 测试：570 个通过；覆盖率 语句 91.3%、分支 84.4%、函数 93.1%、行 94.9%。真实浏览器（Edge）测了登录、建项目、开标签、刷新、重启 web、重启 ptyd、第二台设备登录、关标签。
- **M2b 结果（2026-10-17）**：
  - 提醒中心：来源是程序退出和 OSC 9/777。提醒存在 web 的数据库里，已读状态所有设备共享。铃铛列出所有项目的未读提醒，点一条打开对应标签。新提醒会响提示音（每台设备单独开关），页面不在前台时弹系统通知，网页标题和 PWA 图标上显示未读数。正在看的标签来的提醒直接算已读。
  - 快捷键：Ctrl+Shift+T/W/F，Ctrl+(Shift+)Tab；Ctrl+C 有选中时复制；agent 标签里 Shift+Enter 发 `ESC CR`。不全屏时浏览器会抢走 Ctrl+Tab 和 Ctrl+Shift+T/W；全屏按钮会用 Keyboard Lock 把 Ctrl+W/T/N/Tab 交给页面。e2e 用 CDP 发键，绕过浏览器自己的快捷键，所以浏览器抢键这件事只能手动验证。加了查找插件和 OSC 52 剪贴板插件。
  - 设置页：默认项目目录、提示音、profile 的增删改和排序（命令、参数、环境变量、权限、agent、Claude 的 `--dangerously-skip-permissions`）。环境变量的值不发回浏览器。浏览器从此能编辑命令行：登录的人本来就能开 shell，没有新增风险。
  - 普通权限启动：
    - ptyd 协议 v4，会话库 v3：会话记下自己的权限，重启和恢复时照旧。
    - `packages/ptyd/launcher/vesper-launch.cs`：ptyd 第一次需要时用系统自带的 csc.exe 编译到 `<home>\bin\vesper-launch-<源码哈希>.exe`。它用 CreateRestrictedToken 去掉特权、Administrators 改为仅拒绝，完整性降到 Medium，再给令牌换上自己的默认 DACL 和属主（不换的话 Git Bash 建不了管道），然后 CreateProcessAsUserW 在同一个控制台里启动程序。
    - 实测：Medium 完整性、写不了 C:\Windows；能读写项目目录和 `~\.claude`；git 没有 dubious ownership；node 正常；Ctrl+C 只到子进程；退出码转发；结束标签时整棵进程树都结束。
    - ptyd 是管理员时，启动时把 Vesper 的数据目录（令牌、数据库、启动器）设成只有 SYSTEM 和 Administrators 能访问。实测普通权限进程读不了、写不了、改不了权限（虽然它是属主）、也换不了启动器。
    - 保护目录失败时，ptyd 拒绝启动普通权限会话，不会退回管理员令牌。协议里 `elevation` 必填，漏了就报错，不会默认成 admin。管理员身份的启动器在自己受保护的 `bin` 目录里启动，子进程的工作目录通过环境变量传过去，避免会话目录里放的 DLL 被提权加载。编译用的是复制进 `bin` 的源码，哈希的和编译的是同一份字节。
    - 已知限制（安全审查结论）："普通权限"只防误操作，不是沙箱。
      - 普通和管理员会话是同一个用户、同一个用户配置。普通权限的程序能改之后会被管理员进程执行的东西：HKCU 的 Run 和环境变量、启动文件夹、PowerShell/bash 配置、npm 全局命令、`~/.claude` 的 hooks。它还能用同一个用户的 DPAPI 解出浏览器里的登录 Cookie，再从网页开管理员 shell。真正隔离要单独的账户或 AppContainer。
      - ptyd 现在从代码目录运行，`dist/` 和启动器源码普通权限也能改。M4 装到受保护的目录后解决。
      - 以后如果 ptyd 以 SYSTEM 服务运行，受限令牌里还会留着 SYSTEM 的 SID，那时要改用登录用户的令牌。
  - 测试：576 个通过。真实浏览器 e2e 加了提醒、Ctrl+Shift+T、Ctrl+Tab、查找。
- **M3 agent**：
  - 三家 agent 的注入、状态机和提醒
  - resume、接管外部会话、worktree
- **M3a 结果（2026-10-17）**：注入、状态机、提醒、重启续接。
  - ptyd 协议 v5，会话库 v4（记下 agent 自己的会话 ID）。profile 的 agent 类型随启动命令传给 ptyd。
  - ptyd 在 127.0.0.1 的随机端口收 hook，每个会话一个随机令牌在路径里，收到就回 `{}`，不阻塞 agent。
  - 注入：Claude 用 `--settings <内联 JSON>` 的 HTTP hook，加 `--session-id`；Codex 用 `-c notify=[curl.exe …]`（不需要 node 脚本）和 OSC 9；Gemini 用 `GEMINI_CLI_SYSTEM_DEFAULTS_PATH` 指向的 hook 文件，hook 也是 curl。管理员 agent 的 hook 文件放在受保护的会话目录，普通权限的放在 %TEMP%。
  - 状态机（`agent-state.ts`）照 §7.2：只在进入"等待确认"和"已完成"时提醒；"已完成"等 250ms 和输出停 1 秒（最多等 5 秒）。Claude 和 Gemini 收到第一个 hook 后不再看窗口标题；Codex 只报完成，"工作中"靠标题的转圈符号。完成后用户打字回到空闲。
  - 重启 ptyd 后 agent 照旧显示"已结束"；点"重新启动"会用记下的会话 ID 续接（Claude/Gemini `--resume <id>`，Codex `resume <id>`）。
  - 标签上的点：工作中蓝色闪动，等待确认琥珀色，已完成绿色，空闲灰色。
  - 测试：假的 Claude（node 脚本，按注入的 settings 发 hook）跑通了等待确认、已完成两条提醒和重启续接。真的三家 CLI 没有在自动测试里跑（会用你的账号）；Codex 和 Gemini 的注入格式要你验收时实测。
  - 还没做（M3b）：接管外部会话、worktree。
- **M3b 结果（2026-10-18）**：worktree 和接管外部 Claude 会话。
  - worktree：项目标签栏的 ⌄ 菜单里，agent profile 多一项"独立 worktree"。输入名称后，web 执行 `git worktree add <项目父目录>/<项目名>-worktrees/<名称> -b vesper/<名称>`，agent 在这个目录里启动。名称只允许字母数字和 `._-`，必须以字母或数字开头；项目不是 git 仓库时拒绝。会话创建失败会撤销刚建的 worktree。标签记下 worktree 路径和分支（web 数据库迁移 v2）。
  - 关闭这样的标签时多问一句"是否删除 worktree"。删除不加 `--force`：有未提交改动就保留 worktree；分支有未合并提交就保留分支，原因显示在状态栏。
  - 接管：首页的"外部会话"区列出 `~/.claude/sessions/<pid>.json`（认 `CLAUDE_CONFIG_DIR`），只保留进程还活着、创建时间（FILETIME）和记录里的 `procStart` 一致、进程名是 claude 的；Vesper 已经托管的会话不列出。点"接管"：重新核对 pid 和会话 ID，要求状态是 idle（工作中不允许），结束原进程并等它退出（5 秒内没退出就报错，不继续），再在同一目录用 `--resume <id>` 启动，归入对应项目；没有对应项目时按文件夹名新建，建不了就放"未归类"。
  - ptyd 协议 v6：创建会话可带 `resumeId`（只能用于 agent 命令，格式同会话 ID）。旧版 ptyd 会拒绝 v6 的连接，不会悄悄忽略 `resumeId` 而变成一个新对话。
  - 没做：Codex、Gemini 的接管（会话 ID 要从命令行或会话文件推断，没有实测过）；接管后检查 SessionStart 的 source 是否为 resume。
  - 测试：612 个通过。worktree 测试用真实 git；接管没有跑真实 Claude，要你验收时实测。
- **M4 安全与部署**：
  - 登录限速、设备管理、审计日志
  - 计划任务自启
  - frpc 和 caddy/nginx 的配置与文档，经公网实测
- **M4 结果（2026-10-19）**：设备管理、审计日志、部署。
  - 登录限速在 M2a 已做好。设置页新增"已登录的设备"：名称、IP、最近使用和登录时间，可以注销其他设备（注销后它打开的连接立即断开）。注销当前设备用"退出登录"。
  - 审计日志（web 数据库迁移 v3，最多保留 5000 条）：登录、登录失败、退出、注销设备、新建/关闭/接管会话，记下设备和 IP。设置页可以查看最近 200 条。
  - `npm run deploy -- --origin https://域名 [--start]`（要在管理员终端里运行）：把运行时复制到 `%ProgramFiles%\Vesper`。工作区包只复制 `package.json`、`dist`（ptyd 还有 `launcher`）；依赖按 `dependencies` 递归复制，没装上的可选依赖（其他平台的二进制）跳过。实测复制 14 个包、76 MB，副本在仓库外能独立启动 web 和 ptyd，并能开 cmd 会话。
    - 目录 ACL：SYSTEM 和 Administrators 完全控制，Users 读和执行，属主是 Administrators。已有的目录只有在里面有部署标记（`vesper-install.json`）或为空时才会被替换。Vesper 还在运行时拒绝部署。
    - 计划任务"Vesper"：登录时触发，最高权限，用电池也启动，不限运行时间。它运行 `wscript start.vbs`，用隐藏窗口启动 web；web 再启动 ptyd。`start.vbs` 写入 `VESPER_HOME`、`VESPER_ORIGINS`、`VESPER_LOG_FILE`；`--origin` 只接受 `https://主机名[:端口]`。
    - 隐藏运行时没有控制台，`VESPER_LOG_FILE` 把 web 的日志写到 `<home>\logs\web.log`（超过 10 MB 轮换一次）。
    - `npm run undeploy` 删除计划任务和部署目录，会话数据保留。
  - frp（按 v0.71.1 的官方示例核对语法）和 Caddy 的模板在 `deploy/`，步骤和公网验收清单在 `docs/deploy.md`。frps 用 `proxyBindAddr = "127.0.0.1"`，Vesper 的端口只有 Caddy 能访问；frpc 和 frps 之间强制 TLS，并用令牌认证。
  - 安全审查发现 3 个问题，都是普通权限会话能让代码以管理员身份运行，已全部修复：
    - 严重：查外部会话时 web 以管理员身份调 PowerShell 的 Get-Process。`-NoProfile` 挡不住模块自动加载，用户的 PSModulePath 里放一个导出 Get-Process 的模块就会被执行（审查时实测过）。改用 koffi 直接调 OpenProcess、GetProcessTimes、QueryFullProcessImageNameW。实测时发现 Claude 自动更新后，正在运行的那个程序会被改名为 `claude.exe.old.<n>`，这个名字也认。
    - 高：管理员身份的 git 会执行仓库 `.git` 里的 hook、fsmonitor 和 filter，而普通权限的 agent 能写 `.git`。现在 web 是管理员时，git 经 vesper-launch 用受限令牌运行（和普通会话一样，启动器在受保护的 `bin` 目录里）。保护数据目录失败时直接拒绝运行 git，不会退回管理员。测试用真实编译的启动器跑了 worktree 的创建和删除。
    - 高：计划任务继承用户环境变量（HKCU\Environment），普通权限能写。`start.vbs` 现在先删掉所有 `NODE_*`（如 `NODE_OPTIONS=--require`）和 `VESPER_*`，从 HKLM 读回 SystemRoot、windir、ComSpec（ptyd 用 SystemRoot 拼 cmd、PowerShell、icacls、csc 的路径），再设 `WS_NO_BUFFER_UTIL`、`WS_NO_UTF_8_VALIDATE`（否则 ws 会在安装目录外找可选模块，比如 `C:\node_modules`）。测试用 cscript 跑真实脚本，核对清理后的环境。
    - 另外：`resumeId` 不能以 `-` 开头，否则放在 `--resume` 后面会被当成别的参数。
    - 仍然接受的风险：PATH 和 PowerShell 配置照旧继承（agent 要靠用户 PATH 找到 npm 全局命令），属于 M2b 已列的"普通权限只防误操作"。
  - 没做：公网实测（要用你的服务器）；deploy 本身没有在管理员终端里跑过（这个终端是 Medium 完整性），ACL 和计划任务要你验收时实测。
  - 测试：618 个通过，3 个跳过。folders 的符号链接用例在没有权限创建符号链接的终端里会跳过。
- **L1 Linux**（2026-10-19 开始；macOS 以后再做）：
  - 以普通用户运行，不分管理员和普通权限（需要 root 时在 shell 里用 sudo）。ptyd 在 Linux 上把所有会话都当作普通权限，界面不显示权限选项。
  - 数据目录 `$XDG_DATA_HOME/vesper`（默认 `~/.local/share/vesper`），权限 0700。web 和 ptyd 之间改用数据目录里的 Unix socket（`run/ptyd.sock`）；进程崩溃后留下的旧 socket，下次启动时确认没有进程在用再删掉。
  - shell：bash、zsh、fish，以及 sh（不报告当前目录）。程序路径从 `/etc/shells` 和 PATH 里找。
    - bash 用 `--rcfile`：先按登录 shell 的顺序加载 `/etc/profile` 和用户的 profile，再挂上报目录的 hook；PROMPT_COMMAND 无论是字符串还是数组都保留原来的内容。
    - zsh 用 ZDOTDIR 指向 Vesper 的目录，里面的文件再加载用户自己的配置。
    - fish 用 `--init-command` 挂 `fish_prompt` 事件。
    - nonce 通过环境传给 shell，装好 hook 后立即 unset，不留在日常命令的环境里；它只防终端输出伪造，不隔离同用户代码。fish 的 `--init-command` 在用户配置之后执行，所以配置启动的子进程可能看到初始化环境。
  - 命令：有程序路径的直接启动，命令行交给 `/bin/sh -c`。
  - 结束进程树：node-pty 让 shell 成为一个会话的首进程，结束标签时按 `/proc` 里的会话 ID 结束整个会话。shell 自己 setsid 出去的进程不在内，和 Windows 上脱离 job 的进程一样；ptyd 被 SIGKILL 时也不能保证执行用户态清理。
  - 不需要 ConPTY 的那些处理：resize 时调整行、DA1 预热、按光标位置重新对齐，在 Linux 上都关掉。真正的 pty 收到 SIGWINCH 后由程序自己重画。
  - 外部 Claude 会话：Claude 在 Linux 上的 `procStart` 是 `/proc/<pid>/stat` 的第 22 个字段（starttime），这是从 claude.exe 里的代码读出来的，要在服务器上核实。
  - 部署：systemd 用户服务，`KillMode=process`，这样重启 web 时 ptyd 和会话不受影响。PATH 用部署时 shell 里的值，否则 nvm 装的 node 和 agent 找不到。
  - node-pty 1.1.0 没有 Linux 的预编译包，`npm install` 时会用 node-gyp 编译，需要 python3、make、g++。
  - 本地验证（2026-10-20，Windows）：`npm run build` 通过；全仓回归 662 个通过、9 个跳过，包含 Windows 回归、首次密码设置权限回归和 Linux 纯逻辑／部署 mock 测试。`npm run test:coverage` 的测试全部通过，但分支覆盖率 76.08% 未达 80% 门槛（行 88.25%、语句 83.80%、函数 86.46%），因此覆盖率检查失败，未降低门槛。Linux 原生 runtime 用例在此平台跳过，不能视为服务器验收。
  - Linux 实机验证（2026-10-20 至 2026-10-21，Ubuntu 22.04.5 x86_64，隔离普通用户，Node.js 26.8.2、npm 11.19.1）：`npm ci`、构建通过；Linux/CLI 定向 42 个通过、1 个跳过，全仓回归 597 个通过、74 个跳过。真实 native PTY 的启动、I/O、resize、退出码、同 SID 子进程终止、bash cwd hook，以及 koffi/libc flock、Unix socket 认证已覆盖；没有实跑 zsh/fish、真实外部 Claude、浏览器全链路或复制后的部署运行时。
  - 用户服务前置检查（2026-10-21）：测试账号没有 runtime dir / D-Bus / 活动用户管理器。已验证 deploy 在写入安装、数据和 unit 目录前明确失败，不提权；普通及特殊字符路径的 unit 通过 systemd-analyze 离线解析（退出码 0，缺失 runtime dir 时仍有 private socket 提示）。未启用 linger、未启动正式服务。真实 enable/start/stop/restart、ptyd 跨 web 重启存活、登出与公网链路仍未验收。
  - 部署安全补丁（2026-10-21）：4 个新增回归先失败，证实异步检查后出现的无关目录、父目录链接、复制期间出现的无关目录和卸载前丢失标记会被旧实现误覆盖/删除。修复后重新检查路径、标记与目录资格；共享 sticky 父目录必须已有可信的直接子路径，创建父目录后要求全部父路径存在。审查另发现成功 rename 后不应再检查或删除旧 stage 路径，新增第 5 个 RED→GREEN 回归并修复。独立安全及代码复核在各自范围内无剩余 HIGH/CRITICAL；路径校验不隔离同 UID 恶意并发。Windows CLI 测试最终 33 个通过、1 个 Linux 专用用例跳过；构建通过。首次默认并发全仓有 2 个 Windows PTY 用例失败（清理 EPERM、PowerShell 中文等待超时）；两文件串行重跑 49 个通过、2 个跳过；最终全仓 `--maxWorkers=2` 为 667 个通过、10 个跳过。该补丁上传被权限模式拦截，尚未在目标服务器复验，也未运行已准备的复制运行时 smoke；此前 Linux 成功结果不代表补丁通过。覆盖率未重新测量。部署步骤与边界见 `docs/deploy.md`。
  - 补充本地预检（2026-10-22）：WSL Ubuntu 22.04 普通用户 UID 1000 对构建后的路径校验模块完成 7 项真实文件系统检查；该环境 Node.js 22.23.2 低于项目要求，只补充路径安全证据，不代表完整运行时支持。隔离验收辅助脚本另有 10 项预检在 Windows / WSL 通过，覆盖归档内容绑定和失败清理，这 10 项的进程断言使用 mock；另在 WSL 对本次预检自建子进程完成 6 项真实 `/proc` 检查，验证入口 / home / starttime 筛选、SIGTERM / SIGKILL 后等待退出和排除对象未被误杀，已清理自建进程与临时目录。上述检查不替代真实 Vesper smoke，也不计入产品全仓测试数量。两份验收辅助脚本的窄范围静态安全复核已完成，无可证实的剩余 HIGH/CRITICAL，不代表整项移植的安全验收。三文件补丁包已在本地生成，未上传。
- **M5 打磨**：
  - 本地回显预测
  - 性能：大量输出、多会话同时运行
  - 手机适配
  - `vesper attach`：在本机 WT 里接入同一个会话。可以做：Node 24 在 Windows 上的 raw 模式已改用 VT 输入，Alt 组合键正常。限制是 Shift+Enter 会变成普通回车，Ctrl+Space 收不到；这是在 ConPTY 下实测的，WT 里预计相同。在这之前，本机可以直接用浏览器打开 `http://127.0.0.1:7690`，也可以装成 PWA 窗口。
- **M5 手机终端初版（2026-10-23，待真机验收）**：
  - 粗指针设备的终端页跟随 VisualViewport 的高度和顶部偏移，软键盘弹出／收起时重新报告可用空间；缩放时不重新适配布局，保留浏览器原生双指缩放。尺寸仍由服务端 size 帧决定，不在前端直接 fit。
  - 增加显示安全区、44px 触摸按钮、窄屏查找框和独立手机样式；可视高度低于 360px 时，快捷键切换为单排横向滚动，顶部状态栏压缩到同一行，避免横屏软键盘把终端挤掉；桌面鼠标布局不变。
  - 底部提供 Esc、Tab、Ctrl+C/D/Z/L、四个方向键和打开键盘按钮。方向键区分普通／应用光标模式，按键通过 xterm 公开 input API 进入已有 onData → connection.input 通道；查找期间禁用快捷输入，避免误发给 shell。
  - `npm run build -w @vesper/ui`（TypeScript 检查与 Vite 构建）通过，仍有大于 500 kB 的 bundle 提示。补充了按键编码用例，但按本轮要求未运行测试套件、未测覆盖率，也未启动服务；iOS／Android 软键盘、横竖屏、安全区及真实点击行为仍待验收。
  - 真机验收时检查：反复打开／收起软键盘后最后一行和快捷键均可见；横竖屏切换后无刘海或底部手势条遮挡；连续点 Tab／方向键不关闭键盘；切换标签后按键只进入当前会话；双指缩放仍可用；查找期间按键不会误发给 shell。Ctrl+D 可能退出 shell，需在可结束的临时会话里验证。

## 13. 测试

- 单元测试：帧的编码和解码、补发与快照之间的切换、状态机、登录限速、hook 解析。
- 集成测试，在真实 ConPTY 下跑：
  - 三种 shell、DA1 回复、中文、resize、结束进程树
  - ptyd 重启、web 重启之后会话不断
- 端到端测试，用 Playwright：
  - 登录后开标签打字
  - 断网重连后内容不丢不重
  - 两个浏览器同时输入
  - 提醒
- 覆盖率不低于 80%。分别测本机直连和经反代的打字延迟。参考值：在 pty 层实测，按键回显的中位数约 1.5ms。

## 14. 风险

- koffi 调 Job Object 还没验证过。不行就退回 `taskkill /T`，并先核对进程创建时间。
- `useConptyDll` 在 node-pty 的类型定义里标为实验性功能，不过 Orca 在正式版里一直在用。
- agent CLI 自己会升级，hook 格式可能变。这次调研期间，Claude 自动升到了 2.1.300，Gemini 被升到了 0.64.0。对策：每家 agent 单独做一层适配，另外保留兜底信号；到 M3 时按当时的版本重新核实。
- Codex 发出的"需要审批" OSC 9 通知，只在源码里看到，没有实测过。
- 浏览器占用的快捷键（见第 6 节）。
- 经反代时的延迟主要取决于服务器在哪。

## 15. 已确认的决定（2026-10-14）

1. 名称：Vesper。
2. 进程权限：设置里可选"管理员权限"或"普通权限"，按 profile 生效。
3. Claude 是否默认加 `--dangerously-skip-permissions`：设置里按 profile 选择。
4. Gemini 保持 0.64.0，不回退。
5. 代码放在 `D:\code\work_space\vesper`；新项目默认建在 `D:\code\work_space` 下，设置里可改。
6. 服务器在香港：不需要备案，部署文档按香港服务器写。

## 16. 参考与许可

- Termix（Apache-2.0）、Orca（MIT）、VS Code（MIT）、Windows Terminal（MIT）：主要借鉴设计。直接改写的代码，保留原来的版权和许可声明。
- Cascadia Mono 字体：SIL OFL 1.1，随附 OFL.txt。
- 调研时的临时文件（`%TEMP%\termhub-ref`、`%TEMP%\termhub-spike`：Termix、Orca 的源码副本和 node-pty 测试脚本）已在 M1 验收后删除。以后要参考（比如 M5 的本地回显预测参考 VS Code），用 `gh api` 重新拉取。

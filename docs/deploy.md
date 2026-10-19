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

1. 设置密码：`npm run set-password`。现在是公网服务，用 16 位以上的随机密码。
2. 构建：`npm run build`。
3. 停掉正在跑的 Vesper：关掉 `npm run demo` 的窗口，再运行 `npm run stop-host`。
4. 在"以管理员身份运行"的终端里部署：

   ```
   npm run deploy -- --origin https://vesper.example.com --start
   ```

   - 运行所需的文件会复制到 `C:\Program Files\Vesper`。这个目录只有 SYSTEM 和 Administrators 能改，普通权限的会话改不了以后会以管理员身份运行的代码。
   - 同时注册计划任务"Vesper"：登录 Windows 时以最高权限在后台启动，没有窗口；用电池时也启动，运行多久都不会被停掉。
   - 日志在 `%USERPROFILE%\.vesper\logs\`（`web.log`、ptyd 的日志）。
   - 会话数据还在原来的 `%USERPROFILE%\.vesper`，部署前的会话会照旧恢复。
   - 更新：重复第 2–4 步。卸载：`npm run undeploy`，会话数据保留。
5. frpc：把 `deploy/frpc.toml` 的 `serverAddr` 和 `auth.token` 改好，和 frpc.exe 放在一起（比如 `C:\Program Files\frp\`），用计划任务开机自启：

   ```
   schtasks /Create /TN "Vesper frpc" /SC ONLOGON /TR "\"C:\Program Files\frp\frpc.exe\" -c \"C:\Program Files\frp\frpc.toml\"" /F
   ```

   frpc 不需要管理员权限。它的窗口会出现在桌面上，可以最小化。

部署之后不要再在本机运行 `npm run demo`：两者共用同一个数据目录和 7690 端口。开发时先 `npm run undeploy`，或者结束已部署的 node 进程。

## 3. 公网验收

用手机流量（不经过本机网络）打开 `https://你的域名`：

- 能登录、开标签、打字；刷新页面后会话还在。
- 设置页的设备列表里，手机显示的是它的公网 IP，不是 127.0.0.1。
- 输错 5 次密码后被限速（提示稍后再试）；审计日志里有这几次失败和对应的 IP。
- 在设置页注销手机，手机上的页面立即断开，需要重新登录。
- 在本机重启 frpc 或断网再恢复，页面会自己重连。

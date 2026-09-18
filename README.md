# WebMCP Bridge

`webmcp-server` 是唯一的桥接服务端项目，软件包为 `@webmcp/bridge`，命令为 `webmcp-bridge`。它通过标准 Streamable HTTP MCP 接口，将 AI 客户端的请求转发给浏览器插件明确共享的页面工具。

仅保留个人使用的本机 HTTP、远程 HTTPS/WSS、独立角色令牌、目录与调用路由。没有账号系统、OAuth、数据库、设备管理 API、stdio 或演示业务工具。Node.js 24（开发验证版本见 `.node-version`）。

## 一条命令在本机运行

需要 Node.js 24+（自带 npm/npx）。包发布到 npm 后执行：

```sh
npx -y @webmcp/bridge
# 自定义端口或凭证位置
npx -y @webmcp/bridge --port 38473 --config /absolute/private/credentials.json
```

首次运行仅在凭证文件不存在时自动初始化，显示插件 origin/token 和 MCP URL/Authorization，然后前台启动。将两组接入信息分别填入插件与 AI 客户端。默认地址是 `http://127.0.0.1:38472`，MCP 地址为该 origin 下的 `/mcp`，使用 Streamable HTTP。保持终端运行，Ctrl+C 停止服务；这不是 stdio 服务或后台守护进程。

后续运行复用 `~/.config/webmcp-bridge/credentials.json`，不再次显示 token。遗失 token 可使用 `issue` 签发或 `rotate` 轮换。已有空凭证文件、损坏文件或不安全权限不会被自动覆盖；并发初始化失败时确认另一个进程的输出后重试。远程模式和显式 `serve` 仍需先执行 `init`。

```sh
npx -y @webmcp/bridge list
npx -y @webmcp/bridge issue --role agent
npx -y @webmcp/bridge issue --role device
npx -y @webmcp/bridge rotate --id 凭证ID
npx -y @webmcp/bridge --help
```

## 安装与启动

在本项目目录执行，构建及测试无需插件源码：

```sh
npm ci
npm run check
npm run check:tests
npm test
npm run package
npm install -g ./artifacts/webmcp-bridge-0.1.0.tgz
webmcp-bridge init
webmcp-bridge serve
```

不安装全局命令时，使用 `node dist/cli.js` 代替 `webmcp-bridge`。构建前清理 dist，安装包只包含桥接及协议相关产物。`npm run dev` 监听源码并重启开发服务。

`init` 仅首次运行，输出两种独立凭证与接入信息：

- 插件填写 origin `http://127.0.0.1:38472` 和 `plugin.token`，保存并开启连接，再共享页面和工具。浏览器身份自动生成。
- AI 客户端配置 URL `http://127.0.0.1:38472/mcp`，请求头为 `Authorization: Bearer <agent.token>`。Agent 与插件令牌不能混用。

支持允许自定义 Bearer 请求头的 MCP 客户端。服务不提供 OAuth 浏览器登录；原生页面工具是否可用仍取决于浏览器及页面 WebMCP 支持。

## 凭证管理

```sh
webmcp-bridge list
webmcp-bridge issue --role agent
webmcp-bridge issue --role device
webmcp-bridge rotate --id 凭证ID
webmcp-bridge revoke --id 凭证ID
```

默认使用 `~/.config/webmcp-bridge/credentials.json`，或通过 `--config` / `BRIDGE_CONFIG_FILE` 指定。管理命令与服务必须指向同一文件。目录要求 0700、文件要求 0600；只存令牌散列、角色与浏览器绑定，拒绝符号链接及过宽权限。并发写入用锁文件保护；异常遗留锁需先确认没有进程修改该文件再清理。

签发或轮换时显示一次明文令牌；`list` 仅显示 ID 与角色。轮换保留凭证 ID 和浏览器身份，旧令牌不能再发新请求。已连接插件约 1 秒内复核并断开；正在执行的调用在返回前再次校验身份，撤销后不释放业务结果。撤销 device 凭证同时删除其浏览器绑定。

个人实例的有效 Agent 可访问所有已共享浏览器。每个浏览器可以使用独立 device 令牌；同一浏览器身份不能被其他凭证 ID 接管，可轮换原凭证，或撤销后重新接入。

当前轻量桥接的端口、凭证文件与令牌保持兼容，无需重新初始化。旧 WebMCP Service 数据库和旧 pairings 文件不自动导入，也不会被删除。

## 对外接口与行为

标准 `/mcp` 只提供：

| 工具 | 输入 |
| --- | --- |
| `list_webmcp_pages` | `{}` |
| `list_webmcp_tools` | `{pageId}` |
| `call_webmcp_tool` | `{pageId,catalogVersion,toolName,arguments}` |

先发现页面与当前目录，再调用工具。结果同时提供 MCP `content` 与 `structuredContent`。插件通过 `POST /bridge/ticket` 获取一次性票据，再连接 `/bridge/ws`；这部分是专用的版本化桥接协议，不是任意 MCP 服务都支持的接口。完整契约见 [协议说明](protocol.md)。

每个文档同一时间执行一次。超时、断线或无法确认取消时返回 `unknown`，不自动重试；原始执行未结束时保留锁。导航、撤销共享及目录变化使旧目标失效，重连只登记目录，不重放业务调用。默认 10 个在线浏览器、每浏览器 100 个页面、每页 200 个工具；参数 256 KiB、结果 1 MiB、消息 2 MiB。隔离 Worker 限制动态 Schema 校验时间。

`/health/live` 检查进程，`/health/ready` 检查凭证文件可用且已初始化。stderr 日志只记录运行状态、调用 ID、工具名称及耗时，不持久化业务载荷。客户端请求超时建议至少 75 秒，高于默认工具期限 60 秒。

## 远程部署

远程需要 TLS 反向代理与有效证书，后端默认仅监听 loopback：

```sh
DEPLOYMENT_MODE=remote \
PUBLIC_BASE_URL=https://bridge.example.com \
webmcp-bridge serve
```

插件填写 HTTPS origin，AI 填写该 origin 下的 `/mcp`。Host 使用明确白名单，不允许通配符。Origin 不做白名单校验，插件通过独立令牌认证。代理保留 Host，支持 WSS 升级，关闭 SSE 缓冲，超时至少 120 秒。配置样例见 `.env.example`；Node 不自动读取 `.env`，可使用 `node --env-file=.env dist/cli.js serve`。

Docker Compose 仅包含 app 和 Nginx，不包含数据库。准备 `.env` 的 `MCP_DOMAIN`，以及 `deploy/certs/fullchain.pem`、`privkey.pem`：

```sh
docker compose --env-file .env -f deploy/compose.yaml build app
docker compose --env-file .env -f deploy/compose.yaml run --rm app node dist/cli.js init
docker compose --env-file .env -f deploy/compose.yaml up -d
```

凭证保存于独立 `bridge-data` 卷中的 `/data/private/credentials.json`，以容器 node 用户创建私有目录。重启或重建时保留该卷；已有凭证时跳过 init。只有代理公开 443，app 的 38472 仅用于容器网络。管理令牌使用 `docker compose ... exec app node dist/cli.js list|issue|rotate|revoke`。

若从旧 Compose 部署升级，不运行 `down -v` 或清理 orphan 数据卷；此项目不迁移或删除旧数据库、证书与配置。现有本机凭证不会自动复制到新 Docker 卷。

## 开发与验收

```sh
npm run check
npm run check:tests
npm test
npm run test:https
npm run test:package
npm run format:check
```

HTTPS 测试使用 OpenSSL 临时证书及本地反向代理，保持 TLS 验证开启；安装包测试在临时独立目录安装 tarball 并重跑集成测试。它们不依赖插件工程、真实数据库或外部身份服务。

真实浏览器验收由插件工程负责：先构建服务端，再在插件工程设置 `WEBMCP_BRIDGE_MODULE=/absolute/path/to/webmcp-server/dist/index.js`，运行 `npm run test:bridge-browser`。也可以指向独立安装包的 dist/index.js。`BROWSER_EXECUTABLE` 可指定支持原生 WebMCP 的 Chrome for Testing。

`src/browser/protocol.ts` 是桥接契约的唯一源，构建将其原样放入 `dist/bridge-v1.ts`。插件通过显式同步脚本生成本地副本，跨项目测试会先核对一致性。协议升级需更新源、构建、同步插件并一起验收。

## 构建安装包与发布

发布前也可直接运行本地安装包（把路径替换为本次打包产物的绝对路径）：

```sh
npm run package
npx -y --package=/absolute/path/webmcp-bridge-0.1.0.tgz webmcp-bridge
npm run test:package
```

安装包测试在独立临时目录使用真实 npx 入口验证首次启动和重启，再对安装产物运行集成测试。安装包版本跟随 package.json。

实际发布前核实 npm 账号具有 `@webmcp` scope 发布权限及包名可用性，完成检查与测试，再运行：

```sh
npm login
npm publish --access public
```

当前工程准备好安装包不代表已发布到 npm；只有发布完成后才能使用上方公开包名下载运行。

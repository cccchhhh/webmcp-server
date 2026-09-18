# 纯桥接收敛验收

日期：2026-09-17。Node.js 24.18.0，macOS arm64。

## 已完成

- 项目统一为 `@webmcp/bridge`，保留标准 MCP、浏览器票据与 WebSocket、私有令牌文件、执行路由及隔离 Schema 校验。
- 删除旧 OAuth、PostgreSQL、迁移 SQL、数据库审计、设备／Agent 授权管理、stdio、演示工具、旧配对 CLI、模拟插件入口和过时设计文档。
- 删除插件仓库的重复桥接代码、构建／打包脚本和 tarball。协议由本项目维护，插件仅保留生成副本，跨项目验收先检查一致性。
- 类型检查（源码及测试）通过；6 项服务端集成／Schema 测试通过。验证角色和来源隔离、多浏览器路由、工具发现与调用、旧目录、断线、撤销后隐藏结果、插件令牌轮换、远程撤销和 Worker 超时。
- 独立安装包在工作区外临时目录安装成功；CLI 初始化、签发、轮换、撤销正常；旧 pair / grant / stdio 命令拒绝执行。使用安装后的程序重新跑完 6 项测试，包含打包的校验 Worker。
- 本地 TLS 反向代理下，官方 MCP Client 通过 HTTPS 调用，插件协议通过 WSS 返回结果；只信任临时测试证书，未关闭证书校验。记录见 `test-results/https.json`。
- 插件项目使用本项目产物完成 15 项真实浏览器回归，覆盖后台重启、重连、共享撤销、版本失效和未知结果锁。
- Compose YAML 静态解析通过，仅有 app 和 proxy；凭证使用 bridge-data 持久化卷。旧数据库、用户凭证、证书和配置未删除。
- 本机运行服务已切换到本项目，使用原 38472 端口、插件 Origin 及原凭证。原 Agent 令牌只读发现三个 MCP 工具成功；切换前后当前共享页面均为 0，没有执行业务工具。

## 复现

```sh
npm ci
npm run check
npm run check:tests
npm test
npm run test:https
npm run test:package
npm run format:check
```

插件真实浏览器测试需在插件项目执行，并明确设置 `WEBMCP_BRIDGE_MODULE` 指向本项目或安装包的 `dist/index.js`。

## 未验收范围

当前没有 Docker 可执行程序，因此没有执行镜像构建或 Compose 部署。未执行真实公网域名、生产 TLS 证书、Nginx 运行环境或第三方 AI 平台验收。未公开发布 npm 包，未部署公网服务。

## npm / npx 一键启动验收（2026-09-18）

环境：macOS arm64，Node.js 24.18.0。

- `npm run check`、`npm run check:tests`、`npm run format:check` 通过。
- `npm run test:package` 通过；生成 `artifacts/webmcp-bridge-0.1.0.tgz`（15 个文件，约 87.3 kB）。发布白名单限定部署模板，不包含凭证、日志或证书。
- 在源码目录和安装前缀之外的临时目录，经 `npx --yes --package=<tarball> webmcp-bridge` 首次自动初始化并启动，健康检查通过；磁盘权限为 0600，仅存 token 散列。
- 重启不输出凭证、不改写凭证文件；原插件 token 获取 ticket 成功，原 Agent token 完成 HTTP MCP initialize。
- 验证 Ctrl+C 退出、端口占用报错、损坏／空／权限过宽凭证、符号链接、目录权限异常均按预期处理；显式 serve 与远程模式不自动初始化。
- 八路并发初始化只签发一组凭证，未覆盖获胜进程的 token。
- 对独立安装的产物运行现有 6 项服务端集成／Schema 测试，全部通过。
- 本次未发布 npm，未重复执行真实浏览器或远程 HTTPS 验收，也未修改本机已有服务及其凭证。

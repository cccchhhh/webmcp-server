# 浏览器桥接契约 v1

规范源位于服务端项目的 `src/browser/protocol.ts`；插件项目 `packages/protocol/bridge-v1.ts` 为生成副本。服务端构建产物包含 `dist/bridge-v1.ts`。

```sh
WEBMCP_BRIDGE_MODULE=/absolute/path/to/webmcp-server/dist/index.js npm run sync:bridge-protocol
WEBMCP_BRIDGE_MODULE=/absolute/path/to/webmcp-server/dist/index.js npm run check:bridge-protocol
```

仅显式同步和跨项目测试读取指定服务端产物；正常构建与单元测试独立运行。跨项目浏览器测试在建立连接前检查两份协议完全一致。

对外 `/mcp` 是标准 MCP Streamable HTTP。下述接口属于浏览器桥接协议，不是 MCP 标准扩展点，因此不能以任意第三方 MCP 服务器替代桥接程序。

## 认证与连接

1. 插件在已获准访问的服务 origin 向 `POST /bridge/ticket` 提交 `{deviceId, deviceName}`，使用 `Authorization: Bearer <plugin-token>`。`deviceId` 是插件自动生成并保存在本机的 UUID，`deviceName` 最长 60 字符。
2. 独立桥接绑定该浏览器与 device 凭证，返回 `{ticket, expiresAt, wsUrl}`。票据有效期 30 秒、单次使用，`wsUrl` 固定为该 origin 的 `/bridge/ws`，远程使用 WSS。
3. WebSocket 建立后 5 秒内发送 `AUTH`。令牌和票据不进入 URL。服务返回 `AUTH_OK`，含 `deviceId` 与本次 `connectionEpoch`；messageId 与认证请求一致。
4. 后续客户端消息携带该 epoch。重复设备连接替换旧连接；旧目录和路由失效。每 20 秒 `PING/PONG`，60 秒无心跳断开。

## 消息与路由

信封为 `{protocolVersion:1,messageId,connectionEpoch?,payload}`。UUID messageId 用于响应关联；服务端响应都携带 epoch。未知字段、非法版本和超出 2 MiB 的消息被拒绝。消息字段及枚举以共享契约为准。

- `REGISTER_PAGE` / `PAGE_REGISTERED`：发送本地页面标识、文档标识、目录版本、已授权工具和执行状态；服务分配 pageId。URL 只保留 origin + pathname。
- `SYNC_CATALOG`、`REMOVE_PAGE`、`REVOKE`、`PAGE_STATE`：同步目录、页面撤销、工具授权与文档锁状态，返回带 replyTo 的 `APPLIED` 或 `ERROR`。
- `CALL`：服务发出 `{target,callId,toolName,arguments,deadlineAt}`。target 同时包含 pageId、localPageId、documentId、catalogVersion，防止跨页面或旧文档误调用。
- `CALL_ACK`：插件确认接收或拒绝。`CALL_RESULT`：返回业务结果、错误码及 executionSettled。服务收到结果后再次核对 Agent、插件和页面授权。
- `CANCEL` / `CANCEL_ACK`：传达取消意图及是否支持；不意味着页面操作已停止。

页面刷新、SPA 路由或原生目录变化遵守插件原有失效规则。网络重连可以同步目录，但绝不重放 CALL。超时或中断采用 unknown 结果，未确认执行结束时保留锁；晚到结果只能收尾，不能再次发布为原请求成功。

## 标准 MCP 工具

- `list_webmcp_pages({})` → `{pages:[{pageId,deviceId,deviceName,title,url,catalogVersion}]}`。
- `list_webmcp_tools({pageId})` → `{pageId,catalogVersion,tools}`。
- `call_webmcp_tool({pageId,catalogVersion,toolName,arguments})` → `{callId,pageId,catalogVersion,toolName,delivery,execution,business,rawResult?,errorCode?,message?}`。

结果同时提供 MCP 文本 content 和 structuredContent。delivery 为 not_sent / sent / acknowledged；execution 为 returned / rejected / unknown。错误结果不等于业务操作一定没发生。沿用既有语义，不将每个页面工具动态注册成全局 MCP 工具。

## 插件配置升级

连接设置仅提供轻量桥接，保存固定提交 `connectionType: bridge`；浏览器身份自动生成并通过独立 `bridgeDeviceId` 持久化。已有轻量桥接配置原样保留；加载 legacy 或未标记类型的旧服务配置时，停用连接、清除旧凭证与共享，恢复轻量桥接默认地址，需重新填写插件令牌。不接受旧类型的配置命令；旧存储仅用于识别并停用，不再保留旧连接实现。

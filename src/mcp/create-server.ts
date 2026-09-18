import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Principal } from "../types.js";
import { AppError, alive } from "../types.js";
import type { Gateway } from "../browser/gateway.js";
import { callInput, outcomeSchema, tool } from "../browser/protocol.js";
const result = (
  data: Record<string, unknown>,
  isError = false,
): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  structuredContent: data,
  ...(isError ? { isError: true } : {}),
});
function scope(p: Principal, s: string) {
  if (!alive(p) || !p.scopes.includes(s)) throw new AppError("FORBIDDEN", 403);
}
async function safely(fn: () => Promise<Record<string, unknown>>) {
  try {
    return result(await fn());
  } catch (e) {
    return result(
      { errorCode: e instanceof AppError ? e.code : "INTERNAL_ERROR" },
      true,
    );
  }
}
export function createServer(p: Principal, gateway?: Gateway) {
  const server = new McpServer({ name: "webmcp-bridge", version: "0.1.0" });
  if (gateway) {
    server.registerTool(
      "list_webmcp_pages",
      {
        description: "列出当前身份获授权的在线浏览器页面",
        inputSchema: z.object({}).strict(),
        outputSchema: z.object({
          pages: z.array(
            z.object({
              pageId: z.string(),
              deviceId: z.string(),
              deviceName: z.string(),
              title: z.string(),
              url: z.string(),
              catalogVersion: z.string(),
            }),
          ),
        }),
      },
      () =>
        safely(async () => {
          scope(p, "webmcp:read");
          return gateway.list(p);
        }),
    );
    server.registerTool(
      "list_webmcp_tools",
      {
        description: "读取页面获授权的工具及目录版本",
        inputSchema: z.object({ pageId: z.string().uuid() }).strict(),
        outputSchema: z.object({
          pageId: z.string(),
          catalogVersion: z.string(),
          tools: z.array(tool),
        }),
      },
      ({ pageId }) =>
        safely(async () => {
          scope(p, "webmcp:read");
          return gateway.catalog(p, pageId);
        }),
    );
    server.registerTool(
      "call_webmcp_tool",
      {
        description:
          "调用获授权页面工具并等待结果；结果未知时禁止自动重试，需先核实业务状态",
        inputSchema: callInput,
        outputSchema: outcomeSchema,
      },
      async (input, ctx) => {
        try {
          scope(p, "webmcp:call");
          const out = await gateway.call(p, input, ctx.mcpReq.signal);
          return result(
            out,
            out.execution !== "returned" || out.business === "error",
          );
        } catch (e) {
          return result(
            { errorCode: e instanceof AppError ? e.code : "INTERNAL_ERROR" },
            true,
          );
        }
      },
    );
  }
  return server;
}

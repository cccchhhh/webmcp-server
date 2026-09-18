import {
  createServer as httpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { z } from "zod";
import type { Logger } from "pino";
import type { Config } from "./config.js";
import { AppError, type Principal } from "./types.js";
import { PersonalStore } from "./store.js";
import { ValidationPool } from "./validation/pool.js";
import { Gateway } from "./browser/gateway.js";
import { createServer } from "./mcp/create-server.js";
const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
};
async function body(req: IncomingMessage, max: number) {
  let size = 0;
  const chunks: Buffer[] = [];
  if (Number(req.headers["content-length"]) > max)
    throw new AppError("PAYLOAD_TOO_LARGE", 413);
  for await (const chunk of req) {
    const b = Buffer.from(chunk);
    size += b.length;
    if (size > max) throw new AppError("PAYLOAD_TOO_LARGE", 413);
    chunks.push(b);
  }
  if (!size) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new AppError("INVALID_JSON", 400);
  }
}
export async function startHttp(c: Config, store: PersonalStore, log: Logger) {
  const validator = new ValidationPool();
  if (!(await store.healthy()))
    throw Error("Credentials not ready; run webmcp-bridge init first");
  const gateway = new Gateway(c, store, validator, log);
  let stopping = false;
  const counters = { requests: 0, errors: 0 };
  const mcp = createMcpHandler(
    (ctx) =>
      createServer(
        ctx.authInfo!.extra!.principal as unknown as Principal,
        gateway,
      ),
    { onerror: () => log.error("MCP handler error") },
  );
  const nodeMcp = toNodeHandler(mcp, {
    onerror: () => log.error("MCP adapter error"),
  });
  const guard = (req: IncomingMessage) => {
    const host = req.headers.host;
    if (!host) throw new AppError("INVALID_HOST", 403);
    let hostname: string;
    try {
      const url = new URL("http://" + host);
      if (
        url.host !== host ||
        url.username ||
        url.password ||
        url.pathname !== "/"
      )
        throw Error();
      hostname = url.hostname;
    } catch {
      throw new AppError("INVALID_HOST", 403);
    }
    if (!c.hosts.includes(hostname)) throw new AppError("INVALID_HOST", 403);
  };
  const authenticate = async (req: IncomingMessage) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new AppError("UNAUTHORIZED", 401);
    const token = header.slice(7);
    if (!token || token.length > 16384) throw new AppError("UNAUTHORIZED", 401);
    const p = await store.authenticate(token);
    if (!p) throw new AppError("UNAUTHORIZED", 401);
    return { p, token };
  };
  const server = httpServer((req, res) => {
    void (async () => {
      const requestId = randomUUID(),
        started = Date.now();
      res.setHeader("x-request-id", requestId);
      counters.requests++;
      res.on("finish", () => {
        if (res.statusCode >= 400) counters.errors++;
        log.info(
          {
            requestId,
            status: res.statusCode,
            durationMs: Date.now() - started,
          },
          "http request",
        );
      });
      try {
        guard(req);
        if (req.headers.origin) {
          res.setHeader("access-control-allow-origin", req.headers.origin);
          res.setHeader("vary", "Origin");
          res.setHeader(
            "access-control-expose-headers",
            "WWW-Authenticate,MCP-Protocol-Version,Mcp-Session-Id",
          );
        }
        const path = new URL(req.url ?? "/", "http://localhost").pathname;
        if (req.method === "OPTIONS") {
          res.setHeader(
            "access-control-allow-methods",
            "GET,POST,DELETE,PUT,OPTIONS",
          );
          res.setHeader(
            "access-control-allow-headers",
            "Authorization,Content-Type,MCP-Protocol-Version,Mcp-Session-Id,Accept,Last-Event-ID",
          );
          res.writeHead(204);
          res.end();
          return;
        }
        if (path === "/health/live" && req.method === "GET") {
          json(res, 200, { status: "ok" });
          return;
        }
        if (path === "/health/ready" && req.method === "GET") {
          const ok = !stopping && (await store.healthy());
          json(res, ok ? 200 : 503, { status: ok ? "ready" : "unavailable" });
          return;
        }
        if (stopping) throw new AppError("SERVICE_STOPPING", 503);
        const { p, token } = await authenticate(req);
        if (path === "/mcp") {
          if (
            p.role === "device" ||
            !p.scopes.some((s) => s === "webmcp:read" || s === "webmcp:call")
          )
            throw new AppError("FORBIDDEN", 403);
          if (!(await store.healthy()))
            throw new AppError("STORAGE_UNAVAILABLE", 503);
          // Pre-read with a byte budget; the SDK still handles JSON-RPC and protocol validation.
          const parsed =
            req.method === "POST"
              ? await body(req, c.MAX_MESSAGE_BYTES)
              : undefined;
          (req as IncomingMessage & { auth: AuthInfo }).auth = {
            token,
            clientId: p.clientId,
            scopes: p.scopes,
            expiresAt: p.expiresAt ? Math.floor(p.expiresAt / 1000) : undefined,
            extra: { principal: p },
          };
          await nodeMcp(req, res, parsed);
          return;
        }
        if (path === "/bridge/ticket" && req.method === "POST" && gateway) {
          const data = z
            .object({
              deviceId: z.string().uuid(),
              deviceName: z
                .string()
                .trim()
                .min(1)
                .max(60)
                .default("my-browser"),
            })
            .strict()
            .parse(await body(req, 4096));
          await store.bindDevice(p, data.deviceId, data.deviceName);
          json(
            res,
            200,
            await gateway.ticket(
              { ...p, deviceId: data.deviceId },
              data.deviceId,
              token,
            ),
          );
          return;
        }
        throw new AppError("NOT_FOUND", 404);
      } catch (e) {
        const status =
          e instanceof AppError
            ? e.status
            : e instanceof z.ZodError
              ? 400
              : 500;
        if (status === 401) res.setHeader("www-authenticate", "Bearer");
        if (status >= 500) log.error({ requestId }, "request failed");
        if (!res.headersSent && !res.destroyed)
          json(res, status, {
            error:
              e instanceof AppError
                ? e.code
                : status === 400
                  ? "INVALID_REQUEST"
                  : "INTERNAL_ERROR",
          });
        else res.end();
      }
    })();
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.on("upgrade", (req, socket, head) => {
    try {
      guard(req);
      if (
        stopping ||
        !gateway ||
        req.url !== "/bridge/ws" ||
        gateway.wss.clients.size >= 1000
      )
        throw Error();
      gateway.wss.handleUpgrade(req, socket, head, (ws) =>
        gateway.wss.emit("connection", ws, req),
      );
    } catch {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(c.PORT, c.HOST, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (e) {
    await gateway.close();
    await mcp.close();
    await validator.close();
    throw e;
  }
  const metrics = setInterval(
    () => log.info({ ...counters, ...gateway?.metrics }, "metrics"),
    60000,
  );
  metrics.unref();
  let closed: Promise<void> | undefined;
  return {
    server,
    gateway,
    close() {
      return (closed ??= (async () => {
        stopping = true;
        if (gateway) gateway.stopping = true;
        clearInterval(metrics);
        const end = Date.now() + c.SHUTDOWN_GRACE_MS;
        while (gateway?.pending && Date.now() < end)
          await new Promise((r) => setTimeout(r, 25));
        await gateway?.close();
        await mcp.close();
        await validator.close();
        await new Promise<void>((r) => {
          server.close(() => r());
          server.closeAllConnections();
        });
        await store.close();
      })());
    },
  };
}

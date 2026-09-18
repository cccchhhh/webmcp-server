import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { get } from "node:http";
import { WebSocket } from "ws";
import { pino } from "pino";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { ClientEnvelope, ServerEnvelope } from "../src/browser/protocol.js";
// Exercise the distributable, including its separately built validation worker.
const { startHttp, PersonalStore, config } = await import(
  process.env.WEBMCP_BRIDGE_MODULE ??
    new URL("../dist/index.js", import.meta.url).href
);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});
async function setup(remote = false) {
  const dir = await mkdtemp(join(tmpdir(), "webmcp-bridge-test-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const store = new PersonalStore(join(dir, "credentials.json"));
  const credentials = await store.init();
  const c = config({
    BRIDGE_CONFIG_FILE: store.file,
    TOOL_TIMEOUT_MS: "3000",
    SHUTDOWN_GRACE_MS: "1",
    ...(remote
      ? { DEPLOYMENT_MODE: "remote", PUBLIC_BASE_URL: "https://bridge.example" }
      : {}),
  });
  c.PORT = 0;
  const app = await startHttp(c, store, pino({ level: "silent" }));
  cleanups.push(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  if (!remote) c.PUBLIC_BASE_URL = base;
  async function request(
    path: string,
    token: string,
    body?: unknown,
    headers = {},
  ) {
    return fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function client(token = credentials.agent.token) {
    const client = new Client({ name: "bridge-tests", version: "1" });
    cleanups.push(() => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  }
  return { dir, store, credentials, c, app, base, request, client };
}
async function device(
  s: Awaited<ReturnType<typeof setup>>,
  token = s.credentials.plugin.token,
  id = randomUUID(),
) {
  const response = await s.request("/bridge/ticket", token, {
    deviceId: id,
    deviceName: "browser",
  });
  expect(response.status).toBe(200);
  const ticket = (await response.json()) as { ticket: string; wsUrl: string };
  const ws = new WebSocket(s.base.replace("http:", "ws:") + "/bridge/ws", {
    origin: `chrome-extension://${id}`,
  });
  cleanups.push(async () => {
    ws.terminate();
  });
  const queue: any[] = [];
  ws.on("message", (raw) =>
    queue.push(ServerEnvelope.parse(JSON.parse(raw.toString()))),
  );
  await once(ws, "open");
  let epoch: string | undefined;
  const send = (payload: any) => {
    const messageId = randomUUID();
    ws.send(
      JSON.stringify(
        ClientEnvelope.parse({
          protocolVersion: 1,
          messageId,
          connectionEpoch: epoch,
          payload,
        }),
      ),
    );
    return messageId;
  };
  const next = async (type: string) => {
    let result: any;
    await expect
      .poll(
        () => {
          const i = queue.findIndex((m) => m.payload.type === type);
          if (i < 0) return false;
          result = queue.splice(i, 1)[0];
          return true;
        },
        { timeout: 5000 },
      )
      .toBe(true);
    return result.payload;
  };
  send({ type: "AUTH", ticket: ticket.ticket });
  epoch = (await next("AUTH_OK")).connectionEpoch;
  const register = async (localPageId = randomUUID()) => {
    send({
      type: "REGISTER_PAGE",
      page: {
        localPageId,
        documentId: localPageId,
        title: "fixture",
        url: "https://site.test/path?private=1#secret",
        catalogVersion: randomUUID(),
        tools: [
          {
            name: "echo",
            description: "",
            inputSchema: { type: "object" },
            executable: true,
          },
        ],
        authorizedToolNames: ["echo"],
        executionBlocked: false,
      },
    });
    return (await next("PAGE_REGISTERED")).target;
  };
  return { id, ws, send, next, register, ticket };
}
async function call(client: Client, name: string, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  return r.structuredContent as any;
}
describe("standalone bridge", () => {
  it("private reusable credentials, rotation, revocation and explicit configuration", async () => {
    const s = await setup();
    const raw = await readFile(s.store.file, "utf8");
    expect(raw).toContain(s.credentials.agent.token);
    expect(raw).toContain(s.credentials.plugin.token);
    expect(await s.store.startupCredentials()).toEqual(s.credentials);
    expect((await stat(s.store.file)).mode & 0o777).toBe(0o600);
    expect((await stat(s.dir)).mode & 0o777).toBe(0o700);
    await expect(s.store.init()).rejects.toThrow("Already initialized");
    const rotated = await s.store.rotate(s.credentials.agent.id);
    expect(
      await s.store.authenticate(s.credentials.agent.token),
    ).toBeUndefined();
    expect((await s.store.authenticate(rotated.token))?.role).toBe("agent");
    expect((await s.store.startupCredentials()).agent).toEqual(rotated);
    await s.store.revoke(rotated.id);
    expect(await s.store.authenticate(rotated.token)).toBeUndefined();
    await expect(s.store.startupCredentials()).rejects.toThrow(
      "issue --role agent",
    );
    await chmod(s.store.file, 0o644);
    await expect(
      s.store.authenticate(s.credentials.plugin.token),
    ).rejects.toThrow("private");
    expect(() => config({ HOST: "0.0.0.0" })).toThrow();
    expect(() => config({ DEPLOYMENT_MODE: "remote" })).toThrow();
    expect(
      config({
        DEPLOYMENT_MODE: "remote",
        PUBLIC_BASE_URL: "https://mcp.example",
        HOST: "0.0.0.0",
      }).PUBLIC_BASE_URL,
    ).toBe("https://mcp.example");
  });
  it("rejects invalid credentials, swapped roles, hostile hosts and unsupported management routes", async () => {
    const s = await setup();
    expect((await s.request("/mcp", "invalid")).status).toBe(401);
    expect((await s.request("/mcp", s.credentials.plugin.token)).status).toBe(
      403,
    );
    expect(
      (
        await s.request("/bridge/ticket", s.credentials.agent.token, {
          deviceId: randomUUID(),
        })
      ).status,
    ).toBe(403);
    for (const origin of [
      "chrome-extension://different-browser",
      "https://client.example",
      "null",
    ]) {
      const response = await s.request(
        "/bridge/ticket",
        s.credentials.plugin.token,
        { deviceId: randomUUID() },
        { Origin: origin },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
      expect(
        (
          await s.request(
            "/bridge/ticket",
            "invalid",
            { deviceId: randomUUID() },
            { Origin: origin },
          )
        ).status,
      ).toBe(401);
      const preflight = await fetch(s.base + "/bridge/ticket", {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
    }
    expect(
      (await s.request("/devices", s.credentials.plugin.token, {})).status,
    ).toBe(404);
    expect(
      (
        await s.request(
          "/grants/agents/example/devices/example",
          s.credentials.agent.token,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await s.request(
          "/.well-known/oauth-authorization-server",
          s.credentials.agent.token,
        )
      ).status,
    ).toBe(404);
    const hostileHostStatus = await new Promise<number | undefined>(
      (resolve, reject) => {
        get(
          s.base + "/health/ready",
          { headers: { Host: "evil.test" } },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        ).on("error", reject);
      },
    );
    expect(hostileHostStatus).toBe(403);
    await expect(s.client(s.credentials.plugin.token)).rejects.toThrow();
  });
  it("standard MCP discovery, browser isolation, actual calls, stale versions and disconnects", async () => {
    const s = await setup(),
      client = await s.client();
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "call_webmcp_tool",
      "list_webmcp_pages",
      "list_webmcp_tools",
    ]);
    expect((await call(client, "list_webmcp_pages")).pages).toEqual([]);
    const a = await device(s),
      b = await device(s),
      localPageId = randomUUID();
    const ta = await a.register(localPageId),
      tb = await b.register(localPageId);
    expect(ta.pageId).not.toBe(tb.pageId);
    const pages = (await call(client, "list_webmcp_pages")).pages;
    expect(pages).toHaveLength(2);
    expect(pages.map((p: any) => p.deviceId).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    expect(pages[0].url).toBe("https://site.test/path");
    expect(
      (await call(client, "list_webmcp_tools", { pageId: ta.pageId })).tools[0]
        .name,
    ).toBe("echo");
    const args = {
      pageId: ta.pageId,
      catalogVersion: ta.catalogVersion,
      toolName: "echo",
      arguments: { test: true },
    };
    expect(
      (
        await call(client, "call_webmcp_tool", {
          ...args,
          catalogVersion: randomUUID(),
        })
      ).errorCode,
    ).toBe("CATALOG_STALE");
    const running = call(client, "call_webmcp_tool", args),
      incoming = await a.next("CALL");
    expect(incoming.arguments).toEqual({ test: true });
    a.send({
      type: "CALL_ACK",
      target: ta,
      callId: incoming.callId,
      accepted: true,
    });
    a.send({
      type: "CALL_RESULT",
      target: ta,
      callId: incoming.callId,
      business: "unclassified",
      rawResult: { ok: true },
      executionSettled: true,
    });
    expect(await running).toMatchObject({
      execution: "returned",
      rawResult: { ok: true },
    });
    const pending = call(client, "call_webmcp_tool", args);
    await a.next("CALL");
    a.ws.terminate();
    expect(await pending).toMatchObject({ execution: "unknown" });
    expect((await call(client, "list_webmcp_pages")).pages).toHaveLength(1);
  });
  it("revoking Agent while a call is running withholds its result; plugin rotation disconnects live sockets", async () => {
    const s = await setup(),
      client = await s.client(),
      a = await device(s),
      target = await a.register();
    const pending = call(client, "call_webmcp_tool", {
      pageId: target.pageId,
      catalogVersion: target.catalogVersion,
      toolName: "echo",
      arguments: {},
    });
    const incoming = await a.next("CALL");
    await s.store.revoke(s.credentials.agent.id);
    a.send({
      type: "CALL_RESULT",
      target,
      callId: incoming.callId,
      business: "unclassified",
      rawResult: "secret-result",
      executionSettled: true,
    });
    const result = await pending;
    expect(result.execution).toBe("unknown");
    expect(result.rawResult).toBeUndefined();
    const closed = once(a.ws, "close");
    const rotated = await s.store.rotate(s.credentials.plugin.id);
    await closed;
    const restored = await device(s, rotated.token, a.id);
    expect(restored.id).toBe(a.id);
  });
  it("remote deployment uses TLS public URLs and enforces token revocation too", async () => {
    const s = await setup(true),
      client = await s.client(),
      a = await device(s);
    expect(a.ticket.wsUrl).toBe("wss://bridge.example/bridge/ws");
    await a.register();
    expect((await call(client, "list_webmcp_pages")).pages).toHaveLength(1);
    const closed = once(a.ws, "close");
    await s.store.revoke(s.credentials.plugin.id);
    await closed;
    expect((await call(client, "list_webmcp_pages")).pages).toEqual([]);
  });
});

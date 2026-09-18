import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer as createTlsServer } from "node:https";
import { request as httpRequest } from "node:http";
import { connect as tcpConnect } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { pino } from "pino";
import {
  config,
  PersonalStore,
  startHttp,
  ClientEnvelope,
  ServerEnvelope,
} from "../dist/index.js";
// Test-scoped certificate trust; never disables TLS verification globally.
if (!process.env.BRIDGE_TLS_TEST_DIR) {
  const dir = await mkdtemp(join(tmpdir(), "bridge-tls-"));
  try {
    const generated = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { encoding: "utf8" },
    );
    assert.equal(generated.status, 0, generated.stderr);
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url)],
      {
        env: {
          ...process.env,
          BRIDGE_TLS_TEST_DIR: dir,
          NODE_EXTRA_CA_CERTS: join(dir, "cert.pem"),
        },
        stdio: "inherit",
        timeout: 30000,
      },
    );
    assert.equal(child.status, 0, "HTTPS test subprocess failed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
} else {
  const dir = process.env.BRIDGE_TLS_TEST_DIR;
  let app, client, ws;
  const sockets = new Set();
  const proxy = createTlsServer(
    {
      key: await readFile(join(dir, "key.pem")),
      cert: await readFile(join(dir, "cert.pem")),
    },
    (req, res) => {
      const upstream = httpRequest(
        {
          hostname: "127.0.0.1",
          port: app.server.address().port,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (incoming) => {
          res.writeHead(incoming.statusCode, incoming.headers);
          incoming.pipe(res);
        },
      );
      upstream.on("error", () => {
        res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    },
  );
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  proxy.on("upgrade", (req, socket, head) => {
    const upstream = tcpConnect(app.server.address().port, "127.0.0.1", () => {
      upstream.write(
        `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` +
          Object.entries(req.headers)
            .map(([k, v]) => `${k}: ${v}\r\n`)
            .join("") +
          "\r\n",
      );
      upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  });
  try {
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const base = `https://127.0.0.1:${proxy.address().port}`;
    const store = new PersonalStore(join(dir, "credentials.json")),
      credentials = await store.init();
    const c = config({
      DEPLOYMENT_MODE: "remote",
      PUBLIC_BASE_URL: base,
      BRIDGE_CONFIG_FILE: store.file,
      SHUTDOWN_GRACE_MS: "1",
      LOG_LEVEL: "silent",
    });
    c.PORT = 0;
    app = await startHttp(c, store, pino({ level: "silent" }));
    client = new Client({ name: "tls-test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
        requestInit: {
          headers: { Authorization: `Bearer ${credentials.agent.token}` },
        },
      }),
    );
    assert.equal((await client.listTools()).tools.length, 3);
    const ticketRes = await fetch(base + "/bridge/ticket", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.plugin.token}`,
        "Content-Type": "application/json",
        Origin: "chrome-extension://tls-test",
      },
      body: JSON.stringify({
        deviceId: randomUUID(),
        deviceName: "tls-browser",
      }),
    });
    assert.equal(ticketRes.status, 200);
    const ticket = await ticketRes.json();
    assert(ticket.wsUrl.startsWith("wss://"));
    ws = new WebSocket(ticket.wsUrl, { origin: "chrome-extension://tls-test" });
    await once(ws, "open");
    let epoch;
    const send = (payload) =>
      ws.send(
        JSON.stringify(
          ClientEnvelope.parse({
            protocolVersion: 1,
            messageId: randomUUID(),
            connectionEpoch: epoch,
            payload,
          }),
        ),
      );
    const auth = once(ws, "message");
    send({ type: "AUTH", ticket: ticket.ticket });
    epoch = ServerEnvelope.parse(
      JSON.parse((await auth)[0].toString()),
    ).connectionEpoch;
    const registered = once(ws, "message");
    send({
      type: "REGISTER_PAGE",
      page: {
        localPageId: randomUUID(),
        documentId: randomUUID(),
        title: "TLS fixture",
        url: "https://page.test/",
        catalogVersion: randomUUID(),
        tools: [
          {
            name: "echo",
            description: "echo",
            inputSchema: { type: "object" },
            executable: true,
          },
        ],
        authorizedToolNames: ["echo"],
        executionBlocked: false,
      },
    });
    const target = ServerEnvelope.parse(
      JSON.parse((await registered)[0].toString()),
    ).payload.target;
    const pending = client.callTool({
      name: "call_webmcp_tool",
      arguments: {
        pageId: target.pageId,
        catalogVersion: target.catalogVersion,
        toolName: "echo",
        arguments: { hello: "tls" },
      },
    });
    const call = ServerEnvelope.parse(
      JSON.parse((await once(ws, "message"))[0].toString()),
    ).payload;
    assert.equal(call.type, "CALL");
    send({
      type: "CALL_RESULT",
      target,
      callId: call.callId,
      business: "unclassified",
      rawResult: { hello: "tls" },
      executionSettled: true,
    });
    assert.deepEqual((await pending).structuredContent.rawResult, {
      hello: "tls",
    });
    await writeFile(
      "test-results/https.json",
      JSON.stringify(
        {
          date: new Date().toISOString(),
          checks: [
            "MCP over HTTPS with certificate validation",
            "WSS ticket and browser bridge",
            "page tool call and result through TLS reverse proxy",
          ],
          limitation:
            "Local TLS proxy and protocol fixture; public production HTTPS deployment not tested",
        },
        null,
        2,
      ) + "\n",
    );
    console.log(
      "PASS: HTTPS MCP + WSS browser bridge + tool execution through a TLS reverse proxy",
    );
  } finally {
    ws?.terminate();
    await client?.close();
    await app?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => proxy.close(resolve));
  }
}

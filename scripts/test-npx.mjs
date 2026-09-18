import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  rm,
  readFile,
  writeFile,
  lstat,
  symlink,
} from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export async function testNpx({ tarball, cli, pkg }) {
  // Outside the install prefix: npx cannot resolve its parent node_modules.
  const cwd = await mkdtemp(path.join(tmpdir(), "bridge-npx-"));
  const config = path.join(cwd, "private", "credentials.json");
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  // Remove ambient bridge configuration so the smoke test cannot use real credentials.
  const env = { ...process.env };
  for (const key of [
    "DEPLOYMENT_MODE",
    "PUBLIC_BASE_URL",
    "ALLOWED_HOSTS",
    "HOST",
    "PORT",
    "BRIDGE_CONFIG_FILE",
    "NODE_OPTIONS",
  ])
    delete env[key];
  const children = [];
  const start = (local = false) => {
    const child = spawn(
      local ? process.execPath : "npx",
      [
        ...(local
          ? [cli, "serve"]
          : ["--yes", `--package=${tarball}`, "webmcp-bridge"]),
        "--config",
        config,
        "--port",
        String(port),
      ],
      {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const state = { child, stdout: "", stderr: "", exited: false };
    state.done = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        state.exited = true;
        resolve({ code, signal });
      });
    });
    child.stdout.on("data", (data) => {
      state.stdout += data;
    });
    child.stderr.on("data", (data) => {
      state.stderr += data;
    });
    children.push(state);
    return state;
  };
  const stop = async (state) => {
    if (state.exited) return;
    process.kill(-state.child.pid, "SIGINT");
    for (let i = 0; i < 100 && !state.exited; i++) await delay(50);
    assert(state.exited, "npx process must stop on Ctrl+C");
    const result = await state.done;
    assert(
      result.code === 0 || result.signal === "SIGINT" || result.code === 130,
      "Unexpected shutdown status",
    );
  };
  const ready = async (state) => {
    for (let i = 0; i < 1200; i++) {
      assert(!state.exited, `npx exited before readiness: ${state.stderr}`);
      if (
        state.stderr.includes("WebMCP bridge ready") &&
        state.stdout.includes('"next"')
      ) {
        const response = await fetch(base + "/health/ready");
        assert.equal(response.status, 200);
        return;
      }
      await delay(100);
    }
    throw Error(`npx readiness timeout: ${state.stderr}`);
  };
  const rejectCli = (args, expected, extraEnv = {}) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd,
      env: { ...env, ...extraEnv },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
    assert.equal(result.stdout, "");
  };
  try {
    const first = start();
    await ready(first);
    const setup = JSON.parse(first.stdout);
    assert.equal(setup.pluginSetup.baseUrl, base);
    assert.equal(setup.mcpSetup.url, base + "/mcp");
    assert.notEqual(setup.plugin.token, setup.agent.token);
    const persisted = await readFile(config, "utf8");
    assert(persisted.includes(setup.plugin.token));
    assert(persisted.includes(setup.agent.token));
    assert.equal((await lstat(config)).mode & 0o777, 0o600);
    const { PersonalStore } = await import(
      pathToFileURL(path.join(pkg, "dist/index.js")).href
    );
    assert.equal(
      (await new PersonalStore(config).authenticate(setup.agent.token)).role,
      "agent",
    );
    assert.equal(
      (await new PersonalStore(config).authenticate(setup.plugin.token)).role,
      "device",
    );
    rejectCli(
      ["--config", config, "--port", String(port)],
      /EADDRINUSE|address already in use/,
    );
    rejectCli(
      [
        "--config",
        path.join(cwd, "conflict", "credentials.json"),
        "--port",
        String(port),
      ],
      /EADDRINUSE|address already in use/,
    );
    assert.equal(await readFile(config, "utf8"), persisted);
    await stop(first);
    const second = start();
    await ready(second);
    assert.deepEqual(JSON.parse(second.stdout), setup);
    assert.equal(await readFile(config, "utf8"), persisted);
    const ticket = await fetch(base + "/bridge/ticket", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${setup.plugin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ deviceId: randomUUID(), deviceName: "npx-test" }),
    });
    assert.equal(ticket.status, 200);
    const mcp = await fetch(base + "/mcp", {
      method: "POST",
      headers: {
        Authorization: setup.mcpSetup.headers.Authorization,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "npx-test", version: "1" },
        },
      }),
    });
    assert.equal(mcp.status, 200);
    await mcp.body.cancel();
    await stop(second);
    const beforeLocal = await readFile(config, "utf8");
    const local = start(true);
    await ready(local);
    assert.deepEqual(JSON.parse(local.stdout), setup);
    assert.equal(await readFile(config, "utf8"), beforeLocal);
    await stop(local);
    for (const [name, contents, mode, expected] of [
      ["broken", "{", 0o600, /JSON|position|property/i],
      [
        "empty",
        JSON.stringify({ version: 1, tokens: [], devices: [] }),
        0o600,
        /no valid credentials/,
      ],
      ["unsafe", persisted, 0o644, /private/],
    ]) {
      const file = path.join(cwd, "private", name + ".json");
      await writeFile(file, contents, { mode });
      rejectCli(["--config", file], expected);
      assert.equal(await readFile(file, "utf8"), contents);
    }
    const link = path.join(cwd, "private", "link.json");
    await symlink(config, link);
    rejectCli(["--config", link], /symlink|private/);
    await chmod(path.dirname(config), 0o755);
    rejectCli(["--config", config], /private/);
    await chmod(path.dirname(config), 0o700);
    const missing = path.join(cwd, "explicit", "credentials.json");
    rejectCli(["serve", "--config", missing], /init first/);
    rejectCli(["--config", missing], /init first/, {
      DEPLOYMENT_MODE: "remote",
      PUBLIC_BASE_URL: "https://bridge.example.com",
    });
    await assert.rejects(lstat(missing), { code: "ENOENT" });
    const concurrentFile = path.join(cwd, "concurrent", "credentials.json");
    const concurrent = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        new PersonalStore(concurrentFile).initIfMissing(),
      ),
    );
    const issued = concurrent.filter(
      (result) => result.status === "fulfilled" && result.value,
    );
    assert.equal(issued.length, 1);
    assert.equal(
      (await new PersonalStore(concurrentFile).listCredentials()).length,
      2,
    );
    assert(
      await new PersonalStore(concurrentFile).authenticate(
        issued[0].value.agent.token,
      ),
    );
    console.log(
      "PASS: npx and local startup output, reusable tokens, restart authentication, SIGINT, port conflict, invalid credentials, explicit initialization and concurrent initialization",
    );
  } finally {
    for (const state of children) {
      if (!state.exited) {
        process.kill(-state.child.pid, "SIGKILL");
        await state.done;
      }
    }
    await rm(cwd, { recursive: true, force: true });
  }
}

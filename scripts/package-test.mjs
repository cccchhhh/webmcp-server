import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const root = process.cwd();
const metadata = JSON.parse(await readFile("package.json", "utf8"));
const tarball = path.join(
  root,
  "artifacts",
  `${metadata.name.replace(/^@/, "").replaceAll("/", "-")}-${metadata.version}.tgz`,
);
const listing = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8" });
assert.equal(listing.status, 0, listing.stderr);
for (const file of listing.stdout.trim().split("\n")) {
  assert(
    !/(^|\/)(\.env[^/]*|\.local|credentials\.json|certs)(\/|$)|\.(log|pem|key)$/.test(
      file,
    ),
    `Unexpected private file: ${file}`,
  );
}

const isolated = await mkdtemp(path.join(tmpdir(), "bridge-installed-"));
try {
  const installed = spawnSync(
    "npm",
    [
      "install",
      "--prefix",
      isolated,
      "--ignore-scripts",
      "--omit=dev",
      "--prefer-offline",
      "--no-audit",
      "--no-fund",
      tarball,
    ],
    { encoding: "utf8", timeout: 120000 },
  );
  assert.equal(installed.status, 0, installed.stderr);
  const pkg = path.join(isolated, "node_modules", metadata.name),
    cli = path.join(pkg, "dist/cli.js");
  const credentialsFile = path.join(isolated, "private/credentials.json");
  const command = (args) => {
    const result = spawnSync(
      process.execPath,
      [cli, ...args, "--config", credentialsFile],
      { cwd: isolated, encoding: "utf8", timeout: 10000 },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const initial = command(["init"]);
  assert.equal(initial.pluginSetup.connectionType, "bridge");
  assert.equal(initial.mcpSetup.url, "http://127.0.0.1:38472/mcp");
  assert.notEqual(initial.agent.token, initial.plugin.token);
  const persisted = await readFile(credentialsFile, "utf8");
  assert(!persisted.includes(initial.agent.token));
  assert(!persisted.includes(initial.plugin.token));
  const issued = command(["issue", "--role", "agent"]);
  const rotated = command(["rotate", "--id", issued.id]);
  assert.equal(rotated.id, issued.id);
  assert.notEqual(rotated.token, issued.token);
  command(["revoke", "--id", issued.id]);
  assert.equal(command(["list"]).length, 2);
  for (const args of [
    ["--transport", "stdio"],
    ["pair", "--role", "agent"],
    ["grant", "--client-id", "x", "--device-id", "y"],
  ]) {
    const rejected = spawnSync(
      process.execPath,
      [cli, ...args, "--config", credentialsFile],
      { cwd: isolated, encoding: "utf8" },
    );
    assert.notEqual(rejected.status, 0, "Removed command must be rejected");
  }
  assert.equal(
    await readFile(path.join(pkg, "dist/bridge-v1.ts"), "utf8"),
    await readFile("src/browser/protocol.ts", "utf8"),
  );
  console.log(
    "PASS: isolated installation, credential CLI lifecycle, removed commands rejected, packaged protocol matches",
  );
  const { testNpx } = await import("./test-npx.mjs");
  await testNpx({ isolated, tarball, cli, pkg });
  const result = spawnSync(
    process.execPath,
    [path.join(root, "node_modules/vitest/vitest.mjs"), "run"],
    {
      cwd: root,
      env: {
        ...process.env,
        WEBMCP_BRIDGE_MODULE: pathToFileURL(path.join(pkg, "dist/index.js"))
          .href,
      },
      stdio: "inherit",
      timeout: 60000,
    },
  );
  assert.equal(result.status, 0, "Installed bridge integration failed");
} finally {
  await rm(isolated, { recursive: true, force: true });
}

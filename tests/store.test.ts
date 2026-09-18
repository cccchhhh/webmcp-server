import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { PersonalStore } = await import(
  process.env.WEBMCP_BRIDGE_MODULE ??
    new URL("../dist/index.js", import.meta.url).href
);
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "bridge-store-"));
  directories.push(directory);
  const store = new PersonalStore(join(directory, "credentials.json"));
  const initial = await store.init();
  return { store, initial };
}
test("legacy credentials are retained and displayable tokens are issued only once", async () => {
  const { store, initial } = await setup();
  const data = JSON.parse(await readFile(store.file, "utf8"));
  for (const item of data.tokens) delete item.token;
  await writeFile(store.file, JSON.stringify(data));
  const credentials = await store.startupCredentials();
  expect(credentials.agent.token).not.toBe(initial.agent.token);
  expect(credentials.plugin.token).not.toBe(initial.plugin.token);
  for (const pair of [initial, credentials]) {
    expect((await store.authenticate(pair.agent.token))?.role).toBe("agent");
    expect((await store.authenticate(pair.plugin.token))?.role).toBe("device");
  }
  expect(await store.listCredentials()).toHaveLength(4);
  const saved = await readFile(store.file, "utf8");
  expect(await new PersonalStore(store.file).startupCredentials()).toEqual(
    credentials,
  );
  expect(await readFile(store.file, "utf8")).toBe(saved);
  expect(await store.listCredentials()).toEqual(
    expect.arrayContaining([
      { id: credentials.agent.id, role: "agent" },
      { id: credentials.plugin.id, role: "device" },
    ]),
  );
});
test("startup reuses rotated plugin tokens and never recreates a revoked role", async () => {
  const { store, initial } = await setup();
  const plugin = await store.rotate(initial.plugin.id);
  expect((await store.startupCredentials()).plugin).toEqual(plugin);
  expect(await readFile(store.file, "utf8")).not.toContain(
    initial.plugin.token,
  );
  await store.revoke(plugin.id);
  const saved = await readFile(store.file, "utf8");
  await expect(store.startupCredentials()).rejects.toThrow(
    "issue --role device",
  );
  expect(await readFile(store.file, "utf8")).toBe(saved);
});
test("mismatched stored token is rejected without rewriting credentials", async () => {
  const { store, initial } = await setup();
  const data = JSON.parse(await readFile(store.file, "utf8"));
  data.tokens[0].token = initial.plugin.token;
  const saved = JSON.stringify(data);
  await writeFile(store.file, saved);
  await expect(store.startupCredentials()).rejects.toThrow("does not match");
  expect(await readFile(store.file, "utf8")).toBe(saved);
});

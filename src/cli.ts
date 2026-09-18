#!/usr/bin/env node
import { parseArgs } from "node:util";
import { pino, destination } from "pino";
import { config } from "./config.js";
import { PersonalStore } from "./store.js";
import { startHttp } from "./http.js";
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
      role: { type: "string" },
      id: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    process.stdout.write(
      "webmcp-bridge [command]\nNo command: initialize missing local credentials and serve in foreground.\nRequires Node.js 24+. Keep this terminal open; Ctrl+C stops the bridge.\nCommands: init|serve|list|issue --role agent|device|rotate --id ID|revoke --id ID\nOptions: --config FILE --host HOST --port PORT\nRemote: DEPLOYMENT_MODE=remote PUBLIC_BASE_URL=https://host\n",
    );
  } else {
    const c = config({
      ...process.env,
      ...(values.config ? { BRIDGE_CONFIG_FILE: values.config } : {}),
      ...(values.host ? { HOST: values.host } : {}),
      ...(values.port ? { PORT: values.port } : {}),
    });
    const store = new PersonalStore(c.BRIDGE_CONFIG_FILE);
    const command = positionals[0] ?? "serve";
    const print = (v: unknown) =>
      process.stdout.write(JSON.stringify(v, null, 2) + "\n");
    const printSetup = (
      credentials: Awaited<ReturnType<PersonalStore["init"]>>,
      serving = false,
    ) =>
      print({
        ...credentials,
        pluginSetup: {
          connectionType: "bridge",
          baseUrl: c.PUBLIC_BASE_URL,
          token: credentials.plugin.token,
        },
        mcpSetup: {
          url: c.PUBLIC_BASE_URL + "/mcp",
          headers: { Authorization: `Bearer ${credentials.agent.token}` },
        },
        next: serving
          ? "Keep these tokens private. Starting HTTP MCP bridge; keep this terminal open. Ctrl+C stops the bridge. Storage contains hashes only."
          : "Keep these tokens private. Run webmcp-bridge serve. Tokens are only shown on issue; storage contains hashes.",
      });
    if (command === "init") {
      printSetup(await store.init());
    } else if (command === "issue") {
      if (values.role !== "agent" && values.role !== "device")
        throw Error("--role agent|device is required");
      print(await store.issueToken(values.role));
    } else if (command === "rotate" || command === "revoke") {
      if (!values.id) throw Error("--id credential-ID is required");
      if (command === "rotate") print(await store.rotate(values.id));
      else {
        await store.revoke(values.id);
        print({ revoked: values.id });
      }
    } else if (command === "list") print(await store.listCredentials());
    else if (command === "serve") {
      if (!positionals.length && c.DEPLOYMENT_MODE === "local") {
        const credentials = await store.initIfMissing();
        if (credentials) printSetup(credentials, true);
      }
      const log = pino({ level: c.LOG_LEVEL }, destination(2));
      const app = await startHttp(c, store, log);
      log.info({ host: c.HOST, port: c.PORT }, "WebMCP bridge ready");
      const shutdown = () => {
        void app.close().catch(() => {
          process.exitCode = 1;
        });
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    } else throw Error("Unknown command; use --help");
  }
} catch (e) {
  process.stderr.write(
    (e instanceof Error ? e.message : "Bridge failed") + "\n",
  );
  process.exitCode = 1;
}

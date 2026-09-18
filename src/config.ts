import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
const positive = z.coerce.number().int().positive();
const schema = z.object({
  DEPLOYMENT_MODE: z.enum(["local", "remote"]).default("local"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(38472),
  BRIDGE_CONFIG_FILE: z
    .string()
    .default(join(homedir(), ".config/webmcp-bridge/credentials.json")),
  PUBLIC_BASE_URL: z.string().url().optional(),
  ALLOWED_HOSTS: z.string().optional(),
  TOOL_TIMEOUT_MS: positive.default(60000),
  MAX_ARGUMENT_BYTES: positive.max(262144).default(262144),
  MAX_RESULT_BYTES: positive.max(1048576).default(1048576),
  MAX_MESSAGE_BYTES: positive.max(2097152).default(2097152),
  SHUTDOWN_GRACE_MS: positive.default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});
export function config(env: NodeJS.ProcessEnv = process.env) {
  const c = schema.parse(env);
  if (
    c.DEPLOYMENT_MODE === "local" &&
    !["127.0.0.1", "localhost"].includes(c.HOST)
  )
    throw Error("Local mode requires a loopback HOST");
  const base = new URL(c.PUBLIC_BASE_URL ?? `http://127.0.0.1:${c.PORT}`);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/"
  )
    throw Error(
      "PUBLIC_BASE_URL must be an origin without path or credentials",
    );
  if (c.DEPLOYMENT_MODE === "remote") {
    if (!c.PUBLIC_BASE_URL || base.protocol !== "https:")
      throw Error(
        "Remote mode requires an HTTPS PUBLIC_BASE_URL and a TLS reverse proxy",
      );
  } else if (
    !["127.0.0.1", "localhost"].includes(base.hostname) ||
    !["http:", "https:"].includes(base.protocol)
  )
    throw Error("Local PUBLIC_BASE_URL must be loopback HTTP(S)");
  const hosts = (c.ALLOWED_HOSTS ?? `${base.hostname},127.0.0.1,localhost`)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (!hosts.length || hosts.some((x) => x.includes("*") || x === "null"))
    throw Error("Explicit allowed hosts are required; wildcards are forbidden");
  return { ...c, PUBLIC_BASE_URL: base.origin, hosts };
}
export type Config = ReturnType<typeof config>;

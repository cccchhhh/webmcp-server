import {
  mkdir,
  readFile,
  writeFile,
  rename,
  lstat,
  open,
  unlink,
} from "node:fs/promises";
import { dirname } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError, type Principal, type Store } from "./types.js";
const roleSchema = z.enum(["agent", "device"]);
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const credential = z
  .object({
    id: z.string().uuid(),
    role: roleSchema,
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    token: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .optional(),
  })
  .strict()
  .refine((value) => !value.token || hash(value.token) === value.hash, {
    message: "Stored token does not match credential hash",
  });
const dataSchema = z
  .object({
    version: z.literal(1),
    tokens: z.array(credential).max(100),
    devices: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            // Accept the old on-disk marker without using it as an account model.
            userId: z.literal("personal").optional(),
            name: z.string().max(60),
            credentialId: z.string().uuid(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
type Data = z.infer<typeof dataSchema>;
const empty = (): Data => ({ version: 1, tokens: [], devices: [] });
export class PersonalStore implements Store {
  constructor(public readonly file: string) {}
  private async read(): Promise<Data> {
    try {
      const stat = await lstat(this.file),
        dir = await lstat(dirname(this.file));
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        dir.isSymbolicLink() ||
        stat.mode & 0o077 ||
        dir.mode & 0o077
      )
        throw Error(
          "Credential directory/file must be private (0700/0600) and not symlinks",
        );
      return dataSchema.parse(JSON.parse(await readFile(this.file, "utf8")));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return empty();
      throw e;
    }
  }
  private async edit<T>(fn: (data: Data) => T | Promise<T>): Promise<T> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const dir = await lstat(dirname(this.file));
    if (dir.isSymbolicLink() || dir.mode & 0o077)
      throw Error("Credential directory must be private (0700)");
    const lock = await open(this.file + ".lock", "wx", 0o600);
    const tmp = this.file + "." + randomUUID() + ".tmp";
    try {
      const data = await this.read(),
        value = await fn(data);
      dataSchema.parse(data);
      await writeFile(tmp, JSON.stringify(data, null, 2), {
        mode: 0o600,
        flag: "wx",
      });
      await rename(tmp, this.file);
      return value;
    } finally {
      await lock.close();
      await unlink(this.file + ".lock");
      await unlink(tmp).catch(() => {});
    }
  }
  private issue(
    data: Data,
    role: "agent" | "device",
    id: string = randomUUID(),
  ) {
    const token = randomBytes(32).toString("base64url");
    data.tokens.push({ id, role, hash: hash(token), token });
    return { id, role, token };
  }
  // Never recreate an existing file, even when all credentials were revoked.
  async initIfMissing() {
    const exists = async () => {
      try {
        await lstat(this.file);
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw e;
      }
    };
    if (await exists()) {
      if (!(await this.read()).tokens.length)
        throw Error(
          "Existing credential file has no valid credentials; use issue --role agent and issue --role device",
        );
      return undefined;
    }
    return this.edit(async (data) => {
      if (await exists())
        throw Error(
          "Credential file appeared during initialization; retry startup",
        );
      return {
        agent: this.issue(data, "agent"),
        plugin: this.issue(data, "device"),
      };
    });
  }
  async init() {
    return this.edit((data) => {
      if (data.tokens.length || data.devices.length)
        throw Error("Already initialized; use issue or rotate");
      return {
        agent: this.issue(data, "agent"),
        plugin: this.issue(data, "device"),
      };
    });
  }
  async issueToken(role: "agent" | "device") {
    roleSchema.parse(role);
    return this.edit((data) => this.issue(data, role));
  }
  async rotate(id: string) {
    return this.edit((data) => {
      const old = data.tokens.find((t) => t.id === id);
      if (!old) throw Error("Unknown credential ID");
      data.tokens = data.tokens.filter((t) => t.id !== id);
      return this.issue(data, old.role, old.id);
    });
  }
  async revoke(id: string) {
    await this.edit((data) => {
      if (!data.tokens.some((t) => t.id === id))
        throw Error("Unknown credential ID");
      data.tokens = data.tokens.filter((t) => t.id !== id);
      data.devices = data.devices.filter((d) => d.credentialId !== id);
    });
  }
  async listCredentials() {
    return (await this.read()).tokens.map(({ id, role }) => ({ id, role }));
  }
  async startupCredentials() {
    const select = (data: Data) => {
      // Do not recreate a role whose credentials were explicitly revoked.
      for (const role of ["agent", "device"] as const) {
        if (!data.tokens.some((item) => item.role === role))
          throw Error(`No ${role} credential; use issue --role ${role}`);
      }
      const find = (role: "agent" | "device") => {
        const item = data.tokens.find(
          (item) => item.role === role && item.token,
        );
        return item?.token
          ? { id: item.id, role: item.role, token: item.token }
          : undefined;
      };
      return { agent: find("agent"), plugin: find("device") };
    };
    const current = select(await this.read());
    if (current.agent && current.plugin)
      return { agent: current.agent, plugin: current.plugin };
    // Legacy hashes cannot be reversed. Retain them and issue displayable tokens once.
    return this.edit((data) => {
      const current = select(data);
      return {
        agent: current.agent ?? this.issue(data, "agent"),
        plugin: current.plugin ?? this.issue(data, "device"),
      };
    });
  }
  async authenticate(token: string): Promise<Principal | undefined> {
    const t = (await this.read()).tokens.find((t) => t.hash === hash(token));
    return t
      ? {
          clientId: t.id,
          role: t.role,
          credentialHash: t.hash,
          scopes:
            t.role === "agent"
              ? ["webmcp:read", "webmcp:call"]
              : ["bridge:connect"],
        }
      : undefined;
  }
  async bindDevice(p: Principal, id: string, name: string) {
    const bind = (data: Data) => {
      if (
        p.role !== "device" ||
        !data.tokens.some(
          (t) => t.id === p.clientId && t.hash === p.credentialHash,
        )
      )
        throw new AppError("FORBIDDEN", 403);
      const d = data.devices.find((d) => d.id === id);
      if (d && d.credentialId !== p.clientId)
        throw new AppError("DEVICE_ID_CONFLICT", 409);
      return d;
    };
    const d = bind(await this.read());
    if (d?.name === name) return;
    await this.edit((data) => {
      const existing = bind(data);
      if (existing) existing.name = name;
      else data.devices.push({ id, name, credentialId: p.clientId });
    });
  }
  async device(id: string) {
    const data = await this.read();
    return data.devices.find(
      (d) =>
        d.id === id &&
        data.tokens.some((t) => t.id === d.credentialId && t.role === "device"),
    );
  }
  async allowed(p: Principal, deviceId: string) {
    const data = await this.read();
    return (
      p.role === "agent" &&
      data.tokens.some(
        (t) =>
          t.role === "agent" &&
          t.id === p.clientId &&
          t.hash === p.credentialHash,
      ) &&
      data.devices.some(
        (d) =>
          d.id === deviceId && data.tokens.some((t) => t.id === d.credentialId),
      )
    );
  }
  async healthy() {
    try {
      return (await this.read()).tokens.length > 0;
    } catch {
      return false;
    }
  }
  // Operational call metadata is logged by Gateway; business payloads are never persisted.
  async close() {}
}

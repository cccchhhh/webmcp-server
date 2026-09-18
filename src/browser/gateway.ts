import { randomUUID, randomBytes, createHash } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import {
  AppError,
  alive,
  bytes,
  type Principal,
  type Store,
} from "../types.js";
import { ValidationPool } from "../validation/pool.js";
import {
  envelope,
  type Target,
  type PageRegistration,
  type PageTool,
  type Message,
  type CallInput,
  type Outcome,
} from "./protocol.js";
interface Connection {
  ws: WebSocket;
  principal: Principal;
  deviceId: string;
  epoch: string;
  lastPing: number;
  token: string;
  pages: Set<string>;
}
interface Page extends PageRegistration {
  pageId: string;
  connection: Connection;
  lock?: string;
}
interface Task {
  id: string;
  page: Page;
  target: Target;
  input: CallInput;
  principal: Principal;
  started: number;
  deadline: number;
  delivery: Outcome["delivery"];
  resolve?: (o: Outcome) => void;
  timer?: NodeJS.Timeout;
  dispose: () => void;
  terminal: boolean;
}
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const same = (a: Target, b: Target) =>
  a.pageId === b.pageId &&
  a.localPageId === b.localPageId &&
  a.documentId === b.documentId &&
  a.catalogVersion === b.catalogVersion;
const targetOf = (p: Page): Target => ({
  pageId: p.pageId,
  localPageId: p.localPageId,
  documentId: p.documentId,
  catalogVersion: p.catalogVersion,
});
export class Gateway {
  readonly wss: WebSocketServer;
  readonly pages = new Map<string, Page>();
  private connections = new Map<string, Connection>();
  private tasks = new Map<string, Task>();
  private tickets = new Map<
    string,
    { principal: Principal; deviceId: string; expiresAt: number; token: string }
  >();
  private heartbeat: NodeJS.Timeout;
  readonly counters = {
    calls: 0,
    returned: 0,
    rejected: 0,
    unknown: 0,
    late: 0,
  };
  stopping = false;
  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly validator: ValidationPool,
    readonly log: Logger,
  ) {
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: config.MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
    });
    this.wss.on("connection", (ws) => this.accept(ws));
    this.heartbeat = setInterval(() => void this.sweep(), 1000);
    this.heartbeat.unref();
  }
  private send(
    c: Connection,
    payload: unknown,
    messageId: string = randomUUID(),
  ) {
    if (c.ws.readyState !== WebSocket.OPEN)
      throw new AppError("EXECUTION_UNKNOWN");
    if (c.ws.bufferedAmount > this.config.MAX_MESSAGE_BYTES) {
      c.ws.terminate();
      throw new AppError("EXECUTION_UNKNOWN");
    }
    c.ws.send(
      JSON.stringify({
        protocolVersion: 1,
        messageId,
        connectionEpoch: c.epoch,
        payload,
      }),
    );
  }
  async ticket(p: Principal, deviceId: string, token: string) {
    if (this.stopping) throw new AppError("SERVICE_STOPPING", 503);
    const d = await this.store.device(deviceId);
    if (
      !alive(p) ||
      !p.scopes.includes("bridge:connect") ||
      !d ||
      (p.role === "device" && p.deviceId !== deviceId)
    )
      throw new AppError("FORBIDDEN", 403);
    if (this.tickets.size >= 1000) throw new AppError("CAPACITY", 429);
    const ticket = randomBytes(32).toString("base64url"),
      expiresAt = Math.min(Date.now() + 30000, p.expiresAt ?? Infinity);
    this.tickets.set(digest(ticket), {
      principal: p,
      deviceId,
      expiresAt,
      token,
    });
    return {
      ticket,
      expiresAt,
      wsUrl: this.config.PUBLIC_BASE_URL.replace(/^http/, "ws") + "/bridge/ws",
    };
  }
  private accept(ws: WebSocket) {
    let c: Connection | undefined;
    let pending = 0;
    const timeout = setTimeout(
      () => ws.close(1008, "Authentication timeout"),
      5000,
    );
    let chain = Promise.resolve();
    ws.on("error", () => {});
    ws.on("message", (raw) => {
      if (++pending > 100) {
        ws.terminate();
        return;
      }
      chain = chain
        .then(async () => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const parsed = envelope.safeParse(JSON.parse(raw.toString()));
          if (!parsed.success) throw new AppError("INVALID_MESSAGE");
          const m = parsed.data;
          if (!c) {
            if (m.payload.type !== "AUTH" || m.connectionEpoch || this.stopping)
              throw new AppError("UNAUTHORIZED");
            const t = this.tickets.get(digest(m.payload.ticket));
            this.tickets.delete(digest(m.payload.ticket));
            if (!t || t.expiresAt <= Date.now() || !alive(t.principal))
              throw new AppError("UNAUTHORIZED");
            const d = await this.store.device(t.deviceId);
            if (!d || d.credentialId !== t.principal.clientId)
              throw new AppError("UNAUTHORIZED");
            if (!(await this.store.authenticate(t.token)))
              throw new AppError("UNAUTHORIZED");
            if (ws.readyState !== WebSocket.OPEN) return;
            const old = this.connections.get(t.deviceId);
            if (!old && this.connections.size >= 10)
              throw new AppError("CAPACITY");
            if (old) {
              this.drop(old);
              old.ws.close(1000, "Replaced");
            }
            c = {
              ws,
              principal: t.principal,
              deviceId: t.deviceId,
              epoch: randomUUID(),
              lastPing: Date.now(),
              token: t.token,
              pages: new Set(),
            };
            this.connections.set(c.deviceId, c);
            clearTimeout(timeout);
            this.send(
              c,
              {
                type: "AUTH_OK",
                deviceId: c.deviceId,
                connectionEpoch: c.epoch,
              },
              m.messageId,
            );
            return;
          }
          if (
            m.connectionEpoch !== c.epoch ||
            this.connections.get(c.deviceId) !== c ||
            !alive(c.principal)
          )
            throw new AppError("STALE_CONNECTION");
          try {
            await this.message(c, m);
          } catch (e) {
            this.send(c, {
              type: "ERROR",
              replyTo: m.messageId,
              code: e instanceof AppError ? e.code : "INVALID_MESSAGE",
              message: "Message rejected",
            });
          }
        })
        .catch(() => ws.close(1008, "Invalid authentication or message"))
        .finally(() => {
          pending--;
        });
    });
    ws.on("close", () => {
      clearTimeout(timeout);
      if (c) this.drop(c);
    });
  }
  private async tools(tools: PageTool[]) {
    if (
      bytes(tools) > 1048576 ||
      new Set(tools.map((t) => t.name)).size !== tools.length
    )
      throw new AppError("INVALID_CATALOG");
    const out: PageTool[] = [];
    for (const tool of tools) {
      const checked = await this.validator.run(
        tool.inputSchema,
        undefined,
        true,
      );
      out.push(
        checked.ok
          ? tool
          : { ...tool, executable: false, unavailableReason: checked.code },
      );
    }
    return out;
  }
  private async message(c: Connection, m: Message) {
    const p = m.payload;
    if (p.type === "AUTH") throw new AppError("ALREADY_AUTHENTICATED");
    if (p.type === "PING") {
      c.lastPing = Date.now();
      this.send(c, { type: "PONG", timestamp: p.timestamp });
      return;
    }
    if (p.type === "REGISTER_PAGE") {
      if (this.stopping) throw new AppError("SERVICE_STOPPING");
      const existing = [...c.pages]
        .map((id) => this.pages.get(id)!)
        .find(
          (x) =>
            x.localPageId === p.page.localPageId ||
            x.documentId === p.page.documentId,
        );
      if (existing) {
        if (
          existing.localPageId !== p.page.localPageId ||
          existing.documentId !== p.page.documentId
        )
          throw new AppError("INVALID_TARGET");
        this.send(
          c,
          { type: "PAGE_REGISTERED", target: targetOf(existing) },
          m.messageId,
        );
        return;
      }
      if (c.pages.size >= 100) throw new AppError("CAPACITY");
      const u = new URL(p.page.url);
      if (!["http:", "https:"].includes(u.protocol))
        throw new AppError("INVALID_PAGE_URL");
      const tools = await this.tools(p.page.tools);
      if (this.connections.get(c.deviceId) !== c || this.stopping)
        throw new AppError("STALE_CONNECTION");
      if (
        p.page.authorizedToolNames.some((n) => !tools.some((t) => t.name === n))
      )
        throw new AppError("INVALID_GRANT");
      const page: Page = {
        ...p.page,
        url: u.origin + u.pathname,
        tools,
        pageId: randomUUID(),
        connection: c,
      };
      this.pages.set(page.pageId, page);
      c.pages.add(page.pageId);
      this.send(
        c,
        { type: "PAGE_REGISTERED", target: targetOf(page) },
        m.messageId,
      );
      return;
    }
    if (
      p.type === "CALL_ACK" ||
      p.type === "CALL_RESULT" ||
      p.type === "CANCEL_ACK"
    ) {
      const t = this.tasks.get(p.callId);
      if (!t || t.page.connection !== c || !same(t.target, p.target))
        throw new AppError("INVALID_TARGET");
      if (p.type === "CALL_ACK") {
        if (t.terminal && p.accepted) return;
        if (p.accepted) t.delivery = "acknowledged";
        else
          await this.finish(
            t,
            "rejected",
            p.errorCode ?? "TOOL_UNAVAILABLE",
            undefined,
            "unclassified",
            true,
          );
      } else if (p.type === "CALL_RESULT") {
        if (bytes(p.rawResult ?? null) > this.config.MAX_RESULT_BYTES)
          await this.finish(
            t,
            "unknown",
            "RESULT_TOO_LARGE",
            undefined,
            "unclassified",
            p.executionSettled,
          );
        else if (p.errorCode || !p.executionSettled)
          await this.finish(
            t,
            "unknown",
            p.errorCode ?? "EXECUTION_UNKNOWN",
            undefined,
            p.business,
            p.executionSettled,
          );
        else
          await this.finish(
            t,
            "returned",
            undefined,
            p.rawResult,
            p.business,
            true,
          );
      } else if (p.outcome === "not_started")
        await this.finish(
          t,
          "rejected",
          "CANCELLED",
          undefined,
          "unclassified",
          true,
        );
      return;
    }
    const page = this.pages.get(p.target.pageId);
    if (!page || page.connection !== c || !same(targetOf(page), p.target))
      throw new AppError("INVALID_TARGET");
    if (p.type === "REMOVE_PAGE") this.remove(page);
    if (p.type === "REVOKE") {
      page.authorizedToolNames = page.authorizedToolNames.filter(
        (n) => !p.toolNames.includes(n),
      );
      await this.enforce();
    }
    if (p.type === "PAGE_STATE") {
      page.executionBlocked = p.executionBlocked;
      // PAGE_STATE is not a result: only terminal/unknown tasks may be released.
      const task = page.lock ? this.tasks.get(page.lock) : undefined;
      if (!p.executionBlocked && task?.terminal) {
        this.tasks.delete(task.id);
        page.lock = undefined;
      }
    }
    if (p.type === "SYNC_CATALOG") {
      if (p.nextCatalogVersion === page.catalogVersion)
        throw new AppError("CATALOG_STALE");
      const tools = await this.tools(p.tools);
      if (p.authorizedToolNames.some((n) => !tools.some((t) => t.name === n)))
        throw new AppError("INVALID_GRANT");
      if (this.pages.get(page.pageId) !== page)
        throw new AppError("INVALID_TARGET");
      page.tools = tools;
      page.catalogVersion = p.nextCatalogVersion;
      page.authorizedToolNames = p.authorizedToolNames;
      await this.enforce();
    }
    this.send(c, { type: "APPLIED", replyTo: m.messageId });
  }
  private remove(page: Page) {
    this.pages.delete(page.pageId);
    page.connection.pages.delete(page.pageId);
    for (const t of this.tasks.values())
      if (t.page === page) {
        void this.finish(
          t,
          "unknown",
          "EXECUTION_UNKNOWN",
          undefined,
          "unclassified",
          true,
        );
      }
  }
  private drop(c: Connection) {
    if (this.connections.get(c.deviceId) !== c) return;
    this.connections.delete(c.deviceId);
    for (const id of [...c.pages]) {
      const p = this.pages.get(id);
      if (p) this.remove(p);
    }
  }
  private async access(p: Principal, page: Page, toolName?: string) {
    if (!(await this.store.authenticate(page.connection.token))) return false;
    const allowed = await this.store.allowed(p, page.connection.deviceId);
    // Recheck mutable routing after asynchronous storage access.
    return (
      allowed &&
      alive(p) &&
      alive(page.connection.principal) &&
      this.pages.get(page.pageId) === page &&
      this.connections.get(page.connection.deviceId) === page.connection &&
      (!toolName || page.authorizedToolNames.includes(toolName))
    );
  }
  async list(p: Principal) {
    const pages = [];
    for (const page of this.pages.values())
      if (await this.access(p, page)) {
        const d = await this.store.device(page.connection.deviceId);
        if (d)
          pages.push({
            pageId: page.pageId,
            deviceId: d.id,
            deviceName: d.name,
            title: page.title,
            url: page.url,
            catalogVersion: page.catalogVersion,
          });
      }
    const result = { pages };
    if (bytes(result) > this.config.MAX_RESULT_BYTES)
      throw new AppError("RESULT_TOO_LARGE");
    return result;
  }
  async catalog(p: Principal, pageId: string) {
    const page = this.pages.get(pageId);
    if (!page || !(await this.access(p, page)))
      throw new AppError("PAGE_UNAVAILABLE");
    const result = {
      pageId,
      catalogVersion: page.catalogVersion,
      tools: page.tools.filter((t) =>
        page.authorizedToolNames.includes(t.name),
      ),
    };
    if (bytes(result) > this.config.MAX_RESULT_BYTES)
      throw new AppError("RESULT_TOO_LARGE");
    return result;
  }
  async call(
    p: Principal,
    input: CallInput,
    signal: AbortSignal,
  ): Promise<Outcome> {
    const id = randomUUID(),
      started = Date.now(),
      deadline = started + this.config.TOOL_TIMEOUT_MS;
    this.counters.calls++;
    const rejected = (errorCode: string): Outcome => {
      this.counters.rejected++;
      return {
        callId: id,
        pageId: input.pageId,
        catalogVersion: input.catalogVersion,
        toolName: input.toolName,
        delivery: "not_sent",
        execution: "rejected",
        business: "unclassified",
        errorCode,
      };
    };
    if (this.stopping) return rejected("SERVICE_STOPPING");
    const page = this.pages.get(input.pageId);
    if (!page || !(await this.access(p, page, input.toolName)))
      return rejected("PAGE_UNAVAILABLE");
    if (page.catalogVersion !== input.catalogVersion)
      return rejected("CATALOG_STALE");
    const tool = page.tools.find(
      (t) => t.name === input.toolName && t.executable,
    );
    if (!tool) return rejected("TOOL_UNAVAILABLE");
    if (bytes(input.arguments) > this.config.MAX_ARGUMENT_BYTES)
      return rejected("INVALID_ARGUMENTS");
    const checked = await this.validator.run(tool.inputSchema, input.arguments);
    if (!checked.ok) return rejected(checked.code ?? "INVALID_ARGUMENTS");
    if (!(await this.access(p, page, input.toolName)))
      return rejected("PAGE_UNAVAILABLE");
    if (page.catalogVersion !== input.catalogVersion)
      return rejected("CATALOG_STALE");
    if (signal.aborted || Date.now() >= deadline) return rejected("CANCELLED");
    if (this.stopping) return rejected("SERVICE_STOPPING");
    if (page.lock || page.executionBlocked || this.tasks.size >= 100)
      return rejected("PAGE_BUSY");
    let resolve!: (v: Outcome) => void;
    const result = new Promise<Outcome>((r) => {
      resolve = r;
    });
    const t: Task = {
      id,
      page,
      target: targetOf(page),
      input,
      principal: p,
      started,
      deadline,
      delivery: "not_sent",
      resolve,
      dispose: () => {},
      terminal: false,
    };
    page.lock = id;
    this.tasks.set(id, t);
    try {
      if (
        t.terminal ||
        !(await this.access(p, page, input.toolName)) ||
        page.catalogVersion !== input.catalogVersion ||
        signal.aborted ||
        Date.now() >= deadline ||
        this.stopping
      ) {
        await this.finish(
          t,
          "rejected",
          "PAGE_UNAVAILABLE",
          undefined,
          "unclassified",
          true,
        );
        return result;
      }
      const cancel = () => {
        if (t.terminal) return;
        try {
          this.send(page.connection, {
            type: "CANCEL",
            target: t.target,
            callId: id,
            reason: "deadline_or_cancel",
          });
        } catch {}
        void this.finish(t, "unknown", "EXECUTION_UNKNOWN");
      };
      t.dispose = () => signal.removeEventListener("abort", cancel);
      signal.addEventListener("abort", cancel, { once: true });
      t.timer = setTimeout(cancel, Math.max(1, deadline - Date.now()));
      t.delivery = "sent";
      this.send(page.connection, {
        type: "CALL",
        target: t.target,
        callId: id,
        toolName: input.toolName,
        arguments: input.arguments,
        deadlineAt: deadline,
      });
    } catch {
      await this.finish(
        t,
        t.delivery === "not_sent" ? "rejected" : "unknown",
        t.delivery === "not_sent" ? "INVOCATION_FAILED" : "EXECUTION_UNKNOWN",
        undefined,
        "unclassified",
        t.delivery === "not_sent",
      );
    }
    return result;
  }
  private async finish(
    t: Task,
    execution: Outcome["execution"],
    errorCode?: string,
    rawResult?: unknown,
    business: Outcome["business"] = "unclassified",
    settled = false,
  ) {
    if (!this.tasks.has(t.id)) return;
    const resolve = t.resolve;
    t.resolve = undefined;
    const late = t.terminal;
    t.terminal = true;
    clearTimeout(t.timer);
    t.dispose();
    if (settled) {
      this.tasks.delete(t.id);
      if (t.page.lock === t.id) t.page.lock = undefined;
    }
    // Check authorization again after execution, including grants revoked during the call.
    let permitted = false;
    try {
      permitted = await this.access(t.principal, t.page, t.input.toolName);
    } catch {}
    if (!permitted) {
      rawResult = undefined;
      if (execution === "returned") {
        execution = "unknown";
        errorCode = "PAGE_UNAVAILABLE";
      }
    }
    const outcome: Outcome = {
      callId: t.id,
      pageId: t.input.pageId,
      catalogVersion: t.input.catalogVersion,
      toolName: t.input.toolName,
      delivery: t.delivery,
      execution,
      business,
      ...(rawResult !== undefined ? { rawResult } : {}),
      ...(errorCode
        ? {
            errorCode,
            message:
              execution === "unknown"
                ? "结果未知，请核实业务状态；不要自动重试。"
                : errorCode,
          }
        : {}),
    };
    if (late) this.counters.late++;
    else this.counters[execution]++;
    this.log.info(
      {
        callId: t.id,
        toolName: t.input.toolName,
        execution,
        errorCode,
        late,
        durationMs: Date.now() - t.started,
      },
      "call finished",
    );
    resolve?.(outcome);
  }
  async enforce() {
    for (const t of this.tasks.values())
      if (
        !t.terminal &&
        !(await this.access(t.principal, t.page, t.input.toolName))
      ) {
        try {
          this.send(t.page.connection, {
            type: "CANCEL",
            target: t.target,
            callId: t.id,
            reason: "revoked",
          });
        } catch {}
        await this.finish(
          t,
          t.delivery === "not_sent" ? "rejected" : "unknown",
          "PAGE_UNAVAILABLE",
          undefined,
          "unclassified",
          t.delivery === "not_sent",
        );
      }
    for (const c of this.connections.values())
      if (!(await this.store.device(c.deviceId))) {
        this.drop(c);
        c.ws.close(1008, "Revoked");
      }
  }
  private sweeping = false;
  private async sweep() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      for (const [k, t] of this.tickets)
        if (t.expiresAt <= Date.now()) this.tickets.delete(k);
      for (const c of this.connections.values()) {
        const localRevoked =
          !(await this.store.device(c.deviceId)) ||
          !(await this.store.authenticate(c.token));
        if (
          Date.now() - c.lastPing >= 60000 ||
          !alive(c.principal) ||
          localRevoked
        ) {
          this.drop(c);
          c.ws.close(1008, "Expired");
        }
      }
      await this.enforce();
    } catch {
      this.log.error("gateway authorization refresh failed");
    } finally {
      this.sweeping = false;
    }
  }
  get metrics() {
    return {
      ...this.counters,
      connections: this.connections.size,
      pages: this.pages.size,
      unresolved: this.tasks.size,
    };
  }
  get pending() {
    return [...this.tasks.values()].filter((t) => !t.terminal).length;
  }
  async close() {
    this.stopping = true;
    clearInterval(this.heartbeat);
    await Promise.all(
      [...this.tasks.values()].map((t) =>
        this.finish(
          t,
          "unknown",
          "SERVICE_STOPPING",
          undefined,
          "unclassified",
          true,
        ),
      ),
    );
    for (const ws of this.wss.clients) ws.terminate();
    this.tickets.clear();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }
}

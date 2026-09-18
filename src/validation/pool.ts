import { Worker } from "node:worker_threads";
import { AppError, bytes } from "../types.js";
interface Result {
  ok: boolean;
  code?: string;
  errors: string[];
}
export class ValidationPool {
  private active = 0;
  private queue: (() => void)[] = [];
  private workers = new Set<Worker>();
  private closed = false;
  async run(schema: unknown, value?: unknown, check = false): Promise<Result> {
    if (this.closed) throw new AppError("SERVICE_STOPPING");
    if (bytes(schema) > 65536)
      return {
        ok: false,
        code: "SCHEMA_UNSUPPORTED",
        errors: ["Schema exceeds 64 KiB"],
      };
    if (this.active >= 2) {
      if (this.queue.length >= 100) throw new AppError("PAGE_BUSY");
      await new Promise<void>((r) => this.queue.push(r));
    }
    if (this.closed) throw new AppError("SERVICE_STOPPING");
    this.active++;
    try {
      return await new Promise<Result>((resolve) => {
        const w = new Worker(
          new URL("./validation-worker.js", import.meta.url),
          {
            resourceLimits: { maxOldGenerationSizeMb: 32 },
          },
        );
        this.workers.add(w);
        let done = false;
        let timer = setTimeout(
          () =>
            finish({
              ok: false,
              code: "SCHEMA_VALIDATION_TIMEOUT",
              errors: ["Worker startup timeout"],
            }),
          5000,
        );
        const finish = (v: Result) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          void w.terminate().finally(() => {
            this.workers.delete(w);
            resolve(v);
          });
        };
        w.on("message", (v) => {
          if (v.ready) {
            clearTimeout(timer);
            timer = setTimeout(
              () =>
                finish({
                  ok: false,
                  code: "SCHEMA_VALIDATION_TIMEOUT",
                  errors: ["Validation exceeded 200 ms"],
                }),
              200,
            );
            w.postMessage({ schema, value, check });
          } else finish(v);
        });
        w.on("error", () =>
          finish({
            ok: false,
            code: "SCHEMA_UNSUPPORTED",
            errors: ["Validation worker failed"],
          }),
        );
        w.on("exit", () =>
          finish({
            ok: false,
            code: "SCHEMA_UNSUPPORTED",
            errors: ["Validation worker exited"],
          }),
        );
      });
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
  async close() {
    this.closed = true;
    for (const r of this.queue.splice(0)) r();
    await Promise.all([...this.workers].map((w) => w.terminate()));
  }
}

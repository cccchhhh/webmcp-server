import { parentPort } from "node:worker_threads";
import { checkSchema, validate } from "./schema.js";
parentPort!.on("message", ({ schema, value, check }) => {
  parentPort!.postMessage(
    check ? checkSchema(schema) : validate(schema, value),
  );
});
parentPort!.postMessage({ ready: true });

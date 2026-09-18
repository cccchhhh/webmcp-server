import { Validator } from "jsonschema";
import metaSchema from "./draft07.json" with { type: "json" };
type Schema = boolean | Record<string, unknown>;
export interface Validation {
  ok: boolean;
  errors: string[];
  code?: string;
}
const keywords = new Set(
  "$schema $id $ref $comment title description default examples readOnly writeOnly type enum const multipleOf maximum exclusiveMaximum minimum exclusiveMinimum maxLength minLength pattern format items additionalItems maxItems minItems uniqueItems contains maxProperties minProperties required properties patternProperties additionalProperties dependencies propertyNames if then else allOf anyOf oneOf not definitions".split(
    " ",
  ),
);
const maps = new Set(["properties", "patternProperties", "definitions"]);
const single = new Set([
  "items",
  "additionalItems",
  "additionalProperties",
  "contains",
  "propertyNames",
  "if",
  "then",
  "else",
  "not",
]);
const lists = new Set(["allOf", "anyOf", "oneOf"]);
export function checkSchema(schema: Schema): Validation {
  const errors: string[] = [];
  const refs: string[] = [];
  let nodes = 0;
  if (new TextEncoder().encode(JSON.stringify(schema)).length > 65536)
    return {
      ok: false,
      code: "SCHEMA_UNSUPPORTED",
      errors: ["Schema 超过 64 KiB"],
    };
  function visit(s: unknown, depth: number) {
    if (++nodes > 10000) throw Error("Schema 节点超过 10000");
    if (depth > 32) throw Error("Schema 深度超过 32");
    if (typeof s === "boolean") return;
    if (!s || typeof s !== "object" || Array.isArray(s))
      throw Error("Schema 必须为对象或布尔值");
    for (const [k, v] of Object.entries(s)) {
      if (!keywords.has(k)) throw Error(`不支持的 Schema 关键词：${k}`);
      if (
        k === "$schema" &&
        v !== "http://json-schema.org/draft-07/schema#" &&
        v !== "https://json-schema.org/draft-07/schema#"
      )
        throw Error("仅支持 draft-07");
      if (k === "$id" && depth > 0) throw Error("暂不支持嵌套 $id");
      if (k === "$ref") {
        if (typeof v !== "string" || !v.startsWith("#"))
          throw Error("禁止远程引用");
        refs.push(v);
      }
      if (maps.has(k)) {
        if (!v || typeof v !== "object" || Array.isArray(v))
          throw Error(`${k} 必须为对象`);
        for (const [name, child] of Object.entries(v)) {
          if (k === "patternProperties") new RegExp(name);
          visit(child, depth + 1);
        }
      }
      if (single.has(k)) {
        if (k === "items" && Array.isArray(v))
          v.forEach((x) => visit(x, depth + 1));
        else visit(v, depth + 1);
      }
      if (lists.has(k)) {
        if (!Array.isArray(v) || !v.length) throw Error(`${k} 必须为非空数组`);
        v.forEach((x) => visit(x, depth + 1));
      }
      if (k === "dependencies") {
        if (!v || typeof v !== "object" || Array.isArray(v))
          throw Error("dependencies 必须为对象");
        Object.values(v).forEach((x) => {
          if (!Array.isArray(x)) visit(x, depth + 1);
          else if (x.some((y) => typeof y !== "string"))
            throw Error("依赖字段必须是字符串");
        });
      }
      if (k === "pattern") {
        if (typeof v !== "string") throw Error("pattern 必须为字符串");
        new RegExp(v);
      }
    }
  }
  try {
    visit(schema, 0);
    for (const ref of refs) {
      let at: unknown = schema;
      if (ref !== "#") {
        if (!ref.startsWith("#/")) throw Error("只支持本地 JSON Pointer");
        for (const key of ref.slice(2).split("/")) {
          const k = decodeURIComponent(key)
            .replace(/~1/g, "/")
            .replace(/~0/g, "~");
          if (!at || typeof at !== "object" || !Object.hasOwn(at, k))
            throw Error(`引用不存在：${ref}`);
          at = (at as Record<string, unknown>)[k];
        }
      }
      if (
        typeof at !== "boolean" &&
        (!at || typeof at !== "object" || Array.isArray(at))
      )
        throw Error("引用目标不是 Schema");
    }
    const validator = new Validator();
    const meta = metaSchema as never;
    if (meta) {
      const r = validator.validate(schema, meta);
      if (!r.valid) throw Error(r.errors.map((e) => e.stack).join("; "));
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : "无效 Schema");
  }
  return {
    ok: !errors.length,
    errors,
    code: errors.length ? "SCHEMA_UNSUPPORTED" : undefined,
  };
}
export function validate(schema: Schema, value: unknown): Validation {
  const checked = checkSchema(schema);
  if (!checked.ok) return checked;
  try {
    const validator = new Validator();
    const result = validator.validate(value, schema as never, {
      nestedErrors: true,
      skipAttributes: ["format"],
    });
    return {
      ok: result.valid,
      errors: result.errors.slice(0, 30).map((e) => e.stack),
      code: result.valid ? undefined : "INVALID_ARGUMENTS",
    };
  } catch (e) {
    return {
      ok: false,
      code: "SCHEMA_UNSUPPORTED",
      errors: [e instanceof Error ? e.message : "校验失败"],
    };
  }
}

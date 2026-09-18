import { test, expect } from "vitest";
const { ValidationPool } = await import(
  process.env.WEBMCP_BRIDGE_MODULE ??
    new URL("../dist/index.js", import.meta.url).href
);
test("schema validation is bounded and never mutates arguments", async () => {
  const pool = new ValidationPool();
  try {
    const value = {};
    expect(
      (
        await pool.run(
          { type: "object", properties: { x: { default: "x" } } },
          value,
        )
      ).ok,
    ).toBe(true);
    expect(value).toEqual({});
    for (const schema of [
      { $ref: "https://evil.com/schema" },
      { unknownKeyword: true },
      { $schema: "https://json-schema.org/draft/2020-12/schema" },
    ])
      expect((await pool.run(schema, {}, true)).code).toBe(
        "SCHEMA_UNSUPPORTED",
      );
    expect(
      (
        await pool.run(
          { type: "string", pattern: "^(a+)+$" },
          "a".repeat(100) + "!",
        )
      ).code,
    ).toBe("SCHEMA_VALIDATION_TIMEOUT");
    expect((await pool.run({ type: "number" }, 42)).ok).toBe(true);
  } finally {
    await pool.close();
  }
});

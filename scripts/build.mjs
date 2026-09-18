import { build, context } from "esbuild";
import { chmod, mkdir, rm, copyFile } from "node:fs/promises";
const watch = process.argv.includes("--watch");
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await mkdir("test-results", { recursive: true });
const options = {
  entryPoints: {
    cli: "src/cli.ts",
    index: "src/index.ts",
    protocol: "src/browser/protocol.ts",
    "validation-worker": "src/validation/worker.ts",
  },
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  packages: "external",
  sourcemap: true,
  plugins: [
    {
      name: "package-files",
      setup(build) {
        build.onEnd(async (result) => {
          if (result.errors.length) return;
          await chmod("dist/cli.js", 0o755);
          await copyFile("src/browser/protocol.ts", "dist/bridge-v1.ts");
        });
      },
    },
  ],
};
if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else await build(options);

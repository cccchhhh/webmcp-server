import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
await mkdir("artifacts", { recursive: true });
const packed = spawnSync("npm", ["pack", "--pack-destination", "artifacts"], {
  stdio: "inherit",
});
if (packed.error) throw packed.error;
process.exitCode = packed.status ?? 1;

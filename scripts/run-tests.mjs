import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tests = (await readdir(join(root, "test")))
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => join("test", name));

if (tests.length === 0) throw new Error("No Needlepath Action tests were found.");

const arguments_ = ["--import", "tsx", "--test", "--test-reporter=spec"];
if (process.argv.includes("--coverage")) {
  arguments_.push("--experimental-test-coverage");
}
arguments_.push(...tests);

const result = spawnSync(process.execPath, arguments_, {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.signal) throw new Error(`Test runner terminated by ${result.signal}.`);
process.exitCode = result.status ?? 1;

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("action contract is file-based, shadow-first, r3-pinned, and secret-safe", async () => {
  const contract = await readFile(new URL("../action.yml", import.meta.url), "utf8");

  assert.match(contract, /mode:[\s\S]*default:\s*["']?shadow/);
  assert.match(contract, /operating-point:[\s\S]*default:\s*["']?np-2026-08-r3/);
  assert.match(contract, /context-path:/);
  assert.match(contract, /original-context-path:/);
  assert.match(contract, /estimated-tokens-saved:/);
  assert.match(contract, /metrics-path:/);
  assert.match(contract, /using:\s*["']?node24/);
  assert.doesNotMatch(contract, /^\s+(api-key|github-token):/m);
  assert.doesNotMatch(contract, /docker:/);
});

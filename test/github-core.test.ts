import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GithubFileCore } from "../src/github-core.js";

test("GitHub file commands encode multiline outputs without workflow-command injection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "needlepath-commands-"));
  const output = join(directory, "output.txt");
  const summary = join(directory, "summary.md");
  await writeFile(output, "", "utf8");
  await writeFile(summary, "", "utf8");
  const logs: string[] = [];
  const core = new GithubFileCore(
    {
      "INPUT_MODE": "shadow",
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
    },
    (message) => logs.push(message),
    () => {},
  );

  assert.equal(core.getInput("mode"), "shadow");
  core.setOutput("safe", "line one\n::warning::not-a-command");
  await core.addSummary("## Metadata only\n");

  const outputWire = await readFile(output, "utf8");
  assert.match(outputWire, /^safe<<needlepath_/);
  assert.match(outputWire, /::warning::not-a-command/);
  assert.equal(logs.length, 0);
  assert.equal(await readFile(summary, "utf8"), "## Metadata only\n");
});

test("mask, warning, and failure commands escape untrusted control characters", () => {
  const logs: string[] = [];
  const core = new GithubFileCore({}, (message) => logs.push(message), () => {});

  core.setSecret("secret\r\n::error::inject");
  core.warning("safe\r\n::error::inject");
  core.setFailed("failed\r\n::warning::inject");

  assert.equal(logs.length, 3);
  assert.ok(logs.every((message) => !message.includes("\r") && !message.includes("\n")));
  assert.ok(logs[0]?.startsWith("::add-mask::"));
  assert.ok(logs[1]?.startsWith("::warning::"));
  assert.ok(logs[2]?.startsWith("::error::"));
});

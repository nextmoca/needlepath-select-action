import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { NeedlepathClient } from "@nextmoca/needlepath-sdk";

import { runAction, type ActionCore } from "../src/main.js";

class FakeCore implements ActionCore {
  readonly outputs = new Map<string, string>();
  readonly secrets: string[] = [];
  readonly warnings: string[] = [];
  summary = "";
  failure = "";

  constructor(readonly inputs: Record<string, string>) {}
  getInput(name: string): string {
    return this.inputs[name] ?? "";
  }
  setOutput(name: string, value: string): void {
    this.outputs.set(name, value);
  }
  setSecret(value: string): void {
    this.secrets.push(value);
  }
  addSummary(markdown: string): Promise<void> {
    this.summary = markdown;
    return Promise.resolve();
  }
  warning(message: string): void {
    this.warnings.push(message);
  }
  setFailed(message: string): void {
    this.failure = message;
  }
}

function responseResult() {
  return {
    applied: true,
    reason: "ok",
    requestId: "req_action",
    operatingPoint: "np-2026-08-r3",
    shadow: false,
    response: {
      requestId: "req_action",
      renderedContext: "selected evidence",
      policyVersion: "np-2026-08-r3",
      selected: [],
      tokensBefore: 1000,
      tokensAfter: 250,
      tokensSaved: 750,
      recordsAvailable: 1,
      recordsSelected: 1,
      fallbackUsed: false,
      selectionError: null,
      engineLatencyMs: 8,
      budgetTokens: 8000,
      attemptedBudgetTokens: [4096],
      reductionRatio: 0.75,
      safety: null,
      gate: null,
      formatMetrics: {},
      outcome: "engaged",
      taskKind: "review",
      selectionTrace: null,
      selectionId: "sel_action",
      extra: {},
    },
    error: null,
    clientLatencyMs: 10,
    attempts: 1,
    requestBytes: 100,
  };
}

test("action emits only paths and safe metadata while applying selected context", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "needlepath-workspace-"));
  const runnerTemp = await mkdtemp(join(tmpdir(), "needlepath-runner-"));
  await writeFile(join(workspace, "context.txt"), "private original context", "utf8");
  const core = new FakeCore({
    "workflow-type": "custom",
    query: "Review",
    "context-path": "context.txt",
    mode: "select",
  });
  const client = { select: async () => responseResult() };

  await runAction({
    core,
    env: {
      GITHUB_WORKSPACE: workspace,
      RUNNER_TEMP: runnerTemp,
      NEEDLEPATH_API_KEY: "np_live_secret",
    },
    clientFactory: () => client as unknown as NeedlepathClient,
  });

  assert.equal(core.failure, "");
  assert.equal(core.outputs.get("applied"), "true");
  assert.equal(core.outputs.get("estimated-tokens-saved"), "750");
  assert.match(await readFile(core.outputs.get("context-path")!, "utf8"), /selected evidence/);
  const metrics = await readFile(core.outputs.get("metrics-path")!, "utf8");
  assert.match(metrics, /"tokens_saved": 750/);
  assert.doesNotMatch(metrics, /private original context|selected evidence|np_live_secret/);
  const publicSurface = `${[...core.outputs.values()].join("\n")}\n${core.summary}\n${core.warnings.join("\n")}`;
  assert.doesNotMatch(publicSurface, /private original context|np_live_secret/);
  assert.deepEqual(core.secrets, ["np_live_secret"]);
});

test("Needlepath outage is a successful exact passthrough, not a failed GitHub job", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "needlepath-workspace-"));
  const runnerTemp = await mkdtemp(join(tmpdir(), "needlepath-runner-"));
  await writeFile(join(workspace, "context.txt"), "byte exact original", "utf8");
  const core = new FakeCore({
    "workflow-type": "custom",
    query: "Review",
    "context-path": "context.txt",
    mode: "select",
  });
  const client = {
    select: async () => ({
      ...responseResult(),
      applied: false,
      reason: "transport_error",
      response: null,
    }),
  };

  await runAction({
    core,
    env: { GITHUB_WORKSPACE: workspace, RUNNER_TEMP: runnerTemp },
    clientFactory: () => client as unknown as NeedlepathClient,
  });

  assert.equal(core.failure, "");
  assert.equal(core.outputs.get("fail-open"), "true");
  assert.deepEqual(
    await readFile(core.outputs.get("context-path")!),
    await readFile(core.outputs.get("original-context-path")!),
  );
});

test("recoverable configuration errors publish exact fail-open context outputs", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "needlepath-workspace-"));
  const runnerTemp = await mkdtemp(join(tmpdir(), "needlepath-runner-"));
  await writeFile(join(workspace, "context.txt"), "configuration fallback context", "utf8");
  const core = new FakeCore({
    "workflow-type": "custom",
    query: "Review",
    "context-path": "context.txt",
    mode: "invalid-mode",
  });
  let clientCreated = false;

  await runAction({
    core,
    env: { GITHUB_WORKSPACE: workspace, RUNNER_TEMP: runnerTemp },
    clientFactory: () => {
      clientCreated = true;
      throw new Error("client must not be created for configuration fallback");
    },
  });

  assert.equal(clientCreated, false);
  assert.equal(core.failure, "");
  assert.match(core.warnings.join("\n"), /mode must be shadow or select/i);
  assert.equal(core.outputs.get("fail-open"), "true");
  assert.equal(core.outputs.get("reason"), "configuration_error");
  assert.equal(core.outputs.get("downstream-context"), "original");
  assert.deepEqual(
    await readFile(core.outputs.get("context-path")!),
    await readFile(core.outputs.get("original-context-path")!),
  );
  assert.match(await readFile(core.outputs.get("context-path")!, "utf8"), /configuration fallback context/);
});

test("configuration fallback preserves valid shadow-mode metadata", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "needlepath-workspace-"));
  const runnerTemp = await mkdtemp(join(tmpdir(), "needlepath-runner-"));
  await writeFile(join(workspace, "context.txt"), "shadow fallback context", "utf8");
  const core = new FakeCore({
    "workflow-type": "custom",
    query: "Review",
    "context-path": "context.txt",
    mode: "shadow",
    "timeout-ms": "not-a-number",
  });

  await runAction({
    core,
    env: { GITHUB_WORKSPACE: workspace, RUNNER_TEMP: runnerTemp },
  });

  assert.equal(core.failure, "");
  assert.equal(core.outputs.get("fail-open"), "false");
  assert.equal(core.outputs.get("reason"), "configuration_error");
  assert.match(core.summary, /Configuration fallback; original context preserved/i);
  assert.doesNotMatch(core.summary, /Shadow evaluation/);
  assert.match(await readFile(core.outputs.get("metrics-path")!, "utf8"), /"mode": "shadow"/);
});

test("invalid customer configuration fails with a safe actionable message", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "needlepath-workspace-"));
  const core = new FakeCore({ "workflow-type": "custom" });

  await runAction({ core, env: { GITHUB_WORKSPACE: workspace } });

  assert.match(core.failure, /query or task-path/i);
  assert.doesNotMatch(core.failure, /stack|undefined|workspace/i);
});

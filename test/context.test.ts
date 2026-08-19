import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { SelectionResult } from "@nextmoca/needlepath-sdk";

import { assembleContext, materializeContext } from "../src/context.js";

function result(overrides: Partial<SelectionResult> = {}): SelectionResult {
  return {
    applied: false,
    reason: "timeout",
    requestId: "req_test",
    operatingPoint: "np-2026-08-r3",
    shadow: false,
    response: null,
    error: null,
    clientLatencyMs: 12,
    attempts: 1,
    requestBytes: 128,
    ...overrides,
  };
}

function response(outcome: string | null, renderedContext = "selected evidence") {
  return {
    requestId: "req_test",
    renderedContext,
    policyVersion: "np-2026-08-r3",
    selected: [],
    tokensBefore: 1000,
    tokensAfter: 300,
    tokensSaved: 700,
    recordsAvailable: 2,
    recordsSelected: 1,
    fallbackUsed: false,
    selectionError: null,
    engineLatencyMs: 9,
    budgetTokens: 4096,
    attemptedBudgetTokens: [4096],
    reductionRatio: 0.7,
    safety: null,
    gate: null,
    formatMetrics: {},
    outcome,
    taskKind: null,
    selectionTrace: null,
    selectionId: "sel_test",
    extra: {},
  };
}

test("select applies recognized SDK context while preserving task and mandatory policy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "needlepath-action-"));
  const assembled = assembleContext({
    query: "Review this change",
    mandatory: [{ title: "Repository policy", text: "Never expose credentials." }],
    candidates: [
      { id: "diff-1", kind: "external_data", title: "Diff", text: "large diff" },
    ],
  });

  const receipt = await materializeContext({
    assembled,
    result: result({ applied: true, reason: "ok", response: response("engaged") }),
    mode: "select",
    outputDirectory: directory,
  });

  const output = await readFile(receipt.contextPath, "utf8");
  assert.match(output, /Review this change/);
  assert.match(output, /Never expose credentials/);
  assert.match(output, /selected evidence/);
  assert.doesNotMatch(output, /large diff/);
  assert.equal(receipt.applied, true);
});

test("shadow returns the exact original bytes even when the service would engage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "needlepath-action-"));
  const assembled = assembleContext({
    query: "Diagnose CI",
    mandatory: [],
    candidates: [{ id: "log-1", text: "\u0000raw\r\nlog", kind: "tool_result" }],
  });

  const receipt = await materializeContext({
    assembled,
    result: result({ reason: "shadow", shadow: true, response: response("engaged") }),
    mode: "shadow",
    outputDirectory: directory,
  });

  assert.deepEqual(
    await readFile(receipt.contextPath),
    await readFile(receipt.originalContextPath),
  );
  assert.deepEqual(await readFile(receipt.contextPath), assembled.originalBytes);
  assert.equal(receipt.applied, false);
});

test("every non-applied path fails open byte-identically", async () => {
  const reasons = [
    "stood_down",
    "selection_unsafe",
    "empty_selection",
    "timeout",
    "transport_error",
    "http_error",
    "contract_error",
    "future_reason",
  ];
  for (const reason of reasons) {
    const directory = await mkdtemp(join(tmpdir(), "needlepath-action-"));
    const assembled = assembleContext({
      query: "Task",
      mandatory: [],
      candidates: [{ id: "record", text: `evidence-${reason}` }],
    });
    const receipt = await materializeContext({
      assembled,
      result: result({ reason }),
      mode: "select",
      outputDirectory: directory,
    });

    assert.deepEqual(await readFile(receipt.contextPath), assembled.originalBytes);
  }
});

test("an unknown future service outcome fails open even if an older SDK marks it applied", async () => {
  const directory = await mkdtemp(join(tmpdir(), "needlepath-action-"));
  const assembled = assembleContext({
    query: "Task",
    mandatory: [],
    candidates: [{ id: "record", text: "original evidence" }],
  });
  const receipt = await materializeContext({
    assembled,
    result: result({
      applied: true,
      reason: "ok",
      response: response("future_server_outcome", "unknown selection"),
    }),
    mode: "select",
    outputDirectory: directory,
  });

  assert.equal(receipt.applied, false);
  assert.equal(receipt.failOpen, true);
  assert.deepEqual(await readFile(receipt.contextPath), assembled.originalBytes);
});

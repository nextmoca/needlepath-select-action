import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NeedlepathClient, type FetchLike } from "@nextmoca/needlepath-sdk";

import { parseConfig } from "../src/config.js";
import { runSelection } from "../src/workflow.js";

test("real SDK request excludes mandatory policy and applies selected evidence", async () => {
  let wire: Record<string, unknown> | null = null;
  const fetch: FetchLike = async (_url, init) => {
    wire = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
    const requestId = String(wire.request_id);
    return new Response(
      JSON.stringify({
        request_id: requestId,
        rendered_context: "selected failing test evidence",
        policy_version: "np-2026-08-r3",
        outcome: "engaged",
        selected: [
          {
            record_id: "log-1",
            kind: "tool_result",
            title: "Failed tests",
            source: "github",
            score: 0.99,
            reason: "selected",
            excerpt: "selected failing test evidence",
            excerpt_format: "text",
            selected_tokens: 6,
          },
        ],
        tokens_before: 900,
        tokens_after: 200,
        tokens_saved: 700,
        records_available: 2,
        records_selected: 1,
        fallback_used: false,
        selection_error: null,
        engine_latency_ms: 7,
        budget_tokens: 4096,
        attempted_budget_tokens: [4096],
        reduction_ratio: 0.777,
        safety: {
          selection_safe: true,
          fallback_required: false,
          fallback_reason: "",
          coverage_score: 1,
          evidence_shape: "open",
          evidence_terms: null,
          repair_reasons: [],
        },
        gate: null,
        format_metrics: {},
        task_kind: "diagnostics",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const client = new NeedlepathClient({
    apiKey: "np_live_test",
    operatingPoint: "np-2026-08-r3",
    baseUrl: "http://127.0.0.1:8787",
    fetch,
    maxRetries: 0,
  });
  const outputDirectory = await mkdtemp(join(tmpdir(), "needlepath-action-"));
  const config = parseConfig(
    { "workflow-type": "ci-diagnosis", mode: "select" },
    { NEEDLEPATH_API_KEY: "np_live_test" },
  );

  const receipt = await runSelection({
    config,
    collected: {
      query: "Diagnose CI",
      mandatory: [{ title: "Security policy", text: "Do not expose secrets." }],
      candidates: [
        { id: "log-1", kind: "tool_result", text: "failing test evidence" },
        { id: "log-2", kind: "tool_result", text: "irrelevant passing log" },
      ],
      omissions: {
        binaryOrUnavailablePatch: 0,
        truncatedRecords: 0,
        recordLimit: 0,
        unavailableSources: 0,
      },
    },
    client,
    outputDirectory,
  });

  const sentRecords =
    ((wire as Record<string, unknown> | null)?.records ?? []) as Array<{ text: string }>;
  assert.equal(sentRecords.length, 2);
  assert.equal(sentRecords.some((record) => record.text.includes("Do not expose")), false);
  const output = await readFile(receipt.contextPath, "utf8");
  assert.match(output, /Do not expose secrets/);
  assert.match(output, /selected failing test evidence/);
  assert.equal(receipt.applied, true);
  assert.equal(receipt.tokensSaved, 700);
});

test("disabled mode does not call Needlepath and still materializes original context", async () => {
  let calls = 0;
  const client = {
    async select() {
      calls += 1;
      throw new Error("must not be called");
    },
  };
  const outputDirectory = await mkdtemp(join(tmpdir(), "needlepath-action-"));
  const config = parseConfig(
    { "workflow-type": "pr-review", enabled: "false" },
    {},
  );

  const receipt = await runSelection({
    config,
    collected: {
      query: "Review PR",
      mandatory: [],
      candidates: [{ id: "diff", text: "original diff" }],
      omissions: {
        binaryOrUnavailablePatch: 0,
        truncatedRecords: 0,
        recordLimit: 0,
        unavailableSources: 0,
      },
    },
    client,
    outputDirectory,
  });

  assert.equal(calls, 0);
  assert.equal(receipt.reason, "disabled");
  assert.deepEqual(
    await readFile(receipt.contextPath),
    await readFile(receipt.originalContextPath),
  );
});

test("the exact original file exists before the Needlepath request starts", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "needlepath-action-"));
  let captured = false;
  const client = {
    async select() {
      captured = (await readFile(join(outputDirectory, "original-context.txt"), "utf8")).includes(
        "original diff",
      );
      return {
        applied: false,
        reason: "timeout",
        requestId: "req_timeout",
        operatingPoint: "np-2026-08-r3",
        shadow: false,
        response: null,
        error: null,
        clientLatencyMs: 100,
        attempts: 1,
        requestBytes: 10,
      };
    },
  };
  const config = parseConfig(
    { "workflow-type": "pr-review", mode: "select" },
    {},
  );

  await runSelection({
    config,
    collected: {
      query: "Review PR",
      mandatory: [],
      candidates: [{ id: "diff", text: "original diff" }],
      omissions: {
        binaryOrUnavailablePatch: 0,
        truncatedRecords: 0,
        recordLimit: 0,
        unavailableSources: 0,
      },
    },
    client,
    outputDirectory,
  });

  assert.equal(captured, true);
});

test("an unexpected client rejection still fails open to exact original bytes", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "needlepath-action-"));
  const config = parseConfig(
    { "workflow-type": "ci-diagnosis", mode: "select" },
    {},
  );
  const receipt = await runSelection({
    config,
    collected: {
      query: "Diagnose",
      mandatory: [],
      candidates: [{ id: "log", text: "original log" }],
      omissions: {
        binaryOrUnavailablePatch: 0,
        truncatedRecords: 0,
        recordLimit: 0,
        unavailableSources: 0,
      },
    },
    client: { select: async () => Promise.reject(new Error("raw secret context")) },
    outputDirectory,
  });

  assert.equal(receipt.reason, "unexpected_error");
  assert.deepEqual(
    await readFile(receipt.contextPath),
    await readFile(receipt.originalContextPath),
  );
});

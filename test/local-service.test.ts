import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NeedlepathClient } from "@nextmoca/needlepath-sdk";

import { parseConfig } from "../src/config.js";
import { runSelection } from "../src/workflow.js";

test("action integrates with a real loopback HTTP Needlepath service", async () => {
  let requestBody = "";
  let apiKey = "";
  const server = createServer((request, response) => {
    apiKey = String(request.headers["x-api-key"] ?? request.headers.authorization ?? "");
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      requestBody += chunk;
    });
    request.on("end", () => {
      const parsed = JSON.parse(requestBody) as { request_id: string };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          request_id: parsed.request_id,
          rendered_context: "selected loopback evidence",
          policy_version: "np-2026-08-r3",
          outcome: "engaged",
          selected: [
            {
              record_id: "record-1",
              kind: "tool_result",
              title: "Relevant failure",
              source: "test",
              score: 0.99,
              reason: "selected",
              excerpt: "selected loopback evidence",
              excerpt_format: "text",
              selected_tokens: 4,
            },
          ],
          tokens_before: 100,
          tokens_after: 25,
          tokens_saved: 75,
          records_available: 1,
          records_selected: 1,
          fallback_used: false,
          selection_error: null,
          engine_latency_ms: 2.5,
          budget_tokens: 4096,
          attempted_budget_tokens: [4096],
          reduction_ratio: 0.75,
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
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const client = new NeedlepathClient({
      apiKey: "np_test_loopback",
      baseUrl,
      operatingPoint: "np-2026-08-r3",
      maxRetries: 0,
    });
    const outputDirectory = await mkdtemp(join(tmpdir(), "needlepath-http-"));
    const receipt = await runSelection({
      config: parseConfig(
        {
          "workflow-type": "ci-diagnosis",
          mode: "select",
          endpoint: baseUrl,
        },
        { NEEDLEPATH_API_KEY: "np_test_loopback" },
      ),
      collected: {
        query: "Diagnose the failed test",
        mandatory: [],
        candidates: [{ id: "record-1", kind: "tool_result", text: "failure details" }],
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

    assert.match(apiKey, /np_test_loopback/);
    assert.match(requestBody, /Diagnose the failed test/);
    assert.equal(receipt.applied, true);
    assert.equal(receipt.tokensSaved, 75);
    assert.match(await readFile(receipt.contextPath, "utf8"), /selected loopback evidence/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import { renderJobSummary } from "../src/summary.js";

test("job summary is metadata-only and labels token values as estimates", () => {
  const summary = renderJobSummary({
    workflowType: "pr-review",
    mode: "shadow",
    applied: false,
    failOpen: false,
    outcome: "engaged",
    reason: "shadow",
    tokensBefore: 10_000,
    tokensAfter: 4_000,
    tokensSaved: 6_000,
    reductionPercent: 60,
    selectionLatencyMs: 11.2,
    requestId: "req_public",
    operatingPoint: "np-2026-08-r3",
    endpointClass: "hosted",
    downstreamContext: "original",
    mandatoryRecords: 2,
    selectableRecords: 8,
    omittedRecords: 1,
  });

  assert.match(summary, /Needlepath service estimate/i);
  assert.match(summary, /validate matched outcomes.*select/i);
  assert.match(summary, /req_public/);
  assert.doesNotMatch(summary, /candidate source text|np_live_|api\.nextmoca\.com/i);
});

test("fail-open summary explains exact original context and a concrete next action", () => {
  const summary = renderJobSummary({
    workflowType: "ci-diagnosis",
    mode: "select",
    applied: false,
    failOpen: true,
    outcome: "unavailable",
    reason: "timeout",
    tokensBefore: 0,
    tokensAfter: 0,
    tokensSaved: 0,
    reductionPercent: 0,
    selectionLatencyMs: 1500,
    requestId: "req_timeout",
    operatingPoint: "np-2026-08-r3",
    endpointClass: "private",
    downstreamContext: "original",
    mandatoryRecords: 1,
    selectableRecords: 20,
    omittedRecords: 0,
  });

  assert.match(summary, /exact original eligible context/i);
  assert.match(summary, /troubleshoot/i);
  assert.doesNotMatch(summary, /https?:\/\//i);
});

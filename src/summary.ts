import type { SummaryData } from "./types.js";

export function renderJobSummary(data: SummaryData): string {
  const disposition = data.reason === "configuration_error"
    ? "Configuration fallback; original context preserved"
    : data.applied
      ? "Applied selected context"
      : data.failOpen
        ? "Fail-open to original context"
        : data.mode === "shadow"
          ? "Shadow evaluation; original context preserved"
          : "Stood down; original context preserved";
  const nextAction = recommendation(data);
  return [
    "## Needlepath context decision",
    "",
    `**${disposition}.**`,
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Workflow | ${escapeCell(data.workflowType)} |`,
    `| Mode | ${escapeCell(data.mode)} |`,
    `| Outcome | ${escapeCell(data.outcome)} |`,
    `| Reason | ${escapeCell(data.reason)} |`,
    `| Downstream context | ${escapeCell(data.downstreamContext)} |`,
    `| Needlepath service estimate before | ${formatInteger(data.tokensBefore)} tokens |`,
    `| Needlepath service estimate after | ${formatInteger(data.tokensAfter)} tokens |`,
    `| Needlepath estimated reduction | ${formatNumber(data.reductionPercent)}% (${formatInteger(data.tokensSaved)} tokens) |`,
    `| Selection latency | ${formatNumber(data.selectionLatencyMs)} ms |`,
    `| Operating point | ${escapeCell(data.operatingPoint)} |`,
    `| Request ID | ${escapeCell(data.requestId || "not-issued")} |`,
    `| Endpoint class | ${escapeCell(data.endpointClass)} |`,
    `| Mandatory/selectable records | ${data.mandatoryRecords}/${data.selectableRecords} |`,
    `| Collector omissions | ${data.omittedRecords} |`,
    "",
    "> Token values are Needlepath service estimates, not provider-billed usage or invoice savings.",
    "",
    `**Next action:** ${nextAction}`,
    "",
  ].join("\n");
}

function recommendation(data: SummaryData): string {
  if (data.reason === "configuration_error") {
    return "Correct the action configuration before evaluating or applying Needlepath selection.";
  }
  if (data.failOpen) {
    return "The downstream job is using the exact original eligible context. Troubleshoot authentication, endpoint availability, or the public reason code before retrying live selection.";
  }
  if (data.mode === "shadow" && data.outcome === "engaged" && data.tokensSaved > 0) {
    return "Validate matched outcomes downstream, then change only `mode` from `shadow` to `select` to apply the same decision path.";
  }
  if (data.mode === "shadow") {
    return "No live change is recommended for this run; keep evaluating representative context-heavy workloads.";
  }
  if (data.applied) {
    return "The downstream agent receives selected context. Record provider usage separately if exact billed-token economics are required.";
  }
  return "The downstream agent receives original context; no integration change is required.";
}

function escapeCell(value: string): string {
  return value.replace(/[\r\n|]/g, " ").slice(0, 200);
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}

function formatInteger(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "0";
}

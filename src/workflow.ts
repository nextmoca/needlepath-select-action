import type { ContextRecord, SelectOptions, SelectionResult } from "@nextmoca/needlepath-sdk";

import type { ActionConfig } from "./config.js";
import { assembleContext, captureOriginalContext, materializeContext } from "./context.js";
import type { CollectedContext, ExecutionReceipt } from "./types.js";

export interface SelectionClient {
  select(options: SelectOptions): Promise<SelectionResult>;
}

export async function runSelection(input: {
  config: ActionConfig;
  collected: CollectedContext;
  client: SelectionClient;
  outputDirectory: string;
}): Promise<ExecutionReceipt> {
  const assembled = assembleContext(input.collected);
  await captureOriginalContext(assembled, input.outputDirectory);
  let result: SelectionResult;
  if (!input.config.enabled) {
    result = disabledResult(input.config.operatingPoint, input.config.mode === "shadow");
  } else {
    const initialTokens = Math.min(4096, input.config.maxContextTokens);
    const escalationTokens =
      input.config.maxContextTokens > initialTokens
        ? [input.config.maxContextTokens]
        : [];
    try {
      result = await input.client.select({
        records: input.collected.candidates as ContextRecord[],
        task: { prompt: input.collected.query },
        maxContextTokens: input.config.maxContextTokens,
        capacityCapTokens: input.config.capacityCapTokens,
        shadow: input.config.mode === "shadow",
        requirePerRecord: true,
        maxRecords: input.config.maxRecords,
        mode: "adaptive",
        adaptive: {
          initialTokens,
          escalationTokens,
          allowFullContextFallback: true,
        },
        requireEvidenceCoverage: true,
        render: true,
        renderFormat: "hybrid",
        returnPerRecord: true,
        timeoutMs: input.config.timeoutMs,
      });
    } catch (error) {
      result = unexpectedResult(input.config.operatingPoint, input.config.mode === "shadow", error);
    }
  }
  return materializeContext({
    assembled,
    result,
    mode: input.config.mode,
    outputDirectory: input.outputDirectory,
  });
}

function unexpectedResult(
  operatingPoint: string,
  shadow: boolean,
  error: unknown,
): SelectionResult {
  return {
    applied: false,
    reason: "unexpected_error",
    requestId: "",
    operatingPoint,
    shadow,
    response: null,
    error,
    clientLatencyMs: 0,
    attempts: 0,
    requestBytes: 0,
  };
}

function disabledResult(operatingPoint: string, shadow: boolean): SelectionResult {
  return {
    applied: false,
    reason: "disabled",
    requestId: "",
    operatingPoint,
    shadow,
    response: null,
    error: null,
    clientLatencyMs: 0,
    attempts: 0,
    requestBytes: 0,
  };
}

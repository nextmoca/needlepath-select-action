import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ContextRecord, SelectionResult } from "@nextmoca/needlepath-sdk";

import type { ActionMode, ExecutionReceipt, MandatorySection } from "./types.js";

const KNOWN_OUTCOMES = new Set(["engaged", "stood_down", "escalated"]);

export interface AssembledContext {
  query: string;
  mandatory: MandatorySection[];
  candidates: ContextRecord[];
  mandatoryPrefix: string;
  originalBytes: Buffer;
}

export function assembleContext(input: {
  query: string;
  mandatory: MandatorySection[];
  candidates: ContextRecord[];
}): AssembledContext {
  const mandatoryPrefix = [
    renderSection("Task", input.query),
    ...input.mandatory.map((section) => renderSection(section.title, section.text)),
  ].join("\n");
  const candidateText = input.candidates.map(renderRecord).join("\n");
  const original = [mandatoryPrefix, candidateText].filter(Boolean).join("\n");
  return {
    ...input,
    mandatoryPrefix,
    originalBytes: Buffer.from(original, "utf8"),
  };
}

export async function materializeContext(input: {
  assembled: AssembledContext;
  result: SelectionResult;
  mode: ActionMode;
  outputDirectory: string;
}): Promise<ExecutionReceipt> {
  const { originalContextPath, contextPath } = await captureOriginalContext(
    input.assembled,
    input.outputDirectory,
  );

  const response = input.result.response;
  const responseOutcome = readOutcome(response);
  const recognizedOutcome = responseOutcome === null || KNOWN_OUTCOMES.has(responseOutcome);
  const canApply = Boolean(
    input.mode === "select" &&
      input.result.applied &&
      input.result.reason === "ok" &&
      response &&
      recognizedOutcome &&
      (responseOutcome === null || responseOutcome === "engaged") &&
      response.renderedContext,
  );

  if (canApply && response) {
    const selected = [
      input.assembled.mandatoryPrefix,
      response.renderedContext,
    ].filter(Boolean).join("\n");
    await writeFile(contextPath, selected, { encoding: "utf8", mode: 0o600 });
  } else {
    await copyFile(originalContextPath, contextPath);
  }

  const tokensBefore = response?.tokensBefore ?? 0;
  const tokensAfter = response?.tokensAfter ?? 0;
  const tokensSaved = response?.tokensSaved ?? 0;
  const outcome = responseOutcome ?? (canApply ? "engaged" : "unavailable");
  return {
    contextPath,
    originalContextPath,
    applied: canApply,
    failOpen: input.mode === "select" && !canApply,
    outcome,
    reason: !recognizedOutcome ? "unknown_outcome" : input.result.reason,
    tokensBefore,
    tokensAfter,
    tokensSaved,
    reductionPercent: tokensBefore > 0 ? (tokensSaved / tokensBefore) * 100 : 0,
    selectionLatencyMs: response?.engineLatencyMs ?? input.result.clientLatencyMs,
    requestId: input.result.requestId,
    operatingPoint: input.result.operatingPoint,
    downstreamContext: canApply ? "selected" : "original",
  };
}

export async function materializeOriginalContext(input: {
  assembled: AssembledContext;
  outputDirectory: string;
  reason: string;
  operatingPoint: string;
  failOpen: boolean;
}): Promise<ExecutionReceipt> {
  const { originalContextPath, contextPath } = await captureOriginalContext(
    input.assembled,
    input.outputDirectory,
  );
  await copyFile(originalContextPath, contextPath);
  return {
    contextPath,
    originalContextPath,
    applied: false,
    failOpen: input.failOpen,
    outcome: "unavailable",
    reason: input.reason,
    tokensBefore: 0,
    tokensAfter: 0,
    tokensSaved: 0,
    reductionPercent: 0,
    selectionLatencyMs: 0,
    requestId: "",
    operatingPoint: input.operatingPoint,
    downstreamContext: "original",
  };
}

function readOutcome(response: SelectionResult["response"]): string | null {
  if (!response) return null;
  const direct = (response as unknown as { outcome?: unknown }).outcome;
  if (typeof direct === "string") return direct;
  const fromExtra = response.extra?.outcome;
  return typeof fromExtra === "string" ? fromExtra : null;
}

export async function captureOriginalContext(
  assembled: AssembledContext,
  outputDirectory: string,
): Promise<{ originalContextPath: string; contextPath: string }> {
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const originalContextPath = join(outputDirectory, "original-context.txt");
  const contextPath = join(outputDirectory, "context.txt");
  await writeFile(originalContextPath, assembled.originalBytes, { mode: 0o600 });
  return { originalContextPath, contextPath };
}

function renderSection(title: string, text: string): string {
  return `## ${normalizeTitle(title)}\n${text}`;
}

function renderRecord(record: ContextRecord): string {
  const title = record.title || record.id || "Context record";
  return renderSection(title, record.text);
}

function normalizeTitle(value: string): string {
  return value.replace(/[\r\n\u0000-\u001f\u007f]+/g, " ").trim() || "Context";
}

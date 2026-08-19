import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  NeedlepathClient,
  type NeedlepathClientOptions,
} from "@nextmoca/needlepath-sdk";

import { collectSnapshot } from "./collectors.js";
import { ConfigError, parseConfig, parseFailOpenConfig } from "./config.js";
import { assembleContext, materializeOriginalContext } from "./context.js";
import { GithubApi, loadGithubSnapshot } from "./github.js";
import { loadLocalContext } from "./input.js";
import { InputPathError } from "./paths.js";
import { renderJobSummary } from "./summary.js";
import type {
  CollectedContext,
  CollectorSnapshot,
  ExecutionReceipt,
  OmissionCounts,
  SummaryData,
} from "./types.js";
import { runSelection } from "./workflow.js";

const INPUT_NAMES = [
  "workflow-type",
  "enabled",
  "query",
  "task-path",
  "context-path",
  "records-path",
  "mandatory-context-path",
  "required-paths",
  "required-record-ids",
  "log-paths",
  "mode",
  "operating-point",
  "endpoint",
  "max-context-tokens",
  "capacity-cap-tokens",
  "max-records",
  "max-record-bytes",
  "timeout-ms",
  "base-ref",
  "head-ref",
  "github-run-id",
] as const;
const MAX_EVENT_BYTES = 5_000_000;

export interface ActionCore {
  getInput(name: string): string;
  setOutput(name: string, value: string): void;
  setSecret(value: string): void;
  addSummary(markdown: string): Promise<void>;
  warning(message: string): void;
  setFailed(message: string): void;
}

export interface RunActionDependencies {
  core: ActionCore;
  env?: NodeJS.ProcessEnv;
  clientFactory?: (options: NeedlepathClientOptions) => NeedlepathClient;
  githubApiFactory?: (options: ConstructorParameters<typeof GithubApi>[0]) => GithubApi;
}

export async function runAction(dependencies: RunActionDependencies): Promise<ExecutionReceipt | null> {
  const { core } = dependencies;
  const env = dependencies.env ?? process.env;
  const inputs = Object.fromEntries(INPUT_NAMES.map((name) => [name, core.getInput(name)]));
  let config;
  let configurationError: unknown = null;
  try {
    config = parseConfig(inputs, env);
  } catch (error) {
    configurationError = error;
    try {
      config = parseFailOpenConfig(inputs, env);
    } catch {
      core.setFailed(safeConfigurationMessage(error));
      return null;
    }
  }

  const apiKey = env.NEEDLEPATH_API_KEY?.trim() ?? "";
  const githubToken = env.GITHUB_TOKEN?.trim() ?? "";
  if (apiKey) core.setSecret(apiKey);
  if (githubToken) core.setSecret(githubToken);

  const workspace = env.GITHUB_WORKSPACE?.trim() || process.cwd();
  const outputRoot = env.RUNNER_TEMP?.trim() || tmpdir();
  try {
    const local = await loadLocalContext(config, workspace);
    const event = await readEvent(env.GITHUB_EVENT_PATH);
    let collected = local;
    if (config.workflowType !== "custom") {
      let snapshot: CollectorSnapshot = {};
      const repository = env.GITHUB_REPOSITORY?.trim() ?? "";
      if (githubToken && repository) {
        const makeApi = dependencies.githubApiFactory ?? ((options) => new GithubApi(options));
        try {
          const apiOptions: ConstructorParameters<typeof GithubApi>[0] = {
            repository,
            token: githubToken,
          };
          if (env.GITHUB_API_URL) apiOptions.baseUrl = env.GITHUB_API_URL;
          const api = makeApi(apiOptions);
          snapshot = await loadGithubSnapshot(config, event, repository, api);
        } catch {
          core.warning(
            "Needlepath GitHub collection was unavailable; continuing with local and event-safe context.",
          );
        }
      } else {
        core.warning(
          "GitHub token or repository identity is unavailable; continuing safely without remote repository evidence.",
        );
      }
      const remote = collectSnapshot(config.workflowType, snapshot, {
        query: local.query,
        mandatory: [],
        maxRecordBytes: config.maxRecordBytes,
        maxRecords: config.maxRecords,
      });
      collected = mergeCollected(local, remote, config.maxRecords);
    }

    const outputDirectory = join(outputRoot, "needlepath", randomUUID());
    let receipt: ExecutionReceipt;
    if (configurationError) {
      core.warning(
        `${safeConfigurationMessage(configurationError)} Original context was preserved without calling Needlepath.`,
      );
      receipt = await materializeOriginalContext({
        assembled: assembleContext(collected),
        outputDirectory,
        reason: "configuration_error",
        operatingPoint: config.operatingPoint,
        failOpen: config.mode === "select",
      });
    } else {
      const makeClient = dependencies.clientFactory ?? ((options) => new NeedlepathClient(options));
      const client = makeClient({
        apiKey,
        operatingPoint: config.operatingPoint,
        baseUrl: config.baseUrl,
        timeoutMs: config.timeoutMs,
        maxRetries: 0,
        shadow: false,
        userAgentSuffix: "needlepath-github-action/0.1.0",
      });
      receipt = await runSelection({
        config,
        collected,
        client,
        outputDirectory,
      });
    }
    const omittedRecords = Object.values(collected.omissions).reduce((sum, value) => sum + value, 0);
    const summary: SummaryData = {
      ...receipt,
      workflowType: config.workflowType,
      mode: config.mode,
      endpointClass: endpointClass(config.baseUrl),
      mandatoryRecords: collected.mandatory.length + 1,
      selectableRecords: collected.candidates.length,
      omittedRecords,
    };
    const metricsPath = join(outputDirectory, "metrics.json");
    await writeMetrics(metricsPath, summary);
    publishOutputs(core, receipt, metricsPath);
    await core.addSummary(renderJobSummary(summary));
    return receipt;
  } catch (error) {
    core.setFailed(safePreparationMessage(error));
    return null;
  }
}

function publishOutputs(core: ActionCore, receipt: ExecutionReceipt, metricsPath: string): void {
  const outputs: Record<string, string> = {
    "context-path": receipt.contextPath,
    "original-context-path": receipt.originalContextPath,
    "metrics-path": metricsPath,
    applied: String(receipt.applied),
    outcome: receipt.outcome,
    reason: receipt.reason,
    "tokens-before": String(receipt.tokensBefore),
    "tokens-after": String(receipt.tokensAfter),
    "estimated-tokens-saved": String(receipt.tokensSaved),
    "estimated-reduction-percent": receipt.reductionPercent.toFixed(2),
    "selection-latency-ms": receipt.selectionLatencyMs.toFixed(3),
    "request-id": receipt.requestId,
    "operating-point": receipt.operatingPoint,
    "fail-open": String(receipt.failOpen),
    "downstream-context": receipt.downstreamContext,
  };
  for (const [name, value] of Object.entries(outputs)) core.setOutput(name, value);
}

async function writeMetrics(path: string, data: SummaryData): Promise<void> {
  const metrics = {
    schema_version: "1",
    workflow_type: data.workflowType,
    mode: data.mode,
    applied: data.applied,
    fail_open: data.failOpen,
    outcome: data.outcome,
    reason: data.reason,
    tokens_before: data.tokensBefore,
    tokens_after: data.tokensAfter,
    tokens_saved: data.tokensSaved,
    estimated_reduction_percent: data.reductionPercent,
    selection_latency_ms: data.selectionLatencyMs,
    request_id: data.requestId,
    operating_point: data.operatingPoint,
    endpoint_class: data.endpointClass,
    downstream_context: data.downstreamContext,
    mandatory_records: data.mandatoryRecords,
    selectable_records: data.selectableRecords,
    omitted_records: data.omittedRecords,
  };
  await writeFile(path, `${JSON.stringify(metrics, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function mergeCollected(
  local: CollectedContext,
  remote: CollectedContext,
  maxRecords: number,
): CollectedContext {
  const candidates = [...remote.candidates, ...local.candidates];
  const omissions = addOmissions(local.omissions, remote.omissions);
  if (candidates.length > maxRecords) {
    omissions.recordLimit += candidates.length - maxRecords;
    candidates.length = maxRecords;
  }
  return {
    query: local.query,
    mandatory: [...local.mandatory, ...remote.mandatory],
    candidates,
    omissions,
  };
}

function addOmissions(left: OmissionCounts, right: OmissionCounts): OmissionCounts {
  return {
    binaryOrUnavailablePatch:
      left.binaryOrUnavailablePatch + right.binaryOrUnavailablePatch,
    truncatedRecords: left.truncatedRecords + right.truncatedRecords,
    recordLimit: left.recordLimit + right.recordLimit,
    unavailableSources: left.unavailableSources + right.unavailableSources,
  };
}

async function readEvent(path: string | undefined): Promise<Record<string, unknown>> {
  if (!path) return {};
  try {
    const bytes = await readFile(path);
    if (bytes.length > MAX_EVENT_BYTES) return {};
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function endpointClass(value: string): "hosted" | "local" | "private" {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    if (["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(hostname)) return "local";
    if (hostname === "api.nextmoca.com" || hostname.endsWith(".nextmoca.com")) return "hosted";
  } catch {
    return "private";
  }
  return "private";
}

function safeConfigurationMessage(error: unknown): string {
  if (error instanceof ConfigError) return `Needlepath Action configuration: ${error.message}`;
  return "Needlepath Action configuration is invalid. Review action inputs and immutable operating-point syntax.";
}

function safePreparationMessage(error: unknown): string {
  if (error instanceof InputPathError || error instanceof ConfigError) {
    return `Needlepath Action could not prepare context: ${error.message}`;
  }
  const message = error instanceof Error ? error.message : "";
  if (/^(records-path|context-path|task-path|mandatory-context-path|required-paths|log-paths)/.test(message)) {
    return `Needlepath Action could not prepare context: ${message}`;
  }
  return "Needlepath Action could not prepare context. Check configured paths, UTF-8 input, and endpoint syntax.";
}

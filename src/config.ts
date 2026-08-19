import type { ActionMode, WorkflowType } from "./types.js";

const WORKFLOW_TYPES = new Set<WorkflowType>([
  "custom",
  "pr-review",
  "ci-diagnosis",
  "release-notes",
]);
const MODES = new Set<ActionMode>(["shadow", "select"]);
const DEFAULT_QUERIES: Record<Exclude<WorkflowType, "custom">, string> = {
  "pr-review": "Review this pull request for correctness, regressions, security, and missing tests.",
  "ci-diagnosis": "Diagnose the failed CI run and identify the smallest safe repair.",
  "release-notes": "Prepare accurate release notes from the supplied release evidence.",
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface ActionConfig {
  workflowType: WorkflowType;
  mode: ActionMode;
  enabled: boolean;
  query: string;
  taskPath: string | null;
  contextPath: string | null;
  recordsPath: string | null;
  mandatoryContextPath: string | null;
  requiredPaths: string[];
  requiredRecordIds: string[];
  logPaths: string[];
  baseRef: string | null;
  headRef: string | null;
  githubRunId: number | null;
  operatingPoint: string;
  baseUrl: string;
  hasNeedlepathApiKey: boolean;
  maxContextTokens: number;
  capacityCapTokens: number | null;
  maxRecords: number;
  maxRecordBytes: number;
  timeoutMs: number;
  outputDirectory: string | null;
}

type InputMap = Readonly<Record<string, string | undefined>>;
type Environment = Readonly<Record<string, string | undefined>>;

export function parseConfig(input: InputMap, env: Environment): ActionConfig {
  const workflowType = (trim(input["workflow-type"]) || "custom") as WorkflowType;
  if (!WORKFLOW_TYPES.has(workflowType)) {
    throw new ConfigError(`workflow-type must be one of: ${[...WORKFLOW_TYPES].join(", ")}`);
  }
  const mode = (trim(input.mode) || "shadow") as ActionMode;
  if (!MODES.has(mode)) throw new ConfigError("mode must be shadow or select");
  const enabled = parseBoolean(input.enabled, true, "enabled");

  const taskPath = nullable(input["task-path"]);
  const contextPath = nullable(input["context-path"]);
  const recordsPath = nullable(input["records-path"]);
  if (contextPath && recordsPath) {
    throw new ConfigError("pass exactly one of context-path or records-path");
  }
  let query = trim(input.query);
  if (query && taskPath) throw new ConfigError("pass query or task-path, not both");
  if (!query && !taskPath && workflowType === "custom") {
    throw new ConfigError("custom workflow-type requires query or task-path");
  }
  if (workflowType === "custom" && !contextPath && !recordsPath) {
    throw new ConfigError("custom workflow-type requires exactly one context source");
  }
  if (!query && !taskPath && workflowType !== "custom") {
    query = DEFAULT_QUERIES[workflowType];
  }

  const operatingPoint = trim(input["operating-point"]) || "np-2026-08-r3";
  if (!/^np-\d{4}-\d{2}-r\d+$/.test(operatingPoint)) {
    throw new ConfigError("operating-point must be an immutable np-YYYY-MM-rN label");
  }

  const githubRunIdRaw = trim(input["github-run-id"]);
  const capacityRaw = trim(input["capacity-cap-tokens"]);
  return {
    workflowType,
    mode,
    enabled,
    query,
    taskPath,
    contextPath,
    recordsPath,
    mandatoryContextPath: nullable(input["mandatory-context-path"]),
    requiredPaths: parseList(input["required-paths"]),
    requiredRecordIds: parseList(input["required-record-ids"]),
    logPaths: parseList(input["log-paths"]),
    baseRef: nullable(input["base-ref"]),
    headRef: nullable(input["head-ref"]),
    githubRunId: githubRunIdRaw ? positiveInteger(githubRunIdRaw, "github-run-id") : null,
    operatingPoint,
    baseUrl: trim(input.endpoint) || trim(env.NEEDLEPATH_BASE_URL) || "https://api.nextmoca.com",
    hasNeedlepathApiKey: Boolean(trim(env.NEEDLEPATH_API_KEY)),
    maxContextTokens: positiveInteger(
      trim(input["max-context-tokens"]) || "8000",
      "max-context-tokens",
    ),
    capacityCapTokens: capacityRaw
      ? positiveInteger(capacityRaw, "capacity-cap-tokens")
      : null,
    maxRecords: boundedInteger(
      trim(input["max-records"]) || "200",
      "max-records",
      1,
      1000,
    ),
    maxRecordBytes: boundedInteger(
      trim(input["max-record-bytes"]) || "200000",
      "max-record-bytes",
      256,
      1_000_000,
    ),
    timeoutMs: boundedInteger(
      trim(input["timeout-ms"]) || "10000",
      "timeout-ms",
      1,
      60_000,
    ),
    outputDirectory: nullable(input["output-directory"]),
  };
}

export function parseFailOpenConfig(input: InputMap, env: Environment): ActionConfig {
  const requestedMode = trim(input.mode) as ActionMode;
  const recovered: Record<string, string | undefined> = {
    ...input,
    enabled: "false",
    mode: MODES.has(requestedMode) ? requestedMode : "select",
  };
  if (!/^np-\d{4}-\d{2}-r\d+$/.test(trim(input["operating-point"]))) {
    recovered["operating-point"] = "np-2026-08-r3";
  }
  recoverBoundedInteger(recovered, input, "max-context-tokens", "8000", 1, Number.MAX_SAFE_INTEGER);
  recoverBoundedInteger(recovered, input, "max-records", "200", 1, 1000);
  recoverBoundedInteger(recovered, input, "max-record-bytes", "200000", 256, 1_000_000);
  recoverBoundedInteger(recovered, input, "timeout-ms", "10000", 1, 60_000);
  recoverOptionalPositiveInteger(recovered, input, "capacity-cap-tokens");
  recoverOptionalPositiveInteger(recovered, input, "github-run-id");
  return parseConfig(recovered, env);
}

function trim(value: string | undefined): string {
  return value?.trim() ?? "";
}

function nullable(value: string | undefined): string | null {
  const result = trim(value);
  return result || null;
}

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  const normalized = trim(value).toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new ConfigError(`${name} must be true or false`);
}

function positiveInteger(value: string, name: string): number {
  return boundedInteger(value, name, 1, Number.MAX_SAFE_INTEGER);
}

function boundedInteger(value: string, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ConfigError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function recoverBoundedInteger(
  recovered: Record<string, string | undefined>,
  input: InputMap,
  name: string,
  fallback: string,
  minimum: number,
  maximum: number,
): void {
  const value = trim(input[name]);
  const parsed = Number(value || fallback);
  recovered[name] = Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? value || fallback
    : fallback;
}

function recoverOptionalPositiveInteger(
  recovered: Record<string, string | undefined>,
  input: InputMap,
  name: string,
): void {
  const value = trim(input[name]);
  const parsed = Number(value);
  recovered[name] = !value || (Number.isSafeInteger(parsed) && parsed > 0) ? value : "";
}

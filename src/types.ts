import type { ContextRecord } from "@nextmoca/needlepath-sdk";

export type WorkflowType = "custom" | "pr-review" | "ci-diagnosis" | "release-notes";
export type ActionMode = "shadow" | "select";

export interface MandatorySection {
  title: string;
  text: string;
}

export interface OmissionCounts {
  binaryOrUnavailablePatch: number;
  truncatedRecords: number;
  recordLimit: number;
  unavailableSources: number;
}

export interface CollectedContext {
  query: string;
  mandatory: MandatorySection[];
  candidates: ContextRecord[];
  omissions: OmissionCounts;
}

export interface PullRequestFile {
  filename: string;
  status: string;
  additions?: number;
  deletions?: number;
  patch: string | null;
}

export interface IssueSnapshot {
  number: number;
  title: string;
  body: string;
}

export interface CheckSnapshot {
  name: string;
  conclusion: string | null;
  summary: string;
}

export interface PullRequestSnapshot {
  number: number;
  title: string;
  body: string;
  baseRef: string;
  headRef: string;
  files: PullRequestFile[];
  linkedIssues: IssueSnapshot[];
  checks: CheckSnapshot[];
}

export interface AnnotationSnapshot {
  path: string;
  line: number | null;
  level: string;
  message: string;
}

export interface JobSnapshot {
  id: number;
  name: string;
  conclusion: string | null;
  failedSteps: string[];
  annotations: AnnotationSnapshot[];
  log: string | null;
}

export interface CiSnapshot {
  runId: number;
  workflowName: string;
  conclusion: string | null;
  jobs: JobSnapshot[];
}

export interface CommitSnapshot {
  sha: string;
  message: string;
  author: string;
}

export interface ReleasePullRequestSnapshot {
  number: number;
  title: string;
  body: string;
}

export interface ReleaseSnapshot {
  baseRef: string;
  headRef: string;
  commits: CommitSnapshot[];
  pullRequests: ReleasePullRequestSnapshot[];
  issues: IssueSnapshot[];
  files: Array<Pick<PullRequestFile, "filename" | "status" | "patch">>;
}

export interface CollectorSnapshot {
  pullRequest?: PullRequestSnapshot;
  ci?: CiSnapshot;
  release?: ReleaseSnapshot;
}

export interface CollectorOptions {
  query: string;
  mandatory: MandatorySection[];
  maxRecordBytes: number;
  maxRecords: number;
}

export interface ExecutionReceipt {
  contextPath: string;
  originalContextPath: string;
  applied: boolean;
  failOpen: boolean;
  outcome: string;
  reason: string;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  reductionPercent: number;
  selectionLatencyMs: number;
  requestId: string;
  operatingPoint: string;
  downstreamContext: "selected" | "original";
}

export interface SummaryData extends Omit<ExecutionReceipt, "contextPath" | "originalContextPath"> {
  workflowType: WorkflowType;
  mode: ActionMode;
  endpointClass: "hosted" | "local" | "private";
  mandatoryRecords: number;
  selectableRecords: number;
  omittedRecords: number;
}

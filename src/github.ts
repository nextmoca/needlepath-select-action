import type { ActionConfig } from "./config.js";
import type {
  AnnotationSnapshot,
  CheckSnapshot,
  CollectorSnapshot,
  CommitSnapshot,
  IssueSnapshot,
  JobSnapshot,
  PullRequestFile,
  ReleasePullRequestSnapshot,
} from "./types.js";

type FetchFunction = typeof globalThis.fetch;

export class GithubApiError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`GitHub API request failed with status ${status}`);
    this.name = "GithubApiError";
    this.status = status;
  }
}

export interface GithubReader {
  getJson(path: string): Promise<unknown>;
  getText(path: string, maxBytes?: number): Promise<string>;
  paginate(path: string, perPage?: number, maxPages?: number): Promise<unknown[]>;
}

export class GithubApi implements GithubReader {
  readonly #repository: string;
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #fetch: FetchFunction;

  constructor(options: {
    repository: string;
    token: string;
    baseUrl?: string;
    fetch?: FetchFunction;
  }) {
    this.#repository = options.repository;
    this.#token = options.token;
    this.#baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async getJson(path: string): Promise<unknown> {
    const response = await this.#request(path, "application/vnd.github+json");
    try {
      return await response.json();
    } catch {
      throw new GithubApiError(response.status || 502);
    }
  }

  async getText(path: string, maxBytes = 1_000_000): Promise<string> {
    const response = await this.#request(path, "text/plain");
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      try {
        await response.body?.cancel();
      } catch {
        // The byte cap still holds if the remote stream rejects cancellation.
      }
      return "";
    }
    if (!response.body) return "";

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    let reachedCap = false;
    try {
      while (bytesRead < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.byteLength === 0) continue;
        const remaining = maxBytes - bytesRead;
        const chunk = Buffer.from(value.subarray(0, remaining));
        chunks.push(chunk);
        bytesRead += chunk.byteLength;
        if (value.byteLength >= remaining) {
          reachedCap = true;
          break;
        }
      }
    } catch {
      throw new GithubApiError(response.status || 502);
    } finally {
      if (reachedCap) {
        try {
          await reader.cancel();
        } catch {
          // Ignore cancellation failures after the bounded bytes are captured.
        }
      }
      reader.releaseLock();
    }
    return Buffer.concat(chunks, bytesRead).toString("utf8");
  }

  async paginate(path: string, perPage = 100, maxPages = 20): Promise<unknown[]> {
    const rows: unknown[] = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const response = await this.getJson(`${path}${separator}per_page=${perPage}&page=${page}`);
      if (!Array.isArray(response)) throw new GithubApiError(502);
      if (response.length === 0) break;
      rows.push(...response);
    }
    return rows;
  }

  async #request(path: string, accept: string): Promise<Response> {
    if (!path.startsWith("/")) throw new GithubApiError(400);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: "GET",
        redirect: "follow",
        headers: {
          accept,
          authorization: `Bearer ${this.#token}`,
          "user-agent": "needlepath-select-action/0.1",
          "x-github-api-version": "2022-11-28",
        },
      });
    } catch {
      throw new GithubApiError(0);
    }
    if (!response.ok) throw new GithubApiError(response.status);
    return response;
  }

  get repository(): string {
    return this.#repository;
  }
}

export async function loadGithubSnapshot(
  config: ActionConfig,
  event: Record<string, unknown>,
  repository: string,
  reader: GithubReader,
): Promise<CollectorSnapshot> {
  switch (config.workflowType) {
    case "pr-review":
      return loadPullRequest(event, repository, reader);
    case "ci-diagnosis":
      return loadCi(config, event, repository, reader);
    case "release-notes":
      return loadRelease(config, event, repository, reader);
    case "custom":
      return {};
  }
}

async function loadPullRequest(
  event: Record<string, unknown>,
  repository: string,
  reader: GithubReader,
): Promise<CollectorSnapshot> {
  const pullRequest = object(event.pull_request);
  if (!pullRequest) return {};
  const number = integer(pullRequest.number);
  const head = object(pullRequest.head);
  const base = object(pullRequest.base);
  if (!number || !head || !base) return {};
  const files = (await reader.paginate(`/repos/${repository}/pulls/${number}/files`))
    .map(normalizePullRequestFile)
    .filter((value): value is PullRequestFile => value !== null);
  const body = string(pullRequest.body);
  const linkedIssues: IssueSnapshot[] = [];
  for (const issueNumber of linkedIssueNumbers(body)) {
    const issue = normalizeIssue(await reader.getJson(`/repos/${repository}/issues/${issueNumber}`));
    if (issue) linkedIssues.push(issue);
  }
  const headSha = string(head.sha);
  const checksPayload = headSha
    ? await reader.getJson(`/repos/${repository}/commits/${encodeURIComponent(headSha)}/check-runs`)
    : {};
  const checks = array(object(checksPayload)?.check_runs)
    .map(normalizeCheck)
    .filter((value): value is CheckSnapshot => value !== null);
  return {
    pullRequest: {
      number,
      title: string(pullRequest.title),
      body,
      baseRef: string(base.ref),
      headRef: string(head.ref),
      files,
      linkedIssues,
      checks,
    },
  };
}

async function loadCi(
  config: ActionConfig,
  event: Record<string, unknown>,
  repository: string,
  reader: GithubReader,
): Promise<CollectorSnapshot> {
  const workflowRun = object(event.workflow_run);
  const runId = config.githubRunId ?? integer(workflowRun?.id);
  if (!runId) return {};
  const jobsRaw = await reader.paginate(`/repos/${repository}/actions/runs/${runId}/jobs`);
  const jobs: JobSnapshot[] = [];
  for (const raw of jobsRaw) {
    const job = object(raw);
    const id = integer(job?.id);
    if (!job || !id) continue;
    const conclusion = nullableString(job.conclusion);
    const failed = ["failure", "cancelled", "timed_out"].includes(conclusion ?? "");
    const annotations = failed
      ? (await reader.paginate(`/repos/${repository}/check-runs/${id}/annotations`))
          .map(normalizeAnnotation)
          .filter((value): value is AnnotationSnapshot => value !== null)
      : [];
    let log: string | null = null;
    if (failed) {
      try {
        log = await reader.getText(`/repos/${repository}/actions/jobs/${id}/logs`, 2_000_000);
      } catch {
        log = null;
      }
    }
    const failedSteps = array(job.steps)
      .map(object)
      .filter((step): step is Record<string, unknown> => Boolean(step))
      .filter((step) => ["failure", "cancelled", "timed_out"].includes(string(step.conclusion)))
      .map((step) => string(step.name));
    jobs.push({
      id,
      name: string(job.name),
      conclusion,
      failedSteps,
      annotations,
      log,
    });
  }
  return {
    ci: {
      runId,
      workflowName: string(workflowRun?.name) || "GitHub Actions",
      conclusion: nullableString(workflowRun?.conclusion),
      jobs,
    },
  };
}

async function loadRelease(
  config: ActionConfig,
  event: Record<string, unknown>,
  repository: string,
  reader: GithubReader,
): Promise<CollectorSnapshot> {
  const baseRef = config.baseRef ?? nullableString(event.before);
  const headRef = config.headRef ?? nullableString(event.after);
  if (!baseRef || !headRef) return {};
  const comparison = object(
    await reader.getJson(
      `/repos/${repository}/compare/${encodeURIComponent(baseRef)}...${encodeURIComponent(headRef)}`,
    ),
  );
  if (!comparison) return {};
  const commits = array(comparison.commits)
    .map(normalizeCommit)
    .filter((value): value is CommitSnapshot => value !== null);
  const pullRequests = new Map<number, ReleasePullRequestSnapshot>();
  const issues = new Map<number, IssueSnapshot>();
  for (const commit of commits) {
    const associated = await reader.paginate(
      `/repos/${repository}/commits/${encodeURIComponent(commit.sha)}/pulls`,
    );
    for (const raw of associated) {
      const pullRequest = normalizeReleasePullRequest(raw);
      if (!pullRequest) continue;
      pullRequests.set(pullRequest.number, pullRequest);
      for (const issueNumber of linkedIssueNumbers(pullRequest.body)) {
        if (issues.has(issueNumber)) continue;
        const issue = normalizeIssue(await reader.getJson(`/repos/${repository}/issues/${issueNumber}`));
        if (issue) issues.set(issueNumber, issue);
      }
    }
  }
  return {
    release: {
      baseRef,
      headRef,
      commits,
      pullRequests: [...pullRequests.values()],
      issues: [...issues.values()],
      files: array(comparison.files)
        .map(normalizePullRequestFile)
        .filter((value): value is PullRequestFile => value !== null),
    },
  };
}

function normalizePullRequestFile(value: unknown): PullRequestFile | null {
  const raw = object(value);
  if (!raw || !string(raw.filename)) return null;
  return {
    filename: string(raw.filename),
    status: string(raw.status),
    additions: integer(raw.additions) ?? 0,
    deletions: integer(raw.deletions) ?? 0,
    patch: nullableString(raw.patch),
  };
}

function normalizeIssue(value: unknown): IssueSnapshot | null {
  const raw = object(value);
  const number = integer(raw?.number);
  if (!raw || !number) return null;
  return { number, title: string(raw.title), body: string(raw.body) };
}

function normalizeCheck(value: unknown): CheckSnapshot | null {
  const raw = object(value);
  if (!raw) return null;
  const output = object(raw.output);
  return {
    name: string(raw.name),
    conclusion: nullableString(raw.conclusion),
    summary: string(output?.summary),
  };
}

function normalizeAnnotation(value: unknown): AnnotationSnapshot | null {
  const raw = object(value);
  if (!raw) return null;
  return {
    path: string(raw.path),
    line: integer(raw.start_line),
    level: string(raw.annotation_level),
    message: string(raw.message),
  };
}

function normalizeCommit(value: unknown): CommitSnapshot | null {
  const raw = object(value);
  const sha = string(raw?.sha);
  const commit = object(raw?.commit);
  if (!raw || !sha || !commit) return null;
  return {
    sha,
    message: string(commit.message),
    author: string(object(commit.author)?.name),
  };
}

function normalizeReleasePullRequest(value: unknown): ReleasePullRequestSnapshot | null {
  const raw = object(value);
  const number = integer(raw?.number);
  if (!raw || !number) return null;
  return { number, title: string(raw.title), body: string(raw.body) };
}

function linkedIssueNumbers(body: string): number[] {
  const matches = body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi);
  return [...new Set([...matches].map((match) => Number(match[1])).filter(Number.isSafeInteger))];
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  const result = string(value);
  return result || null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

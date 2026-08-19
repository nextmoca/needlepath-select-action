import type { ContextRecord } from "@nextmoca/needlepath-sdk";

import type {
  CollectedContext,
  CollectorOptions,
  CollectorSnapshot,
  OmissionCounts,
  WorkflowType,
} from "./types.js";

export function collectSnapshot(
  workflowType: Exclude<WorkflowType, "custom">,
  snapshot: CollectorSnapshot,
  options: CollectorOptions,
): CollectedContext {
  const omissions = emptyOmissions();
  let records: ContextRecord[];
  switch (workflowType) {
    case "pr-review":
      records = collectPullRequest(snapshot, omissions);
      break;
    case "ci-diagnosis":
      records = collectCi(snapshot, omissions);
      break;
    case "release-notes":
      records = collectRelease(snapshot, omissions);
      break;
  }
  const bounded = boundRecords(records, options.maxRecordBytes, omissions);
  if (bounded.length > options.maxRecords) {
    omissions.recordLimit += bounded.length - options.maxRecords;
    bounded.length = options.maxRecords;
  }
  return {
    query: options.query,
    mandatory: [...options.mandatory],
    candidates: bounded,
    omissions,
  };
}

function collectPullRequest(
  snapshot: CollectorSnapshot,
  omissions: OmissionCounts,
): ContextRecord[] {
  const pullRequest = snapshot.pullRequest;
  if (!pullRequest) {
    omissions.unavailableSources += 1;
    return [];
  }
  const records: ContextRecord[] = [
    record(
      `pr:${pullRequest.number}:metadata`,
      "external_data",
      `Pull request #${pullRequest.number}`,
      [
        `Title: ${pullRequest.title}`,
        `Base: ${pullRequest.baseRef}`,
        `Head: ${pullRequest.headRef}`,
        `Description:\n${pullRequest.body}`,
      ].join("\n"),
      ["github", "pull_request", "metadata"],
    ),
  ];
  for (const file of pullRequest.files) {
    if (file.patch === null) {
      omissions.binaryOrUnavailablePatch += 1;
      continue;
    }
    records.push(
      record(
        `pr-file:${safeId(file.filename)}`,
        "external_data",
        `Pull request diff: ${safeTitle(file.filename)}`,
        [
          `Path: ${file.filename}`,
          `Status: ${file.status}`,
          `Additions: ${file.additions ?? 0}`,
          `Deletions: ${file.deletions ?? 0}`,
          "Patch:",
          file.patch,
        ].join("\n"),
        ["github", "pull_request", "diff"],
      ),
    );
  }
  for (const issue of pullRequest.linkedIssues) {
    records.push(
      record(
        `issue:${issue.number}`,
        "external_data",
        `Linked issue #${issue.number}`,
        `${issue.title}\n${issue.body}`,
        ["github", "issue", "acceptance_criteria"],
      ),
    );
  }
  pullRequest.checks.forEach((check, index) => {
    records.push(
      record(
        `pr-check:${index + 1}`,
        "tool_result",
        `Check: ${check.name}`,
        `Conclusion: ${check.conclusion ?? "unknown"}\n${check.summary}`,
        ["github", "check", "diagnostic"],
      ),
    );
  });
  return records;
}

function collectCi(snapshot: CollectorSnapshot, omissions: OmissionCounts): ContextRecord[] {
  const ci = snapshot.ci;
  if (!ci) {
    omissions.unavailableSources += 1;
    return [];
  }
  const records: ContextRecord[] = [
    record(
      `ci-run:${ci.runId}`,
      "tool_result",
      `CI run ${ci.runId}`,
      `Workflow: ${ci.workflowName}\nConclusion: ${ci.conclusion ?? "unknown"}`,
      ["github", "ci", "run"],
    ),
  ];
  for (const job of ci.jobs) {
    if (job.conclusion !== "failure" && job.conclusion !== "cancelled" && job.conclusion !== "timed_out") {
      continue;
    }
    records.push(
      record(
        `ci-job:${job.id}:metadata`,
        "tool_result",
        `Failed CI job: ${job.name}`,
        `Conclusion: ${job.conclusion ?? "unknown"}\nFailed steps: ${job.failedSteps.join(", ") || "unknown"}`,
        ["github", "ci", "failed_job"],
      ),
    );
    if (job.annotations.length > 0) {
      records.push(
        record(
          `ci-job:${job.id}:annotations`,
          "error",
          `Annotations: ${job.name}`,
          job.annotations
            .map(
              (annotation) =>
                `${annotation.level}: ${annotation.path}:${annotation.line ?? "?"}: ${annotation.message}`,
            )
            .join("\n"),
          ["github", "ci", "annotation"],
        ),
      );
    }
    if (job.log) {
      records.push(
        record(
          `ci-job:${job.id}:log`,
          "tool_result",
          `Log: ${job.name}`,
          job.log,
          ["github", "ci", "log"],
        ),
      );
    } else {
      omissions.unavailableSources += 1;
    }
  }
  return records;
}

function collectRelease(
  snapshot: CollectorSnapshot,
  omissions: OmissionCounts,
): ContextRecord[] {
  const release = snapshot.release;
  if (!release) {
    omissions.unavailableSources += 1;
    return [];
  }
  const records: ContextRecord[] = [
    record(
      `release:${safeId(release.baseRef)}:${safeId(release.headRef)}`,
      "external_data",
      "Release range",
      `Base: ${release.baseRef}\nHead: ${release.headRef}`,
      ["github", "release", "range"],
    ),
  ];
  for (const commit of release.commits) {
    records.push(
      record(
        `commit:${safeId(commit.sha)}`,
        "external_data",
        `Commit ${commit.sha.slice(0, 12)}`,
        `Author: ${commit.author}\n${commit.message}`,
        ["github", "release", "commit"],
      ),
    );
  }
  for (const pullRequest of release.pullRequests) {
    records.push(
      record(
        `pr:${pullRequest.number}`,
        "external_data",
        `Merged pull request #${pullRequest.number}`,
        `${pullRequest.title}\n${pullRequest.body}`,
        ["github", "release", "pull_request"],
      ),
    );
  }
  for (const issue of release.issues) {
    records.push(
      record(
        `issue:${issue.number}`,
        "external_data",
        `Release issue #${issue.number}`,
        `${issue.title}\n${issue.body}`,
        ["github", "release", "issue"],
      ),
    );
  }
  for (const file of release.files) {
    const lower = file.filename.toLowerCase();
    if (!/(migration|deploy|changelog|release)/.test(lower)) continue;
    if (file.patch === null) {
      omissions.binaryOrUnavailablePatch += 1;
      continue;
    }
    records.push(
      record(
        `release-file:${safeId(file.filename)}`,
        "artifact",
        `Release file: ${safeTitle(file.filename)}`,
        `Status: ${file.status}\n${file.patch}`,
        ["github", "release", "migration_deployment"],
      ),
    );
  }
  return records;
}

function boundRecords(
  records: ContextRecord[],
  maxRecordBytes: number,
  omissions: OmissionCounts,
): ContextRecord[] {
  const bounded: ContextRecord[] = [];
  for (const source of records) {
    const chunks = splitUtf8(source.text, maxRecordBytes);
    if (chunks.length > 1) omissions.truncatedRecords += chunks.length - 1;
    chunks.forEach((text, index) => {
      const { id, title, ...rest } = source;
      const boundedRecord: ContextRecord = { ...rest, text };
      if (chunks.length === 1) {
        if (id !== undefined) boundedRecord.id = id;
        if (title !== undefined) boundedRecord.title = title;
      } else {
        boundedRecord.id = `${id ?? "record"}:chunk:${index + 1}`;
        boundedRecord.title = `${title ?? "Record"} (${index + 1}/${chunks.length})`;
      }
      bounded.push(boundedRecord);
    });
  }
  return bounded;
}

export function splitUtf8(value: string, maxBytes: number): string[] {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return [value];
  const chunks: string[] = [];
  let current = "";
  let bytes = 0;
  for (const character of value) {
    const width = Buffer.byteLength(character, "utf8");
    if (bytes + width > maxBytes && current) {
      chunks.push(current);
      current = "";
      bytes = 0;
    }
    current += character;
    bytes += width;
  }
  if (current) chunks.push(current);
  return chunks;
}

function record(
  id: string,
  kind: string,
  title: string,
  text: string,
  tags: string[],
): ContextRecord {
  return {
    id,
    kind,
    title,
    text,
    source: "github",
    tags,
    attributes: { collector: tags[1] ?? "github" },
  };
}

function emptyOmissions(): OmissionCounts {
  return {
    binaryOrUnavailablePatch: 0,
    truncatedRecords: 0,
    recordLimit: 0,
    unavailableSources: 0,
  };
}

function safeId(value: string): string {
  return value.replace(/[\r\n\u0000-\u001f\u007f]/g, "_").slice(0, 300);
}

function safeTitle(value: string): string {
  return value.replace(/[\r\n\u0000-\u001f\u007f]/g, " ").slice(0, 300);
}

import assert from "node:assert/strict";
import test from "node:test";

import { collectSnapshot } from "../src/collectors.js";

test("PR review classifies policy as mandatory and diff evidence as selectable", () => {
  const collected = collectSnapshot(
    "pr-review",
    {
      pullRequest: {
        number: 42,
        title: "Fix authorization",
        body: "Closes #17",
        baseRef: "master",
        headRef: "fix/auth",
        files: [
          {
            filename: "src/auth.ts",
            status: "modified",
            additions: 8,
            deletions: 2,
            patch: "@@ -1 +1 @@\n-old\n+new",
          },
          {
            filename: "assets/logo.png",
            status: "modified",
            additions: 0,
            deletions: 0,
            patch: null,
          },
        ],
        linkedIssues: [{ number: 17, title: "Authorization bug", body: "Must reject guests" }],
        checks: [{ name: "tests", conclusion: "success", summary: "All tests passed" }],
      },
    },
    {
      query: "Review this pull request",
      mandatory: [{ title: "Security policy", text: "Never weaken authentication." }],
      maxRecordBytes: 20_000,
      maxRecords: 100,
    },
  );

  assert.deepEqual(collected.mandatory.map((item) => item.title), ["Security policy"]);
  assert.ok(collected.candidates.some((record) => record.id === "pr-file:src/auth.ts"));
  assert.ok(collected.candidates.some((record) => record.id === "issue:17"));
  assert.equal(collected.candidates.some((record) => record.text.includes("Never weaken")), false);
  assert.equal(collected.omissions.binaryOrUnavailablePatch, 1);
});

test("CI diagnosis emits bounded failed-job logs and annotations without executing artifacts", () => {
  const collected = collectSnapshot(
    "ci-diagnosis",
    {
      ci: {
        runId: 9001,
        workflowName: "CI",
        conclusion: "failure",
        jobs: [
          {
            id: 11,
            name: "unit-tests",
            conclusion: "failure",
            failedSteps: ["Run tests"],
            annotations: [
              { path: "src/math.ts", line: 12, level: "failure", message: "Expected 4" },
            ],
            log: "FAIL math.test.ts\nExpected 4, received 5\n".repeat(200),
          },
        ],
      },
    },
    {
      query: "Diagnose this failed CI run",
      mandatory: [],
      maxRecordBytes: 512,
      maxRecords: 100,
    },
  );

  assert.ok(collected.candidates.some((record) => record.id === "ci-job:11:metadata"));
  assert.ok(collected.candidates.some((record) => record.id === "ci-job:11:annotations"));
  const logs = collected.candidates.filter((record) => record.id?.startsWith("ci-job:11:log:"));
  assert.ok(logs.length > 1);
  assert.ok(logs.every((record) => Buffer.byteLength(record.text, "utf8") <= 512));
  assert.ok(collected.omissions.truncatedRecords > 0);
});

test("release notes collect commits, merged PRs, issues, migrations, and deployment notes", () => {
  const collected = collectSnapshot(
    "release-notes",
    {
      release: {
        baseRef: "v1.0.0",
        headRef: "v1.1.0",
        commits: [{ sha: "abc123", message: "Add billing limits", author: "A. Dev" }],
        pullRequests: [{ number: 88, title: "Billing limits", body: "Adds tenant quotas" }],
        issues: [{ number: 90, title: "Document quotas", body: "Customer-facing docs" }],
        files: [
          { filename: "migrations/2026_add_quota.sql", status: "added", patch: "+ALTER TABLE" },
          { filename: "deploy/production.md", status: "modified", patch: "+Run migration" },
        ],
      },
    },
    {
      query: "Prepare release notes for enterprise customers",
      mandatory: [{ title: "Audience", text: "Enterprise administrators" }],
      maxRecordBytes: 20_000,
      maxRecords: 100,
    },
  );

  assert.ok(collected.candidates.some((record) => record.id === "commit:abc123"));
  assert.ok(collected.candidates.some((record) => record.id === "pr:88"));
  assert.ok(collected.candidates.some((record) => record.id === "issue:90"));
  assert.ok(collected.candidates.some((record) => record.id?.includes("2026_add_quota")));
  assert.equal(collected.mandatory[0]?.text, "Enterprise administrators");
});

test("collector limits are deterministic and auditable", () => {
  const snapshot = {
    pullRequest: {
      number: 1,
      title: "Large change",
      body: "",
      baseRef: "master",
      headRef: "feature",
      files: Array.from({ length: 10 }, (_, index) => ({
        filename: `src/file-${index}.ts`,
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: `+change-${index}`,
      })),
      linkedIssues: [],
      checks: [],
    },
  };

  const first = collectSnapshot("pr-review", snapshot, {
    query: "Review",
    mandatory: [],
    maxRecordBytes: 1024,
    maxRecords: 4,
  });
  const second = collectSnapshot("pr-review", snapshot, {
    query: "Review",
    mandatory: [],
    maxRecordBytes: 1024,
    maxRecords: 4,
  });

  assert.deepEqual(first, second);
  assert.equal(first.candidates.length, 4);
  assert.ok(first.omissions.recordLimit >= 1);
});

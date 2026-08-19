import assert from "node:assert/strict";
import test from "node:test";

import { GithubApi, GithubApiError, loadGithubSnapshot } from "../src/github.js";
import { parseConfig } from "../src/config.js";

test("GitHub API pagination and authorization stay behind one redacted transport", async () => {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const api = new GithubApi({
    repository: "nextmoca/example",
    token: "ghs_secret",
    baseUrl: "https://api.github.test",
    fetch: async (input, init) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      const page = new URL(String(input)).searchParams.get("page");
      return new Response(JSON.stringify(page === "1" ? [{ id: 1 }] : []), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const rows = await api.paginate("/repos/nextmoca/example/items", 10);

  assert.deepEqual(rows, [{ id: 1 }]);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.authorization === "Bearer ghs_secret"));
});

test("GitHub API failures reveal status only, never token, URL, or response content", async () => {
  const api = new GithubApi({
    repository: "nextmoca/private-name",
    token: "ghs_top_secret",
    baseUrl: "https://secret-host.example",
    fetch: async () => new Response("private repository content", { status: 403 }),
  });

  await assert.rejects(
    () => api.getJson("/private/path"),
    (error: unknown) => {
      assert.ok(error instanceof GithubApiError);
      assert.equal(error.status, 403);
      assert.doesNotMatch(String(error), /ghs_top_secret|secret-host|private-name|repository content/);
      return true;
    },
  );
});

test("GitHub text downloads cancel the response stream at the byte cap", async () => {
  const chunks = ["abcd", "efgh", "ijkl"];
  let nextChunk = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[nextChunk];
      nextChunk += 1;
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(Buffer.from(chunk));
    },
    cancel() {
      cancelled = true;
    },
  });
  const api = new GithubApi({
    repository: "nextmoca/example",
    token: "ghs_secret",
    baseUrl: "https://api.github.test",
    fetch: async () => new Response(body, { status: 200 }),
  });

  const text = await api.getText("/repos/nextmoca/example/actions/jobs/1/logs", 5);

  assert.equal(text, "abcde");
  assert.equal(cancelled, true);
});

test("PR source loads files, linked issues, and checks from event identity", async () => {
  const config = parseConfig({ "workflow-type": "pr-review" }, {});
  const requested: string[] = [];
  const reader = {
    async getJson(path: string) {
      requested.push(path);
      if (path.includes("/issues/17")) {
        return { number: 17, title: "Issue", body: "Acceptance" };
      }
      if (path.includes("/check-runs")) {
        return { check_runs: [{ name: "tests", conclusion: "success", output: { summary: "ok" } }] };
      }
      throw new Error(`unexpected ${path}`);
    },
    async paginate(path: string) {
      requested.push(path);
      return [
        {
          filename: "src/app.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "+fix",
        },
      ];
    },
    async getText() {
      return "";
    },
  };
  const snapshot = await loadGithubSnapshot(
    config,
    {
      pull_request: {
        number: 9,
        title: "Fix",
        body: "Closes #17",
        base: { ref: "master" },
        head: { ref: "fix", sha: "abc" },
      },
    },
    "nextmoca/example",
    reader,
  );

  assert.equal(snapshot.pullRequest?.files[0]?.filename, "src/app.ts");
  assert.equal(snapshot.pullRequest?.linkedIssues[0]?.number, 17);
  assert.equal(snapshot.pullRequest?.checks[0]?.name, "tests");
  assert.ok(requested.some((path) => path.includes("/pulls/9/files")));
});

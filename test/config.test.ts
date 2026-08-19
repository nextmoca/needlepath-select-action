import assert from "node:assert/strict";
import test from "node:test";

import { ConfigError, parseConfig } from "../src/config.js";

test("defaults built-in workflows to shadow and the frozen r3 operating point", () => {
  const config = parseConfig({ "workflow-type": "pr-review" }, {});

  assert.equal(config.mode, "shadow");
  assert.equal(config.operatingPoint, "np-2026-08-r3");
  assert.equal(config.enabled, true);
  assert.match(config.query, /pull request/i);
});

test("custom context requires a task and exactly one candidate source", () => {
  assert.throws(
    () => parseConfig({ "workflow-type": "custom", query: "Review" }, {}),
    ConfigError,
  );
  assert.throws(
    () =>
      parseConfig(
        {
          "workflow-type": "custom",
          query: "Review",
          "context-path": "context.txt",
          "records-path": "records.jsonl",
        },
        {},
      ),
    /exactly one/i,
  );
});

test("select mode and one-line disable are configuration-only switches", () => {
  const config = parseConfig(
    {
      "workflow-type": "ci-diagnosis",
      mode: "select",
      enabled: "false",
      "max-context-tokens": "4096",
    },
    {},
  );

  assert.equal(config.mode, "select");
  assert.equal(config.enabled, false);
  assert.equal(config.maxContextTokens, 4096);
});

test("credentials are accepted only from the environment", () => {
  const config = parseConfig(
    { "workflow-type": "release-notes" },
    { NEEDLEPATH_API_KEY: "np_live_secret" },
  );

  assert.equal(config.hasNeedlepathApiKey, true);
  assert.equal("apiKey" in config, false);
});

test("unknown workflow types and mutable operating point aliases are rejected", () => {
  assert.throws(() => parseConfig({ "workflow-type": "anything" }, {}), /workflow-type/);
  assert.throws(
    () =>
      parseConfig(
        { "workflow-type": "pr-review", "operating-point": "latest" },
        {},
      ),
    /immutable/i,
  );
});

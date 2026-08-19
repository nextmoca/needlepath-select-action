import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseDocument } from "yaml";

const examples = new URL("../examples/", import.meta.url);
const releaseSha = "0000000000000000000000000000000000000000"  // stamped with the real release SHA by the release process;

for (const name of ["pr-review.yml", "ci-diagnosis.yml", "release-notes.yml"]) {
  test(`${name} is immutable, valid, provider-neutral, and content-safe`, async () => {
    const source = await readFile(new URL(name, examples), "utf8");
    const document = parseDocument(source);

    assert.deepEqual(document.errors, []);
    assert.match(
      source,
      new RegExp(
        `nextmoca/needlepath-select-action/\\.github/workflows/needlepath-context-preparation\\.yml@${releaseSha}`,
      ),
    );
    assert.match(
      source,
      /actions\/download-artifact@018cc2cf5baa6db3ef3c5f8a56943fffe632ef53/,
    );
    assert.match(source, /operating_point:\s+np-2026-08-r3/);
    assert.match(source, /mode:\s+shadow/);
    assert.match(source, /needlepath_api_key:\s+\$\{\{ secrets\.NEEDLEPATH_API_KEY \}\}/);
    assert.doesNotMatch(source, /@(?:main|master|v\d+)(?:\s|$)/);
    assert.doesNotMatch(source, /\b(?:cat|Get-Content|type)\s+.*context/i);
    assert.doesNotMatch(source, /(?:openai|anthropic|gemini|claude|codex)[-_ ]api[-_ ]key/i);
  });
}

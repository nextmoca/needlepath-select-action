import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

// This validates the bundle's runtime contract, size, and dependency surface.
// CI verifies freshness separately by rebuilding dist/ and running git diff --exit-code.

const action = await readFile(new URL("../action.yml", import.meta.url), "utf8");
const bundleUrl = new URL("../dist/index.js", import.meta.url);
const bundle = await readFile(bundleUrl, "utf8");
const metadata = await stat(bundleUrl);
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

assert.match(action, /using:\s+node24/);
assert.match(action, /main:\s+dist\/index\.js/);
assert.ok(metadata.size > 10_000, "bundled action is unexpectedly small");
assert.ok(metadata.size < 5_000_000, "bundled action exceeds the public-action size guard");
assert.match(bundle, /needlepath-github-action\/0\.1\.0/);
assert.equal(packageJson.dependencies["@nextmoca/needlepath-sdk"], "0.2.0");
assert.deepEqual(Object.keys(packageJson.dependencies), ["@nextmoca/needlepath-sdk"]);
assert.doesNotMatch(bundle, /@actions\/core/);

console.log(`Verified Needlepath Action bundle (${metadata.size} bytes).`);

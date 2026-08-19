import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import test from "node:test";

import { InputPathError, isPathInside, resolveInputFile } from "../src/paths.js";

test("input files resolve only inside the workspace", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "needlepath-workspace-"));
  const inside = join(workspace, "context.txt");
  await writeFile(inside, "context", "utf8");

  assert.equal(await resolveInputFile("context.txt", workspace), inside);
  await assert.rejects(() => resolveInputFile("../outside.txt", workspace), InputPathError);
});

test("symlink inputs are rejected even when their target is readable", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "needlepath-workspace-"));
  const outside = await mkdtemp(join(tmpdir(), "needlepath-outside-"));
  await writeFile(join(outside, "secret.txt"), "secret", "utf8");
  await mkdir(join(workspace, "inputs"));
  try {
    await symlink(join(outside, "secret.txt"), join(workspace, "inputs", "context.txt"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      context.skip("symlink creation is unavailable on this runner");
      return;
    }
    throw error;
  }

  await assert.rejects(
    () => resolveInputFile("inputs/context.txt", workspace),
    /symbolic link/i,
  );
});

test("containment works for both POSIX and Windows path semantics", () => {
  assert.equal(isPathInside("/repo", "/repo/context.txt", path.posix), true);
  assert.equal(isPathInside("/repo", "/repo-other/context.txt", path.posix), false);
  assert.equal(isPathInside("C:\\repo", "C:\\repo\\context.txt", path.win32), true);
  assert.equal(isPathInside("C:\\repo", "C:\\repo-other\\context.txt", path.win32), false);
  assert.equal(isPathInside("C:\\repo", "D:\\context.txt", path.win32), false);
});

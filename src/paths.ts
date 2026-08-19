import { lstat, realpath } from "node:fs/promises";
import path, { resolve } from "node:path";

export class InputPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputPathError";
  }
}

type PathApi = Pick<typeof path, "relative" | "isAbsolute">;

export function isPathInside(root: string, candidate: string, api: PathApi = path): boolean {
  const relative = api.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !api.isAbsolute(relative));
}

export async function resolveInputFile(inputPath: string, workspace: string): Promise<string> {
  const lexicalWorkspace = resolve(workspace);
  const lexicalCandidate = resolve(lexicalWorkspace, inputPath);
  if (!isPathInside(lexicalWorkspace, lexicalCandidate)) {
    throw new InputPathError("input path must stay inside GITHUB_WORKSPACE");
  }
  const [workspaceReal, candidateReal] = await Promise.all([
    realpath(lexicalWorkspace),
    realpath(lexicalCandidate),
  ]).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    throw new InputPathError(`input path is not a readable file (${code})`);
  });
  const expectedReal = resolve(
    workspaceReal,
    path.relative(lexicalWorkspace, lexicalCandidate),
  );
  if (candidateReal !== expectedReal) {
    throw new InputPathError("symbolic link inputs are not allowed");
  }
  if (!isPathInside(workspaceReal, candidateReal)) {
    throw new InputPathError("input path resolves outside GITHUB_WORKSPACE");
  }
  const stat = await lstat(lexicalCandidate);
  if (stat.isSymbolicLink()) throw new InputPathError("symbolic link inputs are not allowed");
  if (!stat.isFile()) throw new InputPathError("input path must identify a regular file");
  return lexicalCandidate;
}

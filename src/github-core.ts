import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import type { ActionCore } from "./main.js";

type Environment = Readonly<Record<string, string | undefined>>;

export class GithubFileCore implements ActionCore {
  readonly #env: Environment;
  readonly #writeLine: (message: string) => void;
  readonly #markFailed: () => void;

  constructor(
    env: Environment = process.env,
    writeLine: (message: string) => void = console.log,
    markFailed: () => void = () => {
      process.exitCode = 1;
    },
  ) {
    this.#env = env;
    this.#writeLine = writeLine;
    this.#markFailed = markFailed;
  }

  getInput(name: string): string {
    const key = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
    return this.#env[key] ?? "";
  }

  setOutput(name: string, value: string): void {
    const outputFile = this.#env.GITHUB_OUTPUT;
    if (!outputFile) throw new Error("github_output_unavailable");
    let delimiter = `needlepath_${randomUUID()}`;
    while (value.includes(delimiter)) delimiter = `needlepath_${randomUUID()}`;
    appendFileSync(outputFile, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, {
      encoding: "utf8",
    });
  }

  setSecret(value: string): void {
    this.#writeLine(`::add-mask::${escapeCommand(value)}`);
  }

  async addSummary(markdown: string): Promise<void> {
    const summaryFile = this.#env.GITHUB_STEP_SUMMARY;
    if (!summaryFile) return;
    appendFileSync(summaryFile, markdown, { encoding: "utf8" });
  }

  warning(message: string): void {
    this.#writeLine(`::warning::${escapeCommand(message)}`);
  }

  setFailed(message: string): void {
    this.#markFailed();
    this.#writeLine(`::error::${escapeCommand(message)}`);
  }
}

function escapeCommand(value: string): string {
  return value
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

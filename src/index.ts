import { GithubFileCore } from "./github-core.js";
import { runAction } from "./main.js";

await runAction({ core: new GithubFileCore() });

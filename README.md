# Needlepath Select

Prepare smaller, more relevant context for the AI step you already run in GitHub Actions — without changing your model, agent, or CI system.

Needlepath is a verbatim-selection engine: it decides which of your existing context records are relevant to the current task and returns them unchanged. It never rewrites, summarizes, or generates text, and this action never calls a model provider. Selection is a single fast service decision (~10ms-class), made before your model step, and your downstream agent stays entirely under your control.

Three properties define the integration:

- **Provider-neutral.** The action writes a context file. Any downstream model or agent step consumes that file. No provider SDK, key, or preference is embedded.
- **Shadow by default.** The default `mode: shadow` measures what Needlepath would have selected while your agent continues to receive the exact original context. Promote to `mode: select` by changing one value.
- **Exact fail-open.** In `select` mode, any timeout, service failure, stand-down, malformed response, or unknown future outcome results in a downstream context file byte-identical to the original. A Needlepath outage cannot change what your agent sees.

Token and reduction figures reported by the action are Needlepath service estimates, not provider-billed usage.

## Quickstart

1. Add `NEEDLEPATH_API_KEY` as a GitHub Actions secret.
2. Call the reusable context-preparation workflow, pinned to an immutable 40-character commit.
3. Download the returned one-day artifact in your downstream agent job.
4. Validate outcomes in `shadow`, then change only `mode: shadow` to `mode: select`.

```yaml
permissions:
  contents: read
  actions: read
  checks: read
  issues: read
  pull-requests: read

jobs:
  context:
    uses: nextmoca/needlepath-select-action/.github/workflows/needlepath-context-preparation.yml@<40-character-release-sha>
    with:
      workflow_type: pr-review
      mode: shadow
      operating_point: np-2026-08-r3
    secrets:
      needlepath_api_key: ${{ secrets.NEEDLEPATH_API_KEY }}

  review:
    needs: context
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@018cc2cf5baa6db3ef3c5f8a56943fffe632ef53
        with:
          name: ${{ needs.context.outputs.artifact_name }}
          path: .needlepath-context
      - name: Invoke your model or agent
        env:
          NEEDLEPATH_CONTEXT_PATH: .needlepath-context/context.txt
        run: your-provider-neutral-agent --context-file "$NEEDLEPATH_CONTEXT_PATH"
```

Set `enabled: false` for a one-line disable. The downstream artifact contract is unchanged and contains the byte-identical original eligible context.

Copy-ready workflows for PR review, CI failure diagnosis, and release notes are in [`examples/`](examples/). All examples pin third-party actions and the reusable workflow to immutable commits; production use should always pin by full commit SHA.

## Single-job pattern (recommended for sensitive repositories)

The cross-job quickstart above hands context to the downstream job through a workflow artifact. Workflow artifacts are downloadable by anyone with read access to the repository for the artifact's retention window — in a public repository, that is everyone. If your context may contain sensitive repository material, use the action directly in the same job that consumes the context, so no artifact is created:

```yaml
- uses: nextmoca/needlepath-select-action@<40-character-release-sha>
  id: needlepath
  with:
    workflow-type: pr-review
    mode: shadow
    operating-point: np-2026-08-r3
  env:
    NEEDLEPATH_API_KEY: ${{ secrets.NEEDLEPATH_API_KEY }}
    GITHUB_TOKEN: ${{ github.token }}

- name: Invoke downstream agent
  env:
    CONTEXT_PATH: ${{ steps.needlepath.outputs.context-path }}
  run: your-agent --context-file "$CONTEXT_PATH"
```

Do not print the context file. Pass its path to the downstream model adapter. See [SECURITY.md](SECURITY.md) for the full data-handling posture.

## Built-in workflows

| Workflow type | Automatic candidate evidence | Mandatory evidence |
| --- | --- | --- |
| `pr-review` | PR file patches, linked issues, and check summaries | task, repository policy files, explicitly required paths |
| `ci-diagnosis` | failed steps, annotations, bounded logs, and configured local logs | task, repository policy files, explicitly required paths |
| `release-notes` | commits, associated PRs/issues, deployment and migration changes | task, repository policy files, explicitly required paths |
| `custom` | UTF-8 context file or typed JSON/JSONL records | task, mandatory context, required record IDs and paths |

`AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, and `.github/needlepath/policy.md` are automatically classified as mandatory when present. Mandatory material never enters selection and is always placed into downstream context.

## Inputs

> **Input naming:** the reusable workflows take snake_case inputs (`workflow_type`); the action itself takes kebab-case (`workflow-type`), as shown in `action.yml`. Don't mix the two styles.


| Input | Default | Description |
| --- | --- | --- |
| `workflow-type` | `custom` | `custom`, `pr-review`, `ci-diagnosis`, or `release-notes`. |
| `enabled` | `true` | Set `false` to bypass Needlepath while preserving the same downstream file contract. |
| `query` | — | Current task. Built-in workflows infer a safe default when omitted. |
| `task-path` | — | Workspace-relative UTF-8 file containing the current task. |
| `context-path` | — | Workspace-relative UTF-8 candidate context file. |
| `records-path` | — | Workspace-relative JSON array or JSONL typed-record file. |
| `mandatory-context-path` | — | Workspace-relative context that must never enter selection. |
| `required-paths` | — | Newline- or comma-separated workspace files that are always mandatory. |
| `required-record-ids` | — | Newline- or comma-separated record IDs that are always mandatory. |
| `log-paths` | — | Optional bounded local logs for CI diagnosis. |
| `mode` | `shadow` | `shadow` measures without changing downstream context; `select` applies only safe results. |
| `operating-point` | `np-2026-08-r3` | Immutable Needlepath operating point. |
| `endpoint` | — | Optional hosted, loopback, or private Needlepath endpoint. |
| `max-context-tokens` | `8000` | Maximum selected candidate-context tokens. |
| `capacity-cap-tokens` | — | Optional downstream model input-capacity ceiling. |
| `max-records` | `200` | Maximum selectable candidate records. |
| `max-record-bytes` | `200000` | Maximum UTF-8 bytes per collected candidate record. |
| `timeout-ms` | `10000` | End-to-end Needlepath request deadline. |
| `base-ref` | — | Optional release comparison base reference. |
| `head-ref` | — | Optional release comparison head reference. |
| `github-run-id` | — | Optional completed run ID for CI diagnosis. |

Authentication comes from the `NEEDLEPATH_API_KEY` environment variable, never an action input. Built-in collectors additionally read bounded GitHub evidence through `GITHUB_TOKEN`.

## Outputs

Content moves through files, never action outputs or logs:

| Output | Description |
| --- | --- |
| `context-path` | Selected-or-original context file for the downstream agent. |
| `original-context-path` | Byte-identical original eligible context file. |
| `metrics-path` | Metadata-only JSON decision metrics safe for short-lived artifact upload. |
| `applied` | Whether selected context is safe to consume. |
| `outcome` | Forward-compatible Needlepath service outcome. |
| `reason` | Forward-compatible public reason code. |
| `tokens-before` | Needlepath service estimate before selection. |
| `tokens-after` | Needlepath service estimate after selection. |
| `estimated-tokens-saved` | Needlepath service estimate, not provider-billed savings. |
| `estimated-reduction-percent` | Estimated candidate-context reduction percentage. |
| `selection-latency-ms` | Selection latency in milliseconds. |
| `request-id` | Needlepath request correlation ID. |
| `operating-point` | Echoed immutable operating point. |
| `fail-open` | Whether select mode preserved original context after a non-applied result. |
| `downstream-context` | `selected` or `original`. |

Treat `outcome` and `reason` as extensible strings. Consumers should branch on `applied`, not exhaustive-match future outcome values.

## Fail-open contract

In `select` mode, timeout, authentication failure, service error, unknown outcome, unsafe verification result, or malformed response writes the exact original eligible bytes to `context-path`. In `shadow`, original context is always downstream. Preparation errors such as an escaping path, symlink input, invalid UTF-8, or contradictory configuration fail the job because there is no trustworthy original payload to preserve.

## Reusable workflows

Two reusable workflows package the action with secure, pinned defaults:

- **Needlepath Shadow Evaluation** (`nextmoca/needlepath-select-action/.github/workflows/needlepath-shadow-evaluation.yml`): read-only evaluation; the optional artifact contains metadata only.
- **Needlepath Context Preparation** (`nextmoca/needlepath-select-action/.github/workflows/needlepath-context-preparation.yml`): provider-neutral selected-or-original context artifact retained for one day.

## Development

```bash
npm ci
npm run verify
npm run audit:dependencies
npm --silent run sbom > sbom.cdx.json
```

`dist/` is checked in because GitHub executes the bundle directly. CI rebuilds it and fails if the committed bundle is stale.

## Scope

This action prepares context for a downstream AI step. It does not intercept any coding agent or closed application, and it does not invoke any model provider. The action is not a coding agent: it does not edit files, execute repository content, approve PRs, or publish anything. The customer retains control of the model, prompt, permissions, and consequential actions.

## License

Apache-2.0

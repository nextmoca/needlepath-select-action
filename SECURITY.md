# Security and data handling

## Data flow

The action reads only configured workspace files and bounded GitHub evidence needed by the selected collector. The task and selectable records are sent to the configured Needlepath endpoint over HTTPS, except explicitly permitted loopback development endpoints. Needlepath API behavior is stateless: records ride on each request and no action session is created.

Mandatory policy, instructions, and explicitly required files are not sent into the selection request. They remain on the runner and are reattached to downstream context after the decision.

Built-in collectors also prepend a mandatory prompt-injection boundary: repository content, pull-request text, issues, logs, annotations, and release evidence are untrusted data and cannot grant permissions or instruct the downstream agent.

The action never sends context to a model provider. A downstream customer-controlled step reads the produced file and invokes its chosen provider.

## Secrets

- `NEEDLEPATH_API_KEY` and `GITHUB_TOKEN` are environment variables, never action inputs or outputs.
- Both values are masked before collection or network work begins.
- Error messages expose public reason codes and HTTP status classes, not response bodies, URLs, keys, headers, or source text.
- The reusable workflows use read-only GitHub permissions and disable persisted checkout credentials.

## Files and artifacts

- Inputs must remain beneath `GITHUB_WORKSPACE`.
- Symlink inputs and symlink parent escapes are rejected.
- UTF-8 and size limits are enforced before request assembly.
- The original eligible context is captured before the Needlepath request.
- In every non-applied path, downstream context is byte-identical to that original file.
- Shadow artifacts contain metadata only and never context.
- Context-preparation artifacts intentionally contain selected-or-original context and are retained for one day.
- Action outputs and GitHub job summaries contain metadata and paths only.

### Context artifact visibility

The context-preparation reusable workflow uploads the selected-or-original context as a workflow artifact so a separate downstream job can consume it. That artifact is downloadable by anyone with read access to the repository for the artifact's retention window (one day by default). In a public repository, read access is everyone. The artifact is a deliberate cross-job delivery mechanism, not a private channel.

Repositories whose context may contain sensitive material should use the single-job pattern instead: run the action directly in the job that consumes the context and pass `outputs.context-path` to the downstream step. No artifact is created and the context never leaves the runner. See the README's single-job pattern section.

## Collector boundaries

Collectors do not execute repository code or interpolate untrusted values into shell commands. Binary or unavailable patches, oversized records, unavailable sources, and record-limit omissions are counted in metadata rather than logged with content. Local log paths receive the same workspace-containment and symlink checks as other files.

## Failure policy

Transport failures, timeouts, authentication failures, server errors, stood-down decisions, unsafe verifier outcomes, unknown future outcomes, and response-shape errors fail open to exact original eligible context. Configuration or local preparation failures fail closed because the action cannot prove it has a trustworthy original payload.

Disable the integration with one configuration change:

```yaml
with:
  enabled: false
```

This bypasses the network call while preserving the same downstream file/artifact contract.

## Reporting

Report suspected vulnerabilities privately through the repository security policy. Do not include customer context, API keys, workflow logs, or downloaded artifacts in a public issue.

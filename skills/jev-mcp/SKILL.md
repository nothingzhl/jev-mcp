---
name: jev-mcp-routing
description: Route explicit coding-agent materials to the appropriate Jev judgment tool and handle uncertain results conservatively.
---

# Jev MCP routing

Use Jev when a task needs a structured judgment over material that the caller has already collected. Jev supplies a judgment and probabilities; Codex remains responsible for reading files, running commands, making edits, and deciding what action to take.

## When to call Jev

- Use `jev_rank_candidates` when several explicitly supplied files, code fragments, documents, or other materials need to be ordered by relevance to an investigation.
- Use `jev_verify_claims` when an explicitly supplied claim must be checked against the evidence supplied for that claim.
- Use `jev_triage_failure` when an explicitly supplied command, log, and optional change summary need a conservative failure category.
- Use `jev_run_recipe` when the caller needs the registered recipe interface by ID. Its `recipeId` must be one of `rank-candidates`, `verify-claims`, or `triage-failure`; use `dryRun: true` to inspect the prepared request without a model call.

Collect only the smallest relevant material first. Keep candidates and evidence associated with their original IDs. If the needed material has not been collected, collect it with normal Codex tools before calling Jev.

## When not to call Jev

Do not call it for ordinary code writing, simple questions, formatting, or decisions that do not need a judgment over supplied material. Do not use it to scan a repository, discover files, run tests or builds, inspect a browser, modify code, deploy, or publish. Codex must perform those operations directly and then may pass their explicit results to `jev_verify_claims` or `jev_triage_failure`.

## Inputs and tool choice

`jev_rank_candidates` expects:

```json
{
  "task": "what is being investigated",
  "candidates": [
    { "id": "a", "title": "file.ts", "content": "explicit excerpt" }
  ]
}
```

`jev_verify_claims` expects claims with their own evidence:

```json
{
  "claims": [
    { "id": "c1", "claim": "the stated outcome", "evidence": "explicit evidence" }
  ]
}
```

`jev_triage_failure` expects:

```json
{
  "command": "the command that failed",
  "log": "the relevant log",
  "changeSummary": "optional summary of the change"
}
```

Do not pass arbitrary model questions, credentials, whole repository paths, or material that Jev was not asked to judge. `jev_run_recipe` accepts only a registered `recipeId`, an input matching that recipe, and its optional `dryRun` flag.

## Interpreting results

Treat `requiresReview: true`, `insufficient`, and `unknown` as uncertainty signals, never as facts or permission to act. Inspect the underlying material and make the final decision yourself.

- For ranking, preserve all candidates and use low-confidence results to guide manual inspection.
- For claim verification, `supported` is a model judgment about the supplied evidence. Missing or insufficient evidence requires review; it does not establish that the claim is false or true.
- For failure triage, `unknown` or insufficient evidence must not trigger a retry, code change, deployment, or other automatic action.

The thresholds in each recipe are initial heuristics and have not been calibrated against representative labeled data.

## Failure hook

The repository includes `hooks/jev-failure-triage.mjs` as a host hook adapter. Map the host's post-failure event to its stdin with only the failed command, captured log, and optional change summary; see `examples/codex-failure-triage-hook.json`. The default mode makes no model call and returns `unknown`, `evidenceSufficient: false`, and `requiresReview: true`. Passing `--live` is an explicit opt-in to call the local `jev run triage-failure` CLI. The hook never retries, runs another command, edits code, deploys, publishes, or pushes.

## Safety boundary

Jev does not replace tests, builds, code review, code changes, deployment, or package publication. It only judges material explicitly included in the request. Do not place API keys or other secrets in input. The TypeSafe key is read by the server from `TYPESAFE_API_KEY`; it must never be passed as a tool argument or written to output or SQLite metadata.

## Codex setup

The project requires Node.js `>=22.16` and recommends Node 24. Install the published package with:

```sh
npm install -g jev-judgment-mcp
```

Use this stdio MCP entry in the Codex configuration:

```toml
[mcp_servers.jev]
command = "jev-mcp"
args = []
env_vars = ["TYPESAFE_API_KEY", "JEV_MODEL", "JEV_DB_PATH", "JEV_TIMEOUT_MS", "JEV_MAX_RETRIES"]
startup_timeout_sec = 20
tool_timeout_sec = 150
```

For a source checkout, run `npm ci` and `npm run build`, then set `command = "node"`, `args = ["/absolute/path/to/jev-mcp/dist/mcp.js"]`, and `cwd` to the checkout. The supported environment variables are `TYPESAFE_API_KEY`, `JEV_MODEL`, `JEV_DB_PATH`, `JEV_TIMEOUT_MS`, and `JEV_MAX_RETRIES`. The project does not automatically load `.env` files.

Verify installation without a key or network call:

```sh
jev recipes
jev doctor
jev run rank-candidates --input examples/rank-candidates.json --dry-run
```

`jev doctor` reports whether a key is present; it does not validate the key. A live call requires `TYPESAFE_API_KEY` in the server environment and sends the explicitly supplied material to TypeSafe.

## Implemented versus unverified

Implemented and covered by the repository's offline checks: the three versioned recipe schemas and mappings, the four registered MCP tools, CLI and stdio entrypoints, dry-run planning, TypeSafe SDK adapter, timeout and SDK retry handling, response validation, bounded concurrency and queueing, SQLite run metadata, and synthetic tests.

Not verified here: live TypeSafe model quality, threshold calibration, and production API behavior with a real key. The planned JSON/JSONL evaluation runner, model/recipe comparison CLI, console, input collection adapters, result cache, and HTTP team service are not implemented in this version.


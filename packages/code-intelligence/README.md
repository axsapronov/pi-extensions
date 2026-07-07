# pi-code-intelligence

Local codebase graph, semantic search, repository learnings, and structured review tools for Pi.

## Why

Coding agents are fastest when they do not have to rediscover the same codebase facts on every turn. In larger projects, useful context is spread across callers, imports, tests, route files, schemas, generated code, conventions, and prior feedback. Without a local memory and graph, an agent can waste time grepping broadly, miss important related files, or produce review comments that are plausible but not grounded in the actual codebase.

`pi-code-intelligence` gives Pi a local, persistent understanding of a repository. It indexes code once, keeps the index fresh, retrieves relevant context automatically, and remembers repo-specific guidance as learnings and hard rules. The goal is to make everyday implementation, debugging, and review workflows faster and more accurate by giving the agent the right local context before it plans or edits.

This is especially useful for:

- Finding related code without broad exploratory searches
- Understanding how a changed file affects callers, tests, routes, screens, and similar implementations
- Catching review issues that require cross-file context
- Enforcing local conventions and lessons learned from prior feedback
- Reducing repeated explanations about repo-specific patterns

## What it does

At a high level, the extension adds local code intelligence to Pi:

- **Repository indexing**: scans eligible source files, chunks code, records file metadata, and keeps the index updated with a file watcher.
- **Code graph extraction**: stores declarations, imports, file relationships, source/test counterparts, route/screen relationships, call/render/hook relationships, and similar-code relationships.
- **Hybrid retrieval**: combines lexical search, semantic embeddings, working-set files, graph context, and source/test counterparts to retrieve compact context for the agent.
- **Automatic planning context**: injects relevant code, graph summaries, hard rules, and learnings into non-trivial agent turns so the agent can use local context silently before acting.
- **Structured review**: `/code-intelligence-review` performs graph-aware review over changed files or a selected scope, with severity-ranked findings, coverage, readiness scoring, and an interactive review panel.
- **Impact and test analysis**: tools and commands surface likely callers/callees, imports/imported-by files, tests, counterparts, and likely missing test coverage.
- **Repo learnings**: captures durable user guidance and review feedback into scoped learnings, retrieves them in future context, and can derive machine-checkable hard rules from high-confidence learnings.
- **Learning management UI**: `/code-intelligence-learnings` opens a table view for reviewing, activating, demoting, or rejecting stored learnings.
- **Local storage and models**: stores data in local SQLite databases and uses local embedding models when available, with FTS fallback when embeddings are unavailable.
- **Operational visibility**: dashboard, doctor, debug, and progress UI commands show indexing state, embedding status, graph stats, and setup health.

## Code Review

This is the main feature I originally built the extension for. I was becoming sick of the push/fix/push/fix loop with AI review tools, so I built something based on what I know about how the best ones work.

Running `/code-intelligence-review` will:

- Identify changed files, either from unstaged, or the whole branch diff if there are no unstaged changes (or the whole repo if on `main`/`master`).
- Retrieve relevant context for the changed files, including related files from the code graph, test counterparts, and relevant learnings.
- Perform a structured review with severity-ranked findings, grouped by file and category, and provide an overall review summary with a readiness score.
- Open an interactive review panel where you can mark things as useful or not, and auto-fix.

## Install from npm

```bash
pi install npm:pi-codeontime-code-intelligence
```

Then reload Pi and enable code intelligence in a repo:

```text
/reload
/code-intelligence-doctor
/enable-code-intelligence
```

## Configuration (optional)

Code intelligence merges settings from multiple sources (later sources override earlier ones):

1. Built-in defaults
2. Repo `.gitignore` exclude patterns
3. Global `~/.pi/agent/code-intelligence.json`
4. Repo `.pi-code-intelligence.json`
5. Repo `.pi/code-intelligence.json`

Global config follows Pi's agent directory layout (`~/.pi/agent`, overridable via `PI_CODING_AGENT_DIR` or `PI_AGENT_DIR`). Per-repo files in `.pi/` override global settings for that repository.

Both repo paths are supported; if both exist, `.pi/code-intelligence.json` wins over `.pi-code-intelligence.json`.

### Global config (all repos)

Put shared settings (for example a remote embedding endpoint) in `~/.pi/agent/code-intelligence.json`:

```json
{
  "autoEnable": true,
  "embedding": {
    "provider": "openai-compatible",
    "baseUrl": "http://localhost:11434/v1",
    "model": "nomic-embed-text",
    "batchSize": 64
  }
}
```

With `autoEnable: true`, code intelligence enables itself on session start (same effect as `/enable-code-intelligence`) and begins indexing. Default is `false` — enable manually once per repo, or set `autoEnable` globally.

Repo-local `.pi/code-intelligence.json` can override any of these fields for a single project (for example `"autoEnable": false` to opt out).

### Per-repo config

By default, code intelligence uses a local ONNX embedding model (no network required). You can switch to a remote OpenAI-compatible provider or disable embeddings entirely:

#### Local (default)

Runs embeddings locally via `@huggingface/transformers`. No configuration required.

```json
{
  "embedding": {
    "provider": "local",
    "model": "onnx-community/bge-small-en-v1.5-ONNX",
    "batchSize": 32
  }
}
```

#### OpenAI-compatible

Connects to any `/v1/embeddings` endpoint (OpenAI, Ollama, vLLM, etc.). The provider auto-detects embedding dimensions on first request unless `dimensions` is set explicitly.

```json
{
  "embedding": {
    "provider": "openai-compatible",
    "baseUrl": "http://localhost:11434/v1",
    "model": "nomic-embed-text",
    "apiKey": "",
    "dimensions": 768,
    "batchSize": 64,
    "timeoutMs": 30000,
    "maxRetries": 3
  }
}
```

#### Disabled

Disables embeddings entirely; retrieval falls back to full-text search only.

```json
{
  "embedding": {
    "provider": "disabled"
  }
}
```

### Other options

- `autoEnable` — when `true`, enable code intelligence automatically on session start (default `false`).
- `indexing.include` / `indexing.exclude` — glob patterns to control which files are indexed.

### Windows file watcher

The repository file watcher is scoped to the git root. Symlinks are not followed, and permission errors (`EPERM` / `EACCES`) on protected system folders are ignored so Pi does not crash when Windows blocks access to paths such as `AppData\Local\ElevatedDiagnostics`.

## Runtime dependencies

This package is self-contained.

Optional integrations:

- If a `subagent_run` tool is active, `/code-intelligence-review` will use it for batched review fan-out.
- If `subagent_run` is not active, `/code-intelligence-review` automatically falls back to a direct single-agent review flow.

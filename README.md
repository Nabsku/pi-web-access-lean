# Pi Web Access Lean

Web search, code search, URL fetching, GitHub repository cloning, and PDF extraction for Pi Coding Agent.

**Fork of [nicobailon/pi-web-access](https://github.com/nicobailon/pi-web-access). Full credit for the original extension, feature design, and implementation goes to the upstream project and its author.**

This fork keeps the web-access tools that are commonly useful in coding-agent sessions and keeps the tool surface small.

## Upstream credit

This repository is a lean fork of the original [`pi-web-access`](https://github.com/nicobailon/pi-web-access) extension by [Nico Bailon](https://github.com/nicobailon).

The original extension includes the broader feature set: web search, content extraction, curator workflow, Gemini/Web fallback paths, YouTube/video understanding, and related tooling. This fork intentionally removes parts of that surface for a smaller Pi Coding Agent footprint; it is not a replacement for the full upstream package.

## Features

- `web_search`: web search through Exa or Perplexity
- `code_search`: code, documentation, and API search through Exa MCP code context, with fallback search
- `fetch_content`: readable markdown extraction for URLs
- GitHub repository handling: clone repositories locally instead of scraping rendered HTML
- PDF extraction: extract text PDFs and save markdown output
- HTML extraction: Readability, Next.js RSC parsing, and Cloudflare challenge detection
- Activity widget for request/response visibility

## Design

Pi loads extension tool schemas into the agent context. Large schemas and rarely used workflows increase every prompt, including prompts that never use web access.

This package is built around a smaller default surface:

- three tools: search, code search, fetch content
- no interactive search-review workflow
- no browser-cookie handling
- no video processing pipeline
- no provider paths that require unrelated credentials
- concise tool descriptions

The result is a smaller extension footprint while preserving the main web and code-research paths used by a coding agent.

## Benchmarks

Measurement command shape:

```bash
PI_CODING_AGENT_DIR="$TMP" \
pi -p --no-session \
  --no-skills --no-context-files --no-prompt-templates --no-themes \
  --mode json \
  --model openai-codex/gpt-5.5 \
  --thinking minimal \
  "Reply exactly OK"
```

Measured extension input-token footprint:

- Original `pi-web-access`: **+1,180 input tokens**
- `pi-web-access-lean`: **+302 input tokens**
- Reduction: **878 input tokens**

## Install

From npm:

```bash
pi install npm:pi-web-access-lean
```

Or add it to Pi settings:

```json
{
  "packages": ["npm:pi-web-access-lean"]
}
```

From GitHub:

```bash
pi install git:github.com/Nabsku/pi-web-access-lean
```

From a local checkout, useful while developing:

```bash
git clone https://github.com/Nabsku/pi-web-access-lean.git
pi install /path/to/pi-web-access-lean
```

Requires Pi Coding Agent with extension support.

## Configuration

Configuration is read from `~/.pi/web-search.json`. All fields are optional.

```json
{
  "exaApiKey": "exa-...",
  "perplexityApiKey": "pplx-...",
  "provider": "auto",
  "githubClone": {
    "enabled": true,
    "maxRepoSizeMB": 350,
    "cloneTimeoutSeconds": 30,
    "clonePath": "/tmp/pi-github-repos"
  },
  "shortcuts": {
    "activity": "ctrl+shift+w"
  }
}
```

Provider selection:

- `auto`: Exa first, then Perplexity when configured
- `exa`: Exa only
- `perplexity`: Perplexity only

Named selections stay strict, including configured providers. Only `auto` can
switch providers after an ordinary failure or a response with neither an answer
nor sources; if no provider returns content, it returns the first empty success.
Batches remain serial and keep input order; cancellation stops remaining queries.

Perplexity's Sonar HTTP requests have a 30-second deadline, including response
body reads, starting after credential resolution. Exceeding it reports the budget
and elapsed time with retry guidance; it is an ordinary per-query failure, not
caller cancellation. This retained deadline is a policy, not a measured provider
latency guarantee.

Environment variables take precedence where supported:

- `EXA_API_KEY`
- `PERPLEXITY_API_KEY`

`exaApiKey` and `perplexityApiKey` also accept Pi-style credential sources. Use
`$NAME` or `${NAME}` to read a named environment variable, prefix a trusted
local command with `!` to resolve it at request time, or escape a literal
leading marker as `$$` / `$!`. Resolver commands run with a five-second timeout,
a 16 KiB output limit, and a minimized environment; `OP_SESSION_*` variables are
forwarded for shell-local 1Password sessions. Command text, stderr, and resolved
credentials are not included in provider errors.

Configured Exa API keys use Exa's account limits directly. Any legacy
`~/.pi/exa-usage.json` file is ignored and left untouched.

Keyed Exa searches use `/search` and build answers from source highlights.
Keyless searches use the advanced MCP tool for domain/recency filters or
`includeContent`. If that tool is missing, basic MCP search uses best-effort
query hints instead of strict filters. Other errors are not retried through
the basic tool.

## Tools

### `web_search`

Search the web and return an answer with sources.

```typescript
web_search({ query: "TypeScript best practices 2026" })
web_search({ queries: ["query 1", "query 2"] })
web_search({ query: "AI agent observability", recencyFilter: "week" })
web_search({ query: "React Server Components", domainFilter: ["react.dev"] })
web_search({ query: "Pi Coding Agent extensions", provider: "exa" })
web_search({ query: "benchmark result", includeContent: true })
```

Parameters:

- `query` / `queries`: single query or batch of queries
- `numResults`: integer results per query from `1` to `20`, default `5`; Sonar preserves the
  available source prefix through its highest answer citation, even beyond this count
- `recencyFilter`: `day`, `week`, `month`, or `year`
- `domainFilter`: domains to include; prefix with `-` to exclude
- `provider`: `auto`, `exa`, or `perplexity`
- `includeContent`: return provider page text and fetch uncovered result URLs inline

Provider page bodies are kept rather than refetched, with inline data URIs omitted
as described below. Only uncovered URLs are fetched. When gaps
are filled, content follows first-seen source-URL order, retaining every body for
a repeated URL; fully covered batches keep their existing order. Fetch failures
appear inline for the affected URL.

A singular `query` containing a JSON array of strings expands into serial queries;
mixed or malformed array text stays literal. Structured `queries` takes precedence.
`queries` and `domainFilter` also accept JSON-encoded string arrays from model bridges;
malformed JSON and wrongly typed lists fail before searching. Providers remain singular.

### `code_search`

Search for code examples, documentation, APIs, and debugging references.

Uses Exa MCP `code-context` when available. Falls back to code-focused web search.

```typescript
code_search({ query: "React useEffect cleanup pattern" })
code_search({ query: "Express middleware error handling", maxTokens: 10000 })
```

Parameters:

- `query`: programming question, API, library, or debugging topic
- `maxTokens`: context budget, default `5000`, max `50000`

### `fetch_content`

Fetch URLs and extract readable content as markdown.

```typescript
fetch_content({ url: "https://example.com/article" })
fetch_content({ urls: ["https://a.example", "https://b.example"] })
fetch_content({ url: "https://github.com/owner/repo" })
fetch_content({ url: "https://example.com/report.pdf" })
```

Parameters:

- `url` / `urls`: single URL/path or multiple URLs
- `forceClone`: clone GitHub repositories that exceed the size threshold

URLs are trimmed and deduplicated in input order. Nonblank `urls` takes precedence;
an empty or all-blank list falls back to `url`. Execution and call rendering agree.

GitHub clones use private per-session directories inside `githubClone.clonePath`.
Requests in the same session reuse a repository/ref checkout, and `/tree` keeps it.
Closing or replacing the session (new, resume, fork, or reload) removes only its own
clones. Paths in old transcripts can expire; call `fetch_content` again to refresh them.

Crash cleanup removes a stale runtime only when its local boot identity matches and
its owner PID is absent. Unknown, live, legacy, and symlink entries are preserved.
On platforms without reliable boot identity, including Windows, stale runtimes need
manual cleanup after verifying they are unused.

## Extraction flow

```text
web_search(query)
  → Exa direct API or MCP
  → Perplexity, when configured

fetch_content(url)
  → GitHub URL? clone repository or use GitHub API fallback
  → HTTP fetch
      → Cloudflare challenge? report failure
      → PDF? extract text, save markdown to ~/Downloads/
      → HTML? Readability → RSC parser
      → text/json/markdown? return directly
```

Challenge pages are reported as fetch failures, not returned as article content.
This fork has no Jina Reader or other hosted page-extraction fallback. If direct
extraction fails, use `web_search` for another source or open the page in a browser.

Weak HTML extraction can recover useful content from embedded Next.js RSC data.
Inline `data:` URIs in fetched page text and derived titles, and in provider-supplied
page bodies, are replaced with omission markers containing MIME type, encoding,
byte counts and a SHA-256 digest;
the payload is not retained. Surrounding prose and image alt text are preserved.
The existing 30,000-code-unit per-body slice keeps surrogate pairs whole. Search
answers and `code_search` output are unchanged; download the source directly if
you need an omitted payload or truncated tail.

## Commands

### Activity monitor

Toggle with **Ctrl+Shift+W** to see live request/response activity:

```text
─── Web Search Activity ────────────────────────────────────
  API  "typescript best practices"     200    2.1s ✓
  GET  docs.example.com/article        200    0.8s ✓
  GET  blog.example.com/post           404    0.3s ✗
────────────────────────────────────────────────────────────
```

## Development

```bash
npm ci
npm test
npm run typecheck
```

GitHub Actions runs these checks on Node 22 and Ubuntu for ready pull requests
and pushes to `main`. Draft pull requests skip the validation job.

## Files

- `index.ts`: extension entry, tools, activity widget
- `search.ts`: search routing for Exa and Perplexity
- `code-search.ts`: code/docs search via Exa MCP
- `extract.ts`: URL/path routing, HTTP extraction, fallback orchestration
- `github-extract.ts`: GitHub URL parsing, clone cache, content generation
- `github-api.ts`: GitHub API fallback for large repositories and commit SHAs
- `exa.ts`: Exa search provider, direct API and MCP proxy
- `perplexity.ts`: Perplexity API client with rate limiting
- `pdf-extract.ts`: PDF text extraction, saves markdown output
- `rsc-extract.ts`: RSC flight data parser for Next.js pages
- `utils.ts`: shared formatting and error helpers
- `activity.ts`: activity tracking widget

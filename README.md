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
- HTML extraction: Readability, Next.js RSC parsing, and Jina Reader fallback
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

From a local checkout:

```bash
pi install /path/to/pi-web-access-lean
```

Or add it to Pi settings:

```json
{
  "packages": ["/path/to/pi-web-access-lean"]
}
```

Requires Pi v0.37.3+.

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

Environment variables take precedence where supported:

- `EXA_API_KEY`
- `PERPLEXITY_API_KEY`

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
- `numResults`: results per query, default `5`, max `20`
- `recencyFilter`: `day`, `week`, `month`, or `year`
- `domainFilter`: domains to include; prefix with `-` to exclude
- `provider`: `auto`, `exa`, or `perplexity`
- `includeContent`: fetch page content for results in the background

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

## Extraction flow

```text
web_search(query)
  → Exa direct API or MCP
  → Perplexity, when configured

fetch_content(url)
  → GitHub URL? clone repository or use GitHub API fallback
  → HTTP fetch
      → PDF? extract text, save markdown to ~/Downloads/
      → HTML? Readability → RSC parser → Jina Reader fallback
      → text/json/markdown? return directly
```

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
npm install
npm test
```

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

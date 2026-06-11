# Upstream sync policy

This fork tracks [`nicobailon/pi-web-access`](https://github.com/nicobailon/pi-web-access) manually. The GitHub Action is report-only: it compares upstream changes, classifies likely relevant vs likely skipped work, and opens or updates an issue. It never merges, cherry-picks, pushes, publishes, or changes dependencies by itself.

## Automation

Workflow: `.github/workflows/upstream-sync.yml`

Schedule:

- Weekly Monday run.
- Manual `workflow_dispatch` with optional `upstream_ref` and `create_issue` inputs.

State file: `.github/upstream-sync.json`

The action reads `lastReviewedSha` from the state file and diffs that SHA against the selected upstream ref. After a human reviews/imports upstream changes, update:

```json
{
  "lastReviewedSha": "<reviewed upstream head>",
  "lastReviewedAt": "<UTC timestamp>"
}
```

## What counts as relevant

Review upstream commits that touch the retained lean surface:

- `index.ts`
- `search.ts`
- `code-search.ts`
- `exa.ts`
- `perplexity.ts`
- `extract.ts`
- `github-extract.ts`
- `github-api.ts`
- `pdf-extract.ts`
- `rsc-extract.ts`
- `activity.ts`
- `utils.ts`
- `test/**`
- `package.json` / `package-lock.json`
- `README.md` / `CHANGELOG.md`

Relevant change types:

- Pi SDK compatibility updates.
- Exa or Perplexity provider fixes.
- `web_search`, `code_search`, or `fetch_content` fixes.
- GitHub extraction security/compat fixes.
- PDF/HTML/RSC/Jina extraction fixes.
- Activity widget fixes.
- Dependency/security fixes needed by retained code.

## What to skip by default

Skip upstream work that restores removed broad-surface features unless explicitly reapproved:

- curator/review UI
- summary-review server/page flows
- Gemini API/Web fallback
- browser-cookie or Chrome profile access
- YouTube/video/local media extraction
- stored-content retrieval
- demo media/assets
- verbose schemas/prompts that grow default tool context

## Manual import flow

Add upstream remote if missing:

```bash
git remote add upstream https://github.com/nicobailon/pi-web-access.git || true
git fetch upstream --tags
```

Create an import branch:

```bash
git checkout -b chore/import-upstream-YYYY-MM-DD
```

Inspect report candidates, then import only selected commits or hunks:

```bash
git log --oneline <lastReviewedSha>..upstream/main
git cherry-pick -n <sha>
# remove unwanted hunks/files before commit
```

Validate candidate branch:

```bash
npm ci
npm test
npm run typecheck
```

After review is complete, update `.github/upstream-sync.json` to the upstream head that was reviewed, even if every upstream commit was intentionally skipped. Commit that metadata update with the import or skip decision.

## Guardrails

- No auto-merge from upstream.
- No auto-cherry-pick into default branch.
- No restoration of removed upstream features without explicit decision.
- No lockfile or dependency updates unless selected upstream fix requires them.
- No publishing/release automation.
- Use only default `GITHUB_TOKEN` for sync reports.

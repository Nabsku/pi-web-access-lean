# Agent instructions

## Pull requests

- Start PR branches from a freshly fetched, recorded `origin/main` in an isolated worktree; preserve unrelated work.
- Before drafting or updating a PR, use `visual-pr` with its `show-me` reference and follow the [PR template](.github/pull_request_template.md). A structural outline is required for non-UI changes too.
- Present the proposed title, body and scope for explicit user approval before committing, pushing or publishing the PR.
- Verify the final publication source with the smallest affected checks from `package.json`. Record its source state, commands, results and gaps as the template requests; review evidence must match that source state.
- After approval, create a draft PR. Obtain separate authorization before marking it ready, merging, releasing or deploying.

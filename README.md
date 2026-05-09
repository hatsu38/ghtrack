# ghtrack

**English** | [日本語](README.ja.md)

A GitHub Action that records the execution time of each workflow run into your `gh-pages` branch on every run (in development: v0.1.0 prototype).

The goal is to apply the real-time accumulation pattern of `benchmark-action/github-action-benchmark` to workflow / step duration instead of benchmark values.

## Status

**v0.1.0 prototype**: collects job / step duration of a workflow run, appends it to `data/data.json` on the `gh-pages` branch, and bundles a Chart.js-powered `index.html` at the root of the same branch. Once GitHub Pages is enabled for the repository, the time-series charts are visible in the browser.

**🌐 Live demo**: https://hatsu38.github.io/ghtrack/  ← this repo's own dogfood

## Usage

Add this Action to the end of any workflow in the repository. If the `gh-pages` branch does not exist, an orphan branch is created automatically on the first run.

```yaml
# .github/workflows/your-workflow.yml
name: build

on:
  push:
    branches: [main]

# Recommended: reduce concurrent push contention to the same branch
# (retries also handle this, but reducing contention itself is cleaner).
concurrency:
  group: ghtrack-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - run: echo "build something"

  track:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      contents: write   # required to push to gh-pages
      actions: read     # required to fetch workflow run / job APIs
    steps:
      - uses: hatsu38/ghtrack@main
```

## Inputs

All optional. The intent is that defaults are enough to start accumulating data into your repo's `gh-pages` branch out of the box.

| name | default | description |
| --- | --- | --- |
| `github-token` | `${{ github.token }}` | used to fetch workflow run / job data and to push to gh-pages. Requires `contents: write` |
| `gh-pages-branch` | `gh-pages` | branch where the data is accumulated |
| `data-file-path` | `data/data.json` | JSON file path inside the branch |
| `auto-push` | `true` | when `false`, the entry is collected and logged but not pushed |
| `auto-create-branch` | `true` | creates the branch as orphan if it does not exist. When `false`, fails explicitly instead |
| `max-items-in-history` | (unlimited) | a positive integer truncates the entries array to the last N items. Workaround for the Contents API 1MB limit |
| `skip-fork-pr` | `true` | skip pushing on `pull_request` from forks (the `GITHUB_TOKEN` of fork PRs has no write permission) |

## Schema of the accumulated JSON

```jsonc
{
  "schema_version": 1,
  "entries": [
    {
      "schema_version": 1,
      "commit": "abc123...",
      "branch": "main",
      "event": "push",
      "date": 1714397040000,         // Unix ms
      "workflow": "test",
      "workflow_file": "test.yml",
      "run_id": 25113290762,
      "run_attempt": 1,
      "total_duration_sec": 17.3,
      "jobs": [
        {
          "name": "build",
          "duration_sec": 14.2,
          "status": "completed",
          "conclusion": "success",
          "steps": [
            { "name": "Set up job", "number": 1, "duration_sec": 0.5, "status": "completed", "conclusion": "success" }
          ]
        }
      ]
    }
  ]
}
```

A `duration_sec` of `null` means the step is incomplete (because the run is observing itself, the final step of the `track` job is always recorded as incomplete).

## Accumulating from multiple workflows into the same repo

Splitting `data-file-path` per workflow lets you view data from multiple workflows on a single dashboard, even when job names collide.

```yaml
# .github/workflows/unit-test.yml
- uses: hatsu38/ghtrack@<sha>
  with:
    data-file-path: data/unit-test.json

# .github/workflows/e2e-likes.yml
- uses: hatsu38/ghtrack@<sha>
  with:
    data-file-path: data/e2e-likes.json
```

In this mode, `data/manifest.json` is auto-generated on `gh-pages` and tracks every registered path:

```jsonc
{
  "schema_version": 1,
  "sources": [
    { "path": "data/unit-test.json", "first_seen": 1714397040000 },
    { "path": "data/e2e-likes.json", "first_seen": 1714397100000 }
  ]
}
```

The dashboard (`index.html`) reads the manifest, fetches every path in parallel, and renders **a separate dataset per workflow**. The Per-job chart uses `${workflow_file}::${job.name}` as the key, so identically-named jobs (e.g. `e2e_test`) across multiple workflows do not get merged into one line.

If the manifest is missing (older `gh-pages`), it falls back to reading `data/data.json` only, so existing users do not see broken output.

## Visualization (GitHub Pages)

On every run, the Action bundles `index.html` at the root of the `gh-pages` branch (auto-syncs if it changed). It loads Chart.js v4 + the date-fns adapter from a CDN (jsDelivr), fetches the data via `fetch('./data/data.json')`, and renders two time-series charts:

- **Total duration per run**: a line chart of each run's `total_duration_sec`
- **Per-job duration**: a line chart with one dataset per job name. matrix permutations (`name (N)` / `name (N, M)` form) are aggregated under the base name by default, and **max(matrix node duration)** is shown for each run (the bottleneck node that determines wall-clock under parallel execution). A checkbox above the chart lets you expand the matrix into individual nodes (the setting is persisted in `localStorage`).

Light / dark theming follows `prefers-color-scheme`. Layout is responsive with `viewport` meta + `max-width: 960px`.

The dashboard UI defaults to English. When `navigator.language` starts with `ja`, labels and headings switch to Japanese automatically.

### How to publish

1. Make the repository **public** (or enable Pages on a GitHub Pro plan or higher)
2. **Settings → Pages**:
   - Source: **Deploy from a branch**
   - Branch: **`gh-pages`** / **`/`(root)**
3. After a few minutes, the charts appear at `https://<owner>.github.io/<repo>/`

If you only want to inspect the data, you can open `https://<owner>.github.io/<repo>/data/data.json` directly.

### Running locally

`fetch('./data/data.json')` from `index.html` does not work when opened via `file://` due to browser CORS policy (Chrome/Edge/Safari etc.). To check locally, check out the `gh-pages` branch and serve it via a local HTTP server:

```bash
# switch to the gh-pages branch (so index.html and data/data.json are at the root)
git switch gh-pages

# serve via any static server. With Node.js, npx is enough
npx serve .
# or
npx http-server -p 8000
```

Open `http://localhost:<port>/` in the browser to see the same charts as production Pages.

### Example (this repo's own dogfood)

- Dashboard: https://hatsu38.github.io/ghtrack/
- Raw JSON: https://hatsu38.github.io/ghtrack/data/data.json

## Required permissions and notes

- Always grant `contents: write` to the **`permissions:`** of the track job. Even when Repository Settings → Actions → Workflow permissions is set to "Read and write", declaring it explicitly in the workflow is recommended (so a Settings change does not silently break the action)
- `actions: read` is also required on the track job (to call workflow run APIs)
- **Runs from fork PRs**: `GITHUB_TOKEN` cannot write to the base repo, so by default (`skip-fork-pr: "true"`) the push is skipped and a `core.notice` is emitted. Entry collection and log output still run
- **Concurrent push contention**: parallel updates to the same `data/data.json` are detected by optimistic locking on `sha` and retried with exponential backoff (up to 5 times). Setting `concurrency` on the same workflow / branch is the safer way to prevent contention from happening in the first place

## Local development

```bash
pnpm install
pnpm typecheck
pnpm build   # bundle into dist/ (committed to the repo)
```

## Related projects

- [hatsu38/ghlap](https://github.com/hatsu38/ghlap) (also in development): a "post-fetch" approach that pulls past workflow runs and stores them in Supabase. `ghtrack` is the "real-time" approach that commits at the moment a run completes — they cover different use cases.

## License

MIT

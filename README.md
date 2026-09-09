# ghtrack

**English** | [日本語](README.ja.md)

A GitHub Action that records the execution time of each workflow run into your `gh-pages` branch on every run.

The goal is to apply the real-time accumulation pattern of `benchmark-action/github-action-benchmark` to workflow / step duration instead of benchmark values.

## How it works

Collects job / step duration of a workflow run and writes it as a per-run JSON file under `data/<track-name>/<YYYY>/<MM>/<DD>/<run_id>-<attempt>.json` on the `gh-pages` branch. A Chart.js-powered `index.html` is bundled at the branch root and the time-series charts are visible in the browser once GitHub Pages is enabled.

**🌐 Live demo**: https://hatsu38.github.io/ghtrack/  ← this repo's own dogfood

## Usage

Add this Action to the end of any workflow in the repository. If the `gh-pages` branch does not exist, an orphan branch is created automatically on the first run. Each workflow's data goes under `data/<workflow-file-basename>/` by default, so you can drop the Action into multiple workflows without configuring anything.

```yaml
# .github/workflows/your-workflow.yml
name: build

on:
  push:
    branches: [main]

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
| `track-name` | workflow file basename (e.g. `test.yml` → `test`) | directory name under `data/`. Must match `[a-zA-Z0-9._-]+`. Override this to split one workflow into multiple tracks (matrix shards, environments, etc.) |

## File layout on the `gh-pages` branch

```
gh-pages/
├── index.html
└── data/
    ├── manifest.json                   # workflow registry
    └── <track-name>/
        ├── index.json                  # run list for this track
        └── <YYYY>/<MM>/<DD>/
            ├── <run_id>-<attempt>.json # one file per run (the Entry)
            └── ...
```

Each per-run file is independent and append-only: a push never reads or modifies prior runs, so workflow run history scales linearly without hitting GitHub's createBlob size limit.

## Schema

### Per-run file (`<track-name>/<YYYY>/<MM>/<DD>/<run_id>-<attempt>.json`)

```jsonc
{
  "schema_version": 1,
  "commit": "abc123...",
  "branch": "main",
  "event": "push",
  "date": 1714397040000,        // Unix ms
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
```

A `duration_sec` of `null` means the step is incomplete (because the run is observing itself, the final step of the `track` job is always recorded as incomplete).

### Workflow index (`data/<track-name>/index.json`)

```jsonc
{
  "schema_version": 1,
  "track_name": "test",
  "runs": [
    { "date": "2026/05/15", "run_id": 9876543210, "run_attempt": 1 },
    { "date": "2026/05/15", "run_id": 9876543211, "run_attempt": 1 }
  ],
  "last_updated": 1714397040000
}
```

The dashboard uses `runs[]` to know which per-run files exist (GitHub Pages does not serve directory listings).

### Manifest (`data/manifest.json`)

```jsonc
{
  "schema_version": 2,
  "workflows": [
    { "track_name": "unit-test", "dir": "data/unit-test", "first_seen": 1714397040000 },
    { "track_name": "e2e-likes", "dir": "data/e2e-likes", "first_seen": 1714397100000 }
  ]
}
```

## Accumulating from multiple workflows into the same repo

Each workflow automatically stores its data under `data/<workflow-file-basename>/`. You can drop the Action into multiple workflows without configuring `track-name` and the dashboard will display each workflow as a separate dataset.

Override `track-name` when you want to split one workflow into multiple tracks (e.g. matrix shards, environments):

```yaml
- uses: hatsu38/ghtrack@<sha>
  with:
    track-name: e2e-shard-${{ matrix.shard }}
```

The dashboard reads the manifest, fetches each workflow's `index.json`, and renders **a separate dataset per workflow**. The Per-job chart uses `${workflow_file}::${job.name}` as the key, so identically-named jobs (e.g. `e2e_test`) across multiple workflows do not get merged into one line.

## Visualization (GitHub Pages)

On every run, the Action bundles `index.html` at the root of the `gh-pages` branch (auto-syncs if it changed). It loads Chart.js v4 + the date-fns adapter from a CDN (jsDelivr), reads `./data/manifest.json` and each workflow's `./data/<track>/index.json`, then fetches the per-run files that fall inside the active date range.

The default range is **Last 30 days**. Changing the range preset triggers an incremental fetch of any newly-needed per-run files (already-loaded ones are cached in memory).

Charts rendered per workflow:

- **Total duration per run**: a line chart of each run's `total_duration_sec`
- **Per-job duration**: a line chart with one dataset per job name. matrix permutations (`name (N)` / `name (N, M)` form) are aggregated under the base name by default, and **max(matrix node duration)** is shown for each run (the bottleneck node that determines wall-clock under parallel execution). A checkbox above the chart lets you expand the matrix into individual nodes (the setting is persisted in `localStorage`).

The matrix switch is beside the Job chart, while aggregation and Jobs / Steps switches are beside each chart; the settings stay synchronized across workflows.

### Period comparison

Check **Compare with previous period** (below the range controls) to see workflow-level median duration, success rate, and run count in three cards, plus one row per job with a switchable metric:

- The number of days N is derived automatically from the selected range — 7 / 30 / 90 for the matching preset, or the span between the two custom dates for "Custom…". "All time" and an incomplete custom range have no fixed length, so comparison is unavailable then (the checkbox is disabled with an explanation) — there's nothing to configure by hand.
- Presets use the last N days as the current period. A custom range uses the selected dates themselves as current, with the immediately preceding period of the same length as previous. The periods never overlap, so boundary runs are counted once.
- The workflow success-rate card includes its success/failure breakdown. The job table switches between median duration, success rate, and run count, and includes jobs present in only one period. `cancelled`, `neutral`, and unrecorded outcomes are excluded from the success-rate denominator.
- Expand a job row to inspect the other metrics and run counts. The initial order is the largest duration increase first, with missing values last.
- Respects the **Aggregate matrix** setting: when on, matrix permutations are grouped per run and the group's duration is `max(job durations)`; counts are per run, not per matrix node.
- The difference column is colored — green when duration decreased or success rate increased, red the other way, and left uncolored when nothing changed or for the run-count row (more or fewer runs isn't inherently good or bad).
- Missing data renders as "—" instead of `NaN`/`Infinity`. When the previous period's value is 0, the absolute difference is still shown but the percentage change is "—" (run counts say "no runs in previous period").
- The on/off setting is saved to `localStorage` and restored on reload.
- On narrow screens current values and changes remain prominent, while previous values stay as supporting details; the comparison table scrolls inside its own box.

Light / dark theming follows `prefers-color-scheme`. Layout is responsive with `viewport` meta + `max-width: 960px`.

The dashboard UI defaults to English. When `navigator.language` starts with `ja`, labels and headings switch to Japanese automatically.

### How to publish

1. Make the repository **public** (or enable Pages on a GitHub Pro plan or higher)
2. **Settings → Pages**:
   - Source: **Deploy from a branch**
   - Branch: **`gh-pages`** / **`/`(root)**
3. After a few minutes, the charts appear at `https://<owner>.github.io/<repo>/`

If you only want to inspect the data, you can open `https://<owner>.github.io/<repo>/data/manifest.json` directly (and follow the listed paths).

### Running locally

`fetch()` calls from `index.html` do not work when opened via `file://` due to browser CORS policy (Chrome/Edge/Safari etc.). To check locally, check out the `gh-pages` branch and serve it via a local HTTP server:

```bash
# switch to the gh-pages branch (so index.html and data/* are at the root)
git switch gh-pages

# serve via any static server. With Node.js, npx is enough
npx serve .
# or
npx http-server -p 8000
```

Open `http://localhost:<port>/` in the browser to see the same charts as production Pages.

### Example (this repo's own dogfood)

- Dashboard: https://hatsu38.github.io/ghtrack/
- Manifest: https://hatsu38.github.io/ghtrack/data/manifest.json

## Required permissions and notes

- Always grant `contents: write` to the **`permissions:`** of the track job. Even when Repository Settings → Actions → Workflow permissions is set to "Read and write", declaring it explicitly in the workflow is recommended (so a Settings change does not silently break the action)
- `actions: read` is also required on the track job (to call workflow run APIs)
- **Runs from fork PRs**: `GITHUB_TOKEN` cannot write to the base repo, so the Action exits early with a `core.notice` and does not collect or push anything
- **Concurrent push contention**: per-run files are append-only at unique paths, so they never conflict with each other. Only the per-workflow `index.json` is read-modify-write, and that small file is retried with exponential backoff + jitter (up to 10 attempts) when contended

## Migration from the v1 single-file layout

If you have an existing `gh-pages` branch that used the previous `data/<workflow>.json` (entries[] aggregated) layout, run the one-shot migration script:

```bash
# 1. back up the old gh-pages on the remote
git fetch origin gh-pages
git push origin refs/remotes/origin/gh-pages:refs/heads/gh-pages-v1-backup
git push origin --delete gh-pages

# 2. check out the backup locally
git worktree add /tmp/ghtrack-v1 gh-pages-v1-backup

# 3. run the migration script (writes the v2 tree to a new dir)
node scripts/migrate-v1-to-v2.mjs /tmp/ghtrack-v1 /tmp/ghtrack-v2

# 4. push /tmp/ghtrack-v2 as the new gh-pages
cd /tmp/ghtrack-v2
git init -b gh-pages
git add .
git commit -m "chore(ghtrack): migrate to v2 per-run file layout"
git remote add origin <repo-url>
git push origin gh-pages
```

After step 4 the next ghtrack run will append in v2 mode without further changes. The `gh-pages-v1-backup` branch can be kept or deleted later.

## Local development

```bash
pnpm install
pnpm typecheck
pnpm test    # runs tests/*.test.mjs via the built-in node:test runner
pnpm build   # bundle into dist/ (committed to the repo)
```

## License

MIT

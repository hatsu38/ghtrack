# ghtrack

[English](README.md) | **日本語**

GitHub Actions の各 workflow run の実行時間を、走るたびに `gh-pages` ブランチへ蓄積していく Action。

`benchmark-action/github-action-benchmark` のリアルタイム蓄積方式を、ベンチマーク値ではなく workflow / step の duration に応用することを目指している。

## 仕組み

workflow run の job / step duration を取得して `gh-pages` branch の `data/<track-name>/<YYYY>/<MM>/<DD>/<run_id>-<attempt>.json` (1 run = 1 ファイル) として書き出し、合わせて Chart.js 製の `index.html` を同 branch の root に同梱する。リポジトリの GitHub Pages を有効化すれば、ブラウザで時系列グラフが見える。

**🌐 Live demo**: https://hatsu38.github.io/ghtrack/  ← 本リポ自身の dogfood の実物

## 使い方

リポジトリ内の任意の workflow の最後に、本 Action を追加する。`gh-pages` branch が無ければ初回実行時に自動でオーファンブランチを作る。デフォルトでは workflow ごとに `data/<workflow-file-basename>/` 配下に蓄積されるので、複数 workflow に追加しても設定不要。

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
      contents: write   # gh-pages への push に必要
      actions: read     # workflow run / job の API 取得に必要
    steps:
      - uses: hatsu38/ghtrack@main
```

## 入力

すべて optional。デフォルトのまま自リポの `gh-pages` に蓄積されることを目指している。

| name | default | 説明 |
| --- | --- | --- |
| `github-token` | `${{ github.token }}` | workflow run / job データ取得 + gh-pages への push に使う。`contents: write` 権限が必要 |
| `gh-pages-branch` | `gh-pages` | 蓄積先のブランチ名 |
| `track-name` | workflow ファイル basename (例: `test.yml` → `test`) | `data/` 配下のディレクトリ名。`[a-zA-Z0-9._-]+` のみ許容。1 つの workflow を複数 track に分けたいとき(matrix shard / 環境別 etc.)に上書きする |

## gh-pages ブランチの構成

```
gh-pages/
├── index.html
└── data/
    ├── manifest.json                   # workflow レジストリ
    └── <track-name>/
        ├── index.json                  # この track の run 一覧
        └── <YYYY>/<MM>/<DD>/
            ├── <run_id>-<attempt>.json # 1 run につき 1 ファイル(Entry)
            └── ...
```

per-run file は独立かつ追記専用。push のたびに過去 run の読み書きは発生しないため、GitHub の createBlob サイズ上限に阻まれることなく履歴を線形にスケールさせられる。

## スキーマ

### per-run ファイル (`<track-name>/<YYYY>/<MM>/<DD>/<run_id>-<attempt>.json`)

```jsonc
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
```

`duration_sec` が `null` のステップは未完了(自分自身を観測する都合で、`track` ジョブの最終 step は常に未完了として記録される)。

### workflow インデックス (`data/<track-name>/index.json`)

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

ダッシュボードはこの `runs[]` を使って「どの per-run ファイルが存在するか」を知る(GitHub Pages はディレクトリリスティングを返さないため)。

### マニフェスト (`data/manifest.json`)

```jsonc
{
  "schema_version": 2,
  "workflows": [
    { "track_name": "unit-test", "dir": "data/unit-test", "first_seen": 1714397040000 },
    { "track_name": "e2e-likes", "dir": "data/e2e-likes", "first_seen": 1714397100000 }
  ]
}
```

## 複数 workflow から同一 repo に蓄積する

各 workflow は `data/<workflow-file-basename>/` 配下に自動で蓄積されるため、複数の workflow に Action を追加するだけで 1 つのダッシュボードにまとめて表示される (workflow ごとに別 dataset)。

1 つの workflow を複数 track に分割したい場合 (matrix shard、環境別など) は `track-name` を上書きする:

```yaml
- uses: hatsu38/ghtrack@<sha>
  with:
    track-name: e2e-shard-${{ matrix.shard }}
```

ダッシュボードは manifest と各 workflow の `index.json` を読み、**workflow ごとに別 dataset** で描画する。Per-job チャートは `${workflow_file}::${job.name}` をキーに分離するので、`e2e_test` のような同名 job が複数 workflow に存在しても線が混ざらない。

## 可視化(GitHub Pages)

Action は実行のたびに `gh-pages` branch の root に `index.html` を同梱(差分があれば自動同期)する。Chart.js v4 + date-fns adapter を CDN(jsDelivr)から読み込み、`./data/manifest.json` と各 workflow の `./data/<track>/index.json` を読んで、選択中の期間に該当する per-run ファイルだけを fetch する構成。

デフォルトの期間は **直近 30 日**。range preset を変えると、新たに必要になった per-run ファイルだけが追加 fetch される(一度読んだ run はメモリにキャッシュ)。

各 workflow ごとに 2 つのチャートを描画:

- **Total duration per run**: 各 run の `total_duration_sec` を点で並べた折れ線
- **Per-job duration**: 各 job 名ごとに別 dataset を並べた折れ線。matrix permutation (`name (N)` / `name (N, M)` 形式) はデフォルトで base 名にまとめられ、各 run で **max(matrix node duration)** が表示される(並列実行で wall-clock を決める bottleneck node)。チャート上のチェックボックスで matrix を展開して個別 node 表示にも切り替え可能(設定は `localStorage` に保存される)

ライト/ダークは `prefers-color-scheme` で自動切り替え。viewport meta + max-width 960px のレスポンシブ。

### 公開手順

1. リポジトリを **public** にする(または GitHub Pro 以上のプランで Pages を有効化)
2. **Settings → Pages** で:
   - Source: **Deploy from a branch**
   - Branch: **`gh-pages`** / **`/`(root)**
3. 数分後、`https://<owner>.github.io/<repo>/` でグラフが見える

データだけ確認したい場合は `https://<owner>.github.io/<repo>/data/manifest.json` を開いて listed パスを辿れば良い。

### ローカルで確認する

`index.html` の `fetch()` はブラウザの CORS ポリシーにより `file://` で開くと失敗する(Chrome/Edge/Safari 等)。手元で動作確認したい場合は `gh-pages` branch を checkout してから、ローカル HTTP サーバー越しに開く必要がある。

```bash
# gh-pages branch に切り替え(index.html と data/* が root にある状態)
git switch gh-pages

# 任意の static server で配信。Node.js があれば npx で十分
npx serve .
# または
npx http-server -p 8000
```

表示された `http://localhost:<port>/` をブラウザで開けば、本番 Pages と同じグラフが見える。

### 実例(本リポの dogfood)

- ダッシュボード: https://hatsu38.github.io/ghtrack/
- マニフェスト: https://hatsu38.github.io/ghtrack/data/manifest.json

## 必要な permissions と注意事項

- `contents: write` を **track ジョブの `permissions:`** に必ず付与。Repository Settings → Actions → Workflow permissions が "Read and write" でも、workflow 側で明示しておくのが推奨(Settings 変更で挙動が変わるリスクを避ける)
- `actions: read` も track ジョブで必要(workflow run の API 取得のため)
- **fork PR からの実行**: `GITHUB_TOKEN` は base repo に write できないため、Action は `core.notice` のみ出して early return する(entry 収集も push もしない)
- **同時 push の競合**: per-run file は一意なパスに新規作成するだけなので互いに衝突しない。read-modify-write が残るのは workflow ごとの `index.json` のみで、こちらは小さいため指数バックオフ + jitter で最大 10 回まで retry すれば実用上十分

## v1 単一ファイル構成からの migration

旧 `data/<workflow>.json` (entries[] 集約) 構成の `gh-pages` ブランチが既にある場合、ワンショットの migration スクリプトで変換できる:

```bash
# 1. 既存 gh-pages を remote 上でバックアップ
git fetch origin gh-pages
git push origin refs/remotes/origin/gh-pages:refs/heads/gh-pages-v1-backup
git push origin --delete gh-pages

# 2. バックアップをローカルに checkout
git worktree add /tmp/ghtrack-v1 gh-pages-v1-backup

# 3. migration スクリプトを実行(v2 構成のツリーを新規ディレクトリに書き出す)
node scripts/migrate-v1-to-v2.mjs /tmp/ghtrack-v1 /tmp/ghtrack-v2

# 4. /tmp/ghtrack-v2 を新しい gh-pages として push
cd /tmp/ghtrack-v2
git init -b gh-pages
git add .
git commit -m "chore(ghtrack): migrate to v2 per-run file layout"
git remote add origin <repo-url>
git push origin gh-pages
```

ステップ 4 完了後、次回 ghtrack 実行時から v2 モードで追記される。`gh-pages-v1-backup` ブランチはあとから削除しても残しておいても良い。

## ローカル開発

```bash
pnpm install
pnpm typecheck
pnpm build   # dist/ にバンドル(commit 対象)
```

## ライセンス

MIT

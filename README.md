# ghtrack

GitHub Actions の各 workflow run の実行時間を、走るたびに `gh-pages` ブランチへ蓄積していく Action(開発中: v0.1.0 プロトタイプ)。

`benchmark-action/github-action-benchmark` のリアルタイム蓄積方式を、ベンチマーク値ではなく workflow / step の duration に応用することを目指している。

## ステータス

**v0.1.0 プロトタイプ**: workflow run の job / step duration を取得して `gh-pages` branch の `data/data.json` に append し、合わせて Chart.js 製の `index.html` を同 branch の root に同梱する。リポジトリの GitHub Pages を有効化すれば、ブラウザで時系列グラフが見える。

**🌐 Live demo**: https://hatsu38.github.io/ghtrack/  ← 本リポ自身の dogfood の実物

## 使い方

リポジトリ内の任意の workflow の最後に、本 Action を追加する。`gh-pages` branch が無ければ初回実行時に自動でオーファンブランチを作る。

```yaml
# .github/workflows/your-workflow.yml
name: build

on:
  push:
    branches: [main]

# 推奨: 同 branch への並行 push 競合を抑える(retry でも吸収できるが、競合自体を減らせる)
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
| `data-file-path` | `data/data.json` | ブランチ内の JSON ファイルパス |
| `auto-push` | `true` | false にすると entry を収集してログに出すだけで push しない |
| `auto-create-branch` | `true` | ブランチが存在しないとき orphan として自動作成する。false なら明示的に失敗させる |
| `max-items-in-history` | (無制限) | 正の整数を指定すると entries 配列を末尾 N 件に切り詰める。Contents API の 1MB 制限対策 |
| `skip-fork-pr` | `true` | fork からの pull_request 時に push を skip(`GITHUB_TOKEN` に write 権限がないため) |

## 蓄積される JSON のスキーマ

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

`duration_sec` が `null` のステップは未完了(自分自身を観測する都合で、`track` ジョブの最終 step は常に未完了として記録される)。

## 可視化(GitHub Pages)

Action は実行のたびに `gh-pages` branch の root に `index.html` を同梱(差分があれば自動同期)する。Chart.js v4 + date-fns adapter を CDN(jsDelivr)から読み込み、`fetch('./data/data.json')` でデータを取って 2 つの時系列グラフを描く構成:

- **Total duration per run**: 各 run の `total_duration_sec` を点で並べた折れ線
- **Per-job duration**: 各 job 名ごとに別 dataset を並べた折れ線

ライト/ダークは `prefers-color-scheme` で自動切り替え。viewport meta + max-width 960px のレスポンシブ。

### 公開手順

1. リポジトリを **public** にする(または GitHub Pro 以上のプランで Pages を有効化)
2. **Settings → Pages** で:
   - Source: **Deploy from a branch**
   - Branch: **`gh-pages`** / **`/`(root)**
3. 数分後、`https://<owner>.github.io/<repo>/` でグラフが見える

データだけ確認したい場合は `https://<owner>.github.io/<repo>/data/data.json` を直接開いても良い。

### 実例(本リポの dogfood)

- ダッシュボード: https://hatsu38.github.io/ghtrack/
- 生 JSON: https://hatsu38.github.io/ghtrack/data/data.json

## 必要な permissions と注意事項

- `contents: write` を **track ジョブの `permissions:`** に必ず付与。Repository Settings → Actions → Workflow permissions が "Read and write" でも、workflow 側で明示しておくのが推奨(Settings 変更で挙動が変わるリスクを避ける)
- `actions: read` も track ジョブで必要(workflow run の API 取得のため)
- **fork PR からの実行**: `GITHUB_TOKEN` は base repo に write できないため、デフォルト(`skip-fork-pr: "true"`)では push を skip し `core.notice` で通知。entry の収集とログ出力は行う
- **同時 push の競合**: 同じ `data/data.json` への並行更新は `sha` の楽観ロックで検出され、最大 5 回まで指数バックオフで retry。同 workflow 同 branch では `concurrency` を設定して競合自体を抑えるのが堅実

## ローカル開発

```bash
pnpm install
pnpm typecheck
pnpm build   # dist/ にバンドル(commit 対象)
```

## 関連プロジェクト

- [hatsu38/ghlap](https://github.com/hatsu38/ghlap)(別開発中): 過去の workflow runs を後から取得して Supabase に蓄積する「過去取得型」。`ghtrack` は走った瞬間にコミットする「リアルタイム型」で、住み分けている。

## ライセンス

MIT

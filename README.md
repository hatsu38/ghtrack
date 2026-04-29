# ghtrack

GitHub Actions の各 workflow run の実行時間を、走るたびに `gh-pages` ブランチへ蓄積していく Action(開発中: v0.1.0 プロトタイプ)。

`benchmark-action/github-action-benchmark` のリアルタイム蓄積方式を、ベンチマーク値ではなく workflow / step の duration に応用することを目指している。

## ステータス

**v0.1.0 プロトタイプ**: 現状は対象 workflow run の job / step の `started_at` / `completed_at` / 所要時間をログ出力するのみ。`gh-pages` への append とチャート可視化は今後実装する。

## 使い方

リポジトリ内の任意の workflow の最後に、本 Action を追加する。

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
      - uses: actions/checkout@v5
      - run: echo "build something"

  track:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      actions: read
    steps:
      - uses: hatsu38/ghtrack@main
```

## 入力

| name | required | default | 説明 |
| --- | --- | --- | --- |
| `github-token` | no | `${{ github.token }}` | workflow run / job データ取得に使う token。通常は default のままで良い |

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

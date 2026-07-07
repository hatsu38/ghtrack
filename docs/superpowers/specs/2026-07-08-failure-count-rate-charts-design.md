# 失敗件数・失敗率チャートの追加 — 設計

- 日付: 2026-07-08
- 対象: `assets/index.html`(gh-pages ダッシュボード)

## 背景 / 目的

ghtrack のダッシュボードには現在、時系列チャートが3種類ある(すべて縦軸が「秒」)。

1. Run ごとの所要時間・総実行時間(`buildTotalChart`)
2. 実行時間の内訳・累積(`buildBreakdownChart`)
3. Job ごとの実行時間(`buildJobChart`)

失敗(fail)の情報は画面上部のサマリーバッジ(`○件成功 / ○件失敗 / 成功率 Z%`)に**選択期間の合計値**として出るだけで、**時系列での推移が見えない**。

ユーザーは以下を見たい:

- **Fail の「件数」の推移**を、**既存の時間チャートと同じグラフ上**に重ねて見たい
- **Fail の「率」の推移**も見たい(ただし率は割合なので、日/週/月に集計してはじめて意味を持つ)

## 用語・失敗の定義

既存実装に合わせる。

- 失敗系 conclusion: `FAIL_CONCLUSIONS = { "failure", "timed_out" }`
- run 単位の成否: `deriveRunConclusion(entry)` → `"success" | "failure" | "other"`
  - jobs に失敗系が1つでもあれば `failure`、なければ success があれば `success`、それ以外(cancelled / neutral / null のみ)は `other`
- **失敗率の分母 = success + failure**(`other` は分母から除外)。サマリーの成功率と同じ母集団の取り方。

## スコープ / 非スコープ

- スコープ:
  - 時間チャートへの**失敗件数**系列の追加(右側の第2軸)
  - **失敗率(%)チャート**の新規追加(全体のみ・折れ線)
  - 集計単位への**「月次」**追加(グローバルに全チャート共通で適用)
- 非スコープ(今回作らない):
  - **Job 別の失敗率**(per-job flaky 率)。将来必要になったら別途。
  - step 単位の失敗集計

## 決定事項

| 項目 | 決定 |
| --- | --- |
| 失敗件数の置き場所 | 既存の時間チャート(`buildTotalChart`)に重ねる |
| 失敗件数の表現 | 棒グラフ・右側の第2軸(件数)・色は `FAIL_COLOR`(#cf222e) |
| 失敗件数の表示条件 | 常に表示(集計単位 Run / 日 / 週 / 月 すべて) |
| 失敗率の置き場所 | 専用チャートを1枚新規追加 |
| 失敗率の表現 | 折れ線・縦軸 0–100%・色は `FAIL_COLOR` |
| 失敗率のスコープ | **全体の1本のみ**(Job 別は作らない) |
| 失敗率の表示条件 | 集計単位が **日次 / 週次 / 月次** のときだけ表示。**Run 単位のときは非表示**(注記) |
| 集計単位 | Run / 日次 / 週次 に **月次** を追加(グローバル) |

## 詳細設計

### 1. 集計単位に「月次」を追加

「集計単位」`#totalBucket` の select に月次を追加し、bucket 系ユーティリティを拡張する。グローバルな設定なので、時間チャート・内訳チャート・件数・失敗率すべてに一貫して効く。

- HTML: `<option value="month" data-i18n="totalBucketMonth">Monthly (median)</option>` を追加
- i18n: `totalBucketMonth: "月ごと (中央値)"`
- `getTotalBucket()`: `"day" | "week" | "month"` を許容(それ以外は `"run"`)
- `bucketStart(ms, "month")`: ローカルタイムで当月1日 0:00 にスナップ(`d.setDate(1); d.setHours(0,0,0,0)`)
- `isBucketed(bucket)`: `day / week / month` を true
- `applyBucketAxis(opts, bucket)`: `minUnit` を `month → "month"`, `week → "week"`, それ以外 `"day"`
- `bucketMedianSuffix("month")`: `t("monthly median", "月中央値")`
- `bucketTooltipHeader`: month のとき `t("month of ${label}", "${label} の月")` を返す(day/week と同様のパターン)

### 2. 時間チャートへの失敗件数の重ね表示(`buildTotalChart` 拡張)

既存の2系列(所要時間・総実行時間 = 折れ線 / 左軸「秒」)に、**失敗件数**の系列を1本追加する。

- **件数の算出**(集計単位に連動):
  - 非バケット(Run): entry ごとに `deriveRunConclusion(entry) === "failure" ? 1 : 0`
  - バケット(日/週/月): そのバケット内で `deriveRunConclusion === "failure"` の run 数を合計
- **表現**: 混合チャートにする。ベースは `type: "line"` のまま、件数 dataset だけ `type: "bar"`、`yAxisID: "y1"`、`order` を大きめにして棒を線の背面に描く。色 `FAIL_COLOR`。
- **第2軸 `y1`**:
  - `position: "right"`, `beginAtZero: true`
  - `ticks: { precision: 0, stepSize: 1 }`(整数目盛り)
  - `title: { display: true, text: t("Failures", "失敗数") }`
  - `grid: { drawOnChartArea: false }`(左軸「秒」のグリッドと重ねない)
- **凡例ラベル**: 集計単位によらず常に `t("Failures", "失敗数")`。件数は中央値ではなく合計なので、バケット時でも他系列のような ` · ${bucketMedianSuffix}` は付けない。
- **ツールチップ**: 件数 point のとき `失敗 X 件`(バケット時は対象 run 数も併記: `X 件失敗 / 対象 Y 件`)を追加。
- **空データ**: 既存の「total_duration_sec が無ければ empty」判定は維持。件数系列は duration が無くても算出できるが、チャート自体が empty のときは件数も出ない(現状の empty 動作を優先)。

備考: Run 単位では棒が細くなる可能性があるが、件数の推移はバケット(日/週/月)で見るのが主目的なので許容する。

### 3. 失敗率チャートの新規追加(`buildFailRateChart`)

新しい描画関数と、source セクション内に新しい `<h3>` + canvas + meta を追加する。

- **表示条件**:
  - `isBucketed(bucket)` が true(日/週/月)のときだけ描画
  - Run 単位のときは `replaceWithEmpty` で注記表示: `t("Failure rate is shown for daily / weekly / monthly aggregation.", "失敗率は日次 / 週次 / 月次の集計で表示されます。")`
- **算出**(バケットごと):
  - `groupByBucket` で run をバケットにまとめ、各バケットで `deriveRunConclusion` を集計
  - `counted = success + failure`、`counted === 0` のバケットは null(点を打たない)
  - `rate = failure / counted * 100`
- **表現**: `type: "line"`、色 `FAIL_COLOR`、`tension: 0.25`、`pointRadius: 3`
- **軸**:
  - x: time 軸 + `applyBucketAxis(opts, bucket)`
  - y: `min: 0, max: 100`、`title: t("Failure rate (%)", "失敗率 (%)")`、`ticks` に `%` 付与
- **ツールチップ**: `bucketTooltipHeader` + `${rate.toFixed(1)}% (${failure}/${counted})`
- **配置**: 時間チャートの直後(件数と率を隣接させる)。`<h3>` は `t("Failure rate trend", "失敗率の推移")`。

### 4. レンダリング統合

- `renderSourceSection`: 失敗率用の canvas / h3 / meta を時間チャートの直後に追加。返す target に `failRateCanvasId`(必要なら meta id)を含める。
- `renderAllCharts`: `buildFailRateChart(filtered, target.failRateCanvasId, bucket, ...)` を呼ぶ。集計単位変更時に再描画されるよう既存の `totalBucket` change ハンドラの流れに乗せる(`renderAllCharts` は既に集計単位変更で呼ばれる)。

## テスト方針

`assets/index.html` は単一 HTML + バニラ JS でテスト基盤が無い。手動確認を行う:

- 集計単位 Run: 時間チャートに失敗件数(棒)が出る / 失敗率チャートは注記表示
- 集計単位 日次・週次・月次: 件数(棒)と率(折れ線)が両方出る。率は 0–100% の範囲
- 失敗が 0 件の期間: 件数 0、率 0% または点なしが正しく描かれる
- other(cancelled/neutral)だけの期間: 率の分母から除外される
- ダークモード / 日本語ロケール表示崩れなし
- 既存チャート(所要時間・内訳・Job別)が月次でも正しく中央値集計される

可能なら簡単な確認用に、代表的な entries を食わせて `deriveRunConclusion` 集計と rate 計算が合うことを目視確認する。

## リスク / 留意点

- 月次追加は**全チャート共通**に影響する。既存の day/week ロジックと同じ経路なので破壊的ではないが、`bucketStart` / `applyBucketAxis` / `bucketMedianSuffix` / `bucketTooltipHeader` の month 分岐を漏れなく入れる必要がある。
- 混合チャート(line + bar)の第2軸は Chart.js v4 で対応済み。棒が線の手前に来ないよう `order` に注意。
- gh-pages にデプロイ済みの `index.html` は Action 実行時に上書きされる想定(リポジトリの `assets/index.html` が正)。ダウンストリーム利用先への影響は破壊的変更ではない(表示追加のみ・データ形式は不変)。

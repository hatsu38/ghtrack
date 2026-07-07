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

> **注記(2026-07-08 実装時に更新)**: レビューとブラウザ確認を経て設計を変更した。失敗「件数」の棒は**廃止**し、率は失敗率ではなく**成功率(%)** として、専用チャートではなく**時間チャートに重ねて**表示する。以下は変更後の最終仕様。

- スコープ:
  - **時間チャートへの成功率(%)折れ線の重ね表示**(右側の第2軸・緑・破線)
  - 集計単位への**「月次」**追加(グローバルに全チャート共通で適用)
- 非スコープ(今回作らない):
  - 失敗「件数」の棒(当初案。ブラウザ確認の結果、不要と判断し廃止)
  - **率専用のチャート**(当初案。時間チャートへの重ねに変更)
  - **Job 別**の率(per-job flaky 率)。将来必要になったら別途。
  - step 単位の集計

## 決定事項

| 項目 | 決定 |
| --- | --- |
| 失敗件数 | **表示しない**(当初は棒で重ねる案だったが廃止) |
| 率の種類 | **成功率(%)** = `success / (success + failure) * 100` |
| 率の置き場所 | 既存の時間チャート(`buildTotalChart`)に重ねる(専用チャートは作らない) |
| 率の表現 | 折れ線・破線・右側の第2軸(0–100%)・色は `SUCCESS_COLOR`(#2da44e 緑) |
| 率のスコープ | **全体の1本のみ**(Job 別は作らない) |
| 率の表示条件 | 集計単位が **日次 / 週次 / 月次** のときだけ表示。**Run 単位のときは所要時間の線のみ**(率の線・右軸とも非表示) |
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

### 2. 時間チャートへの成功率(%)重ね表示(`buildTotalChart` 拡張)

既存の2系列(所要時間・総実行時間 = 折れ線 / 左軸「秒」)に、**成功率(%)** の折れ線を右側の第2軸で重ねる。失敗「件数」の棒は追加しない。

- **算出**(バケットのときのみ):
  - `groupByBucket(entries, bucket)` で run をバケットにまとめ、各バケットで `deriveRunConclusion` を集計
  - `counted = success + failure`、`counted === 0` のバケットは null(点を打たない)
  - `y = success / counted * 100`。所要時間の median は `usable`(duration 記録済み)ベースだが、率は全 run を母数にしたいので `entries` 全体を bucket 化して数える
  - 点は `{ x, y, success, counted, bucket, isRate: true }`
- **表示条件**: `isBucketed(bucket)`(日/週/月)が true かつ率の点が 1 つ以上あるときだけ、率の dataset と右軸 `y1` を追加する。**Run 単位のときは所要時間の線のみ**(率の線・右軸とも出さない。注記も出さない)
- **表現**: `type: "line"`(ベースチャートのまま)、`yAxisID: "y1"`、色 `SUCCESS_COLOR`(#2da44e 緑)、`borderDash: [5, 4]`(左軸の実線群と区別)、`fill: false`
- **第2軸 `y1`**: `position: "right"`, `min: 0`, `max: 100`, `title: t("Success rate (%)", "成功率 (%)")`, `ticks: { callback: (v) => v + "%" }`, `grid: { drawOnChartArea: false }`
- **ツールチップ**: 率 point(`isRate`)のとき `bucketPeriodLabel` + `成功率 Z% (success/counted 件)`。既存の median / per-run 分岐は温存

### 3. 集計単位の連動

率は集計単位(`#totalBucket`)に連動する。`renderAllCharts` は既に集計単位変更で全チャートを再描画するので、`buildTotalChart` 内で率を描くだけでよく、専用の描画関数・DOM セクション・canvas は不要(当初案から削除)。切替時に右軸が出たり消えたりするのは `prepareCanvas` の再描画で正しく処理される。

## テスト方針

`assets/index.html` は単一 HTML + バニラ JS でテスト基盤が無い。手動確認を行う:

- 集計単位 Run: 時間チャートは所要時間・総実行時間の線のみ(成功率の線・右軸は出ない)
- 集計単位 日次・週次・月次: 時間チャートに成功率(%)の緑の破線が右軸(0–100%)で重なる
- 成功/失敗が無い期間(other のみ)は率の点を打たない(分母から除外)
- ダークモード / 日本語ロケール表示崩れなし
- 既存チャート(所要時間・内訳・Job別)が月次でも正しく中央値集計される

可能なら簡単な確認用に、代表的な entries を食わせて `deriveRunConclusion` 集計と rate 計算が合うことを目視確認する。

## リスク / 留意点

- 月次追加は**全チャート共通**に影響する。既存の day/week ロジックと同じ経路なので破壊的ではないが、`bucketStart` / `applyBucketAxis` / `bucketMedianSuffix` / `bucketTooltipHeader` の month 分岐を漏れなく入れる必要がある。
- 第2軸(右側 %)は Chart.js v4 で対応済み。率は Run 単位では描かないので右軸が出たり消えたりするが、集計単位切替時に `prepareCanvas` で再描画されるため問題ない。
- gh-pages にデプロイ済みの `index.html` は Action 実行時に上書きされる想定(リポジトリの `assets/index.html` が正)。ダウンストリーム利用先への影響は破壊的変更ではない(表示追加のみ・データ形式は不変)。

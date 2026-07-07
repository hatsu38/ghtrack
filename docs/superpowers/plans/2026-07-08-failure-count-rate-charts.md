# 失敗件数・失敗率チャート 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ghtrack ダッシュボードに、失敗の「件数」を既存の時間チャートへ重ねて表示し、失敗の「率」を専用の折れ線チャートで表示する。あわせて集計単位に「月次」を追加する。

**Architecture:** すべて `assets/index.html`(単一 HTML + バニラ JS + Chart.js CDN)への追記。既存の bucket ユーティリティ(`bucketStart` / `isBucketed` / `applyBucketAxis` / `bucketMedianSuffix` / `bucketTooltipHeader`)と失敗判定(`deriveRunConclusion`)を再利用する。時間チャート(`buildTotalChart`)に第2軸(件数)を足して棒を重ね、新規 `buildFailRateChart` で率の折れ線を描く。

**Tech Stack:** HTML / Vanilla JS(IIFE, `"use strict"`)/ Chart.js 4.4.7(line + bar 混合、time スケール、date-fns adapter)

## Global Constraints

- 変更対象は `assets/index.html` の 1 ファイルのみ(データ形式・スキーマは変更しない)。
- 失敗の定義は既存に統一: `deriveRunConclusion(entry)` が `"failure"` の run を失敗とみなす。`FAIL_CONCLUSIONS = {failure, timed_out}`。
- 失敗率の分母 = `success + failure`(`other` = cancelled/neutral/null は分母から除外)。
- 失敗色は既存の `FAIL_COLOR`(`#cf222e`)を使う。
- 文言はすべて EN/JA 両対応。JA は `t(en, ja)` の第2引数、静的要素は `I18N_JA` + `data-i18n`。日本語のアクセント・特殊文字を正しく保持する。
- 集計単位はグローバル(`#totalBucket`)。「月次」を追加したら全チャート共通で効く。
- 自動テスト基盤は無い(`package.json` の `typecheck` は `src/*.ts` 用で HTML には効かない)。各タスクの検証は「JS 構文チェック + ブラウザ手動確認」で行う。TDD の代わりにこの手動サイクルを回す(既存パターン踏襲)。
- コミットメッセージは日本語。main へ直接 push しない(このブランチ `feat/failure-count-rate-charts` で作業)。

---

## 共通の検証コマンド

**JS 構文チェック**(インライン `<script>` を抽出して構文だけ検証。実行はしない):

```bash
node -e "const fs=require('fs');const h=fs.readFileSync('assets/index.html','utf8');const code=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]).join('\n');new Function(code);console.log('SYNTAX OK');"
```
Expected: `SYNTAX OK`(SyntaxError が出たら失敗)

**ブラウザ手動確認**(gh-pages の実データを使ってローカル表示):

```bash
git worktree add /tmp/ghtrack-ghpages gh-pages
cp assets/index.html /tmp/ghtrack-ghpages/index.html
cd /tmp/ghtrack-ghpages && python3 -m http.server 8123
# ブラウザで http://localhost:8123 を開く。画面上部「集計単位」を切り替えて確認。
```
確認が終わったら停止して後片付け:
```bash
# Ctrl-C でサーバ停止後、リポジトリのルートに戻ってから:
git worktree remove /tmp/ghtrack-ghpages --force
```

---

## File Structure

- Modify: `assets/index.html` — ダッシュボード本体(唯一の変更ファイル)
  - `<script>` 内の bucket ユーティリティ群(`getTotalBucket` / `bucketStart` / `isBucketed` / `applyBucketAxis` / `bucketMedianSuffix` / `bucketTooltipHeader`)
  - 失敗判定ヘルパ(`deriveRunConclusion` 付近に `isFailRun` を追加)
  - `buildTotalChart`(件数系列 + 第2軸を追加)
  - 新規 `buildFailRateChart`
  - `renderSourceSection`(失敗率セクションの DOM 追加)/ `renderAllCharts`(呼び出し追加)
  - `<select id="totalBucket">` と `I18N_JA`(月次オプション)

行番号は現状スナップショット。編集で前後にずれるため、**関数名で対象を特定**すること。

---

## Task 1: 集計単位に「月次」を追加

**Files:**
- Modify: `assets/index.html`(`<select id="totalBucket">` ≈ L257-263 / `I18N_JA` ≈ L315 / `getTotalBucket` ≈ L386-389 / `bucketStart` ≈ L393-403 / `isBucketed` ≈ L405-407 / `applyBucketAxis` ≈ L456-459 / `bucketTooltipHeader` ≈ L461-471 / `bucketMedianSuffix` ≈ L473-477)

**Interfaces:**
- Produces:
  - `getTotalBucket(): "run" | "day" | "week" | "month"`
  - `bucketStart(ms: number, bucket): number` — `"month"` は当月1日 0:00(ローカル)にスナップ
  - `isBucketed(bucket): boolean` — `day/week/month` で true
  - `bucketPeriodLabel(bucket, xMs): string` — 期間見出し文字列(新規ヘルパ。Task 2/3 が使う)
  - `applyBucketAxis` / `bucketMedianSuffix` / `bucketTooltipHeader` が `"month"` に対応

- [ ] **Step 1: `<select id="totalBucket">` に月次オプションを追加**

`assets/index.html` の週次 option の直後(≈ L262 の後)に追加:

```html
        <option value="week" data-i18n="totalBucketWeek">Weekly (median)</option>
        <option value="month" data-i18n="totalBucketMonth">Monthly (median)</option>
```
(既存の `week` の行はそのまま、`month` の行を1行足す)

- [ ] **Step 2: `I18N_JA` に月次ラベルを追加**

`totalBucketWeek: "週ごと (中央値)",`(≈ L315)の直後に追加:

```js
    totalBucketWeek: "週ごと (中央値)",
    totalBucketMonth: "月ごと (中央値)",
```

- [ ] **Step 3: `getTotalBucket` を month 許容に変更**

```js
  function getTotalBucket() {
    const v = lsGet(TOTAL_BUCKET_KEY, "run");
    return v === "day" || v === "week" || v === "month" ? v : "run";
  }
```

- [ ] **Step 4: `bucketStart` に month 分岐を追加**

```js
  function bucketStart(ms, bucket) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    if (bucket === "week") {
      // getDay(): 0=Sun, 1=Mon, ... 月曜始まりにオフセット
      const dow = d.getDay();
      const diff = (dow + 6) % 7;
      d.setDate(d.getDate() - diff);
    } else if (bucket === "month") {
      d.setDate(1);
    }
    return d.getTime();
  }
```

- [ ] **Step 5: `isBucketed` に month を追加**

```js
  function isBucketed(bucket) {
    return bucket === "day" || bucket === "week" || bucket === "month";
  }
```

- [ ] **Step 6: `applyBucketAxis` に month を追加**

```js
  function applyBucketAxis(opts, bucket) {
    opts.scales.x.time.minUnit =
      bucket === "month" ? "month" : bucket === "week" ? "week" : "day";
    opts.scales.x.time.tooltipFormat = "yyyy-MM-dd";
  }
```

- [ ] **Step 7: `bucketPeriodLabel` ヘルパを新設し、`bucketTooltipHeader` をそれ経由に変更**

`bucketTooltipHeader`(≈ L461-471)を以下で置き換える(期間見出しを `bucketPeriodLabel` に切り出し、month 対応):

```js
  // 期間見出し文字列。day はそのまま日付、week/month は "〜の週/月"。
  function bucketPeriodLabel(bucket, xMs) {
    const dateLabel = new Date(xMs).toLocaleDateString();
    if (bucket === "week") return t(`week of ${dateLabel}`, `${dateLabel} の週`);
    if (bucket === "month") return t(`month of ${dateLabel}`, `${dateLabel} の月`);
    return dateLabel;
  }

  function bucketTooltipHeader(point) {
    return [
      bucketPeriodLabel(point.bucket, point.x),
      t(`median of ${point.bucketCount} run(s)`,
        `${point.bucketCount} 件の中央値`),
    ];
  }
```

- [ ] **Step 8: `bucketMedianSuffix` に month を追加**

```js
  function bucketMedianSuffix(bucket) {
    if (bucket === "month") return t("monthly median", "月中央値");
    return bucket === "week"
      ? t("weekly median", "週中央値")
      : t("daily median", "日中央値");
  }
```

- [ ] **Step 9: 構文チェック**

「共通の検証コマンド > JS 構文チェック」を実行。
Expected: `SYNTAX OK`

- [ ] **Step 10: ブラウザ手動確認**

「共通の検証コマンド > ブラウザ手動確認」でローカル表示し、集計単位のプルダウンに **「月ごと (中央値)」** が出ること、選択すると既存の3チャート(所要時間・内訳・Job別)が**月単位で中央値集計**され、x 軸が月表示になることを確認。ツールチップ見出しが「〜の月」になる。

- [ ] **Step 11: コミット**

```bash
git add assets/index.html
git commit -m "feat: 集計単位に月次(月ごと中央値)を追加

- totalBucket に month オプションと i18n を追加
- bucketStart/isBucketed/applyBucketAxis/bucketMedianSuffix を month 対応
- bucketPeriodLabel を切り出して bucketTooltipHeader を month 対応"
```

---

## Task 2: 時間チャートに失敗件数を重ねる(第2軸・棒)

**Files:**
- Modify: `assets/index.html`(`deriveRunConclusion` 付近に `isFailRun` 追加 ≈ L361-371 直後 / `buildTotalChart` ≈ L585-662)

**Interfaces:**
- Consumes: `deriveRunConclusion`(既存)/ `FAIL_COLOR`(既存)/ `bucketPeriodLabel`(Task 1)/ `groupByBucket` `isBucketed`(既存)
- Produces: `isFailRun(entry): boolean` — run が失敗なら true。`buildTotalChart` が失敗件数の棒(`yAxisID:"y1"`)を追加表示する。

- [ ] **Step 1: `isFailRun` ヘルパを追加**

`deriveRunConclusion` 関数(≈ L361-371)の直後に追加:

```js
  // run 単位で失敗とみなすか。deriveRunConclusion に一本化して定義を揃える。
  function isFailRun(entry) {
    return deriveRunConclusion(entry) === "failure";
  }
```

- [ ] **Step 2: `buildTotalChart` に失敗件数 dataset を追加**

`buildTotalChart` 内、`const datasets = metrics.map((m) => { ... });` のブロック(≈ L617-641)の**直後**に以下を挿入:

```js
    // 失敗件数を第2軸(件数)へ棒で重ねる。時間(秒)とは単位が違うので y1 に分離。
    // 件数が出る箇所だけ棒を立てたいので y>0 の点に絞る。
    const failData = bucketed
      ? groups
          .map(({ key, items }) => ({
            x: key,
            y: items.filter(isFailRun).length,
            bucketCount: items.length,
            bucket,
            isFail: true,
          }))
          .filter((p) => p.y > 0)
      : usable
          .filter(isFailRun)
          .map((e) => ({ x: e.date, y: 1, raw: e, isFail: true }));
    datasets.push({
      type: "bar",
      label: t("Failures", "失敗数"),
      data: failData,
      backgroundColor: FAIL_COLOR + "cc",
      borderColor: FAIL_COLOR,
      borderWidth: 0,
      maxBarThickness: 18,
      yAxisID: "y1",
      order: 2,
    });
```

- [ ] **Step 3: `buildTotalChart` の tooltip 分岐と第2軸を追加**

`buildTotalChart` の `const opts = chartOptions((point) => { ... });` と続く `if (bucketed) applyBucketAxis(opts, bucket);`(≈ L643-655)を、以下で丸ごと置き換える:

```js
    const opts = chartOptions((point) => {
      if (!point) return [];
      if (point.isFail) {
        if (point.bucket) {
          return [
            bucketPeriodLabel(point.bucket, point.x),
            t(`${point.y} failed / ${point.bucketCount} run(s)`,
              `失敗 ${point.y} 件 / 対象 ${point.bucketCount} 件`),
          ];
        }
        return [
          `commit ${String(point.raw.commit).slice(0, 7)}`,
          t("failed", "失敗"),
        ];
      }
      if (point.bucket) {
        return [...bucketTooltipHeader(point), `median: ${Math.round(point.y)}s`];
      }
      const e = point.raw;
      if (!e) return [];
      return [
        `commit ${String(e.commit).slice(0, 7)}`,
        `event: ${e.event}`,
        e.run_attempt && e.run_attempt > 1 ? `run_attempt: ${e.run_attempt}` : null,
      ];
    });
    // 失敗件数用の右軸。件数は整数・0 始まり。左軸(秒)のグリッドとは重ねない。
    opts.scales.y1 = {
      position: "right",
      beginAtZero: true,
      ticks: { precision: 0 },
      title: { display: true, text: t("Failures", "失敗数") },
      grid: { drawOnChartArea: false },
    };
    if (bucketed) applyBucketAxis(opts, bucket);
```

- [ ] **Step 4: 構文チェック**

「共通の検証コマンド > JS 構文チェック」を実行。
Expected: `SYNTAX OK`

- [ ] **Step 5: ブラウザ手動確認**

ローカル表示で「Run ごとの所要時間・総実行時間」チャートを確認:
- 右側に「失敗数(Failures)」軸が出る
- **集計単位 Run**: 失敗した run の位置に赤い棒(高さ1)が立つ。成功だけの期間は棒なし
- **集計単位 日次/週次/月次**: 各バケットの失敗件数分の高さの赤い棒が立つ
- 棒にホバーすると「失敗 X 件 / 対象 Y 件」(Run 単位は「失敗」)が出る
- 所要時間・総実行時間の折れ線(左軸・秒)は従来どおり
- 失敗が 0 の期間は棒が出ず、右軸だけ残る(0 件が伝わる)

- [ ] **Step 6: コミット**

```bash
git add assets/index.html
git commit -m "feat: 時間チャートに失敗件数を第2軸(棒)で重ねて表示

- isFailRun ヘルパを追加(deriveRunConclusion に一本化)
- buildTotalChart に y1(件数)軸と失敗件数の棒 dataset を追加
- 失敗点のツールチップ分岐を追加"
```

---

## Task 3: 失敗率チャート(折れ線・日/週/月で表示)

**Files:**
- Modify: `assets/index.html`(新規 `buildFailRateChart` を `buildTotalChart` の直後 ≈ L663 付近に追加 / `renderSourceSection` ≈ L1148-1238 / `renderAllCharts` ≈ L1365-1384)

**Interfaces:**
- Consumes: `isBucketed` `groupByBucket` `applyBucketAxis` `bucketPeriodLabel`(Task 1)/ `deriveRunConclusion` `chartOptions` `prepareCanvas` `replaceWithEmpty` `FAIL_COLOR`(既存)
- Produces: `buildFailRateChart(entries, canvasId, bucket)` — 日/週/月のとき失敗率(%)の折れ線を描く。Run 単位や対象 run 無しのときは注記表示。`renderSourceSection` が返す target に `failRateCanvasId` を追加。

- [ ] **Step 1: `buildFailRateChart` を新規追加**

`buildTotalChart` 関数の**閉じ `}` の直後**(≈ L662 の後、`buildJobChart` の前)に追加:

```js
  // 失敗率(%)の推移。率は割合なので Run 単位(0/100)では意味を持たない。
  // 日/週/月に集計されているときだけ描画し、それ以外は注記を出す。
  // 母数 = success + failure(other は除外)。
  function buildFailRateChart(entries, canvasId, bucket) {
    if (!isBucketed(bucket)) {
      replaceWithEmpty(canvasId,
        t("Failure rate is shown for daily / weekly / monthly aggregation.",
          "失敗率は日次 / 週次 / 月次の集計で表示されます。"));
      return;
    }
    if (entries.length === 0) {
      replaceWithEmpty(canvasId,
        t("No runs in selected range.", "選択した期間に該当する run がありません。"));
      return;
    }

    const points = groupByBucket(entries, bucket)
      .map(({ key, items }) => {
        let success = 0, failure = 0;
        for (const e of items) {
          const c = deriveRunConclusion(e);
          if (c === "success") success++;
          else if (c === "failure") failure++;
        }
        const counted = success + failure;
        if (counted === 0) return null;
        return {
          x: key,
          y: (failure / counted) * 100,
          failure,
          counted,
          bucket,
        };
      })
      .filter((p) => p !== null);

    if (points.length === 0) {
      replaceWithEmpty(canvasId,
        t("No success/failure runs to compute rate.",
          "成功 / 失敗の run が無いため失敗率を計算できません。"));
      return;
    }

    const canvas = prepareCanvas(canvasId);
    if (!canvas) return;

    const opts = chartOptions((point) => {
      if (!point) return [];
      return [
        bucketPeriodLabel(point.bucket, point.x),
        t(`failure rate ${point.y.toFixed(1)}% (${point.failure}/${point.counted})`,
          `失敗率 ${point.y.toFixed(1)}% (${point.failure}/${point.counted} 件)`),
      ];
    });
    opts.scales.y.min = 0;
    opts.scales.y.max = 100;
    opts.scales.y.title = { display: true, text: t("Failure rate (%)", "失敗率 (%)") };
    opts.scales.y.ticks = { callback: (v) => v + "%" };
    applyBucketAxis(opts, bucket);

    new Chart(canvas, {
      type: "line",
      data: {
        datasets: [{
          label: t("Failure rate (%)", "失敗率 (%)"),
          data: points,
          borderColor: FAIL_COLOR,
          backgroundColor: FAIL_COLOR + "26",
          tension: 0.25,
          fill: true,
          pointRadius: 3,
        }],
      },
      options: opts,
    });
  }
```

- [ ] **Step 2: `renderSourceSection` に失敗率の canvas id を宣言**

`renderSourceSection` 冒頭の id 宣言群(≈ L1149-1156、`const totalCanvasId = ...` 付近)に追加:

```js
    const totalCanvasId = `total-${idx}`;
    const failRateCanvasId = `fail-rate-${idx}`;
```

- [ ] **Step 3: `renderSourceSection` に失敗率セクションの DOM を追加**

時間チャートの `section.appendChild(totalWrap);`(≈ L1191)の**直後**に、失敗率の h3 + chart-wrap を追加:

```js
    section.appendChild(totalWrap);

    const failRateH3 = document.createElement("h3");
    failRateH3.textContent = t("Failure rate trend", "失敗率の推移");
    section.appendChild(failRateH3);

    const failRateWrap = document.createElement("div");
    failRateWrap.className = "chart-wrap";
    const failRateCanvas = document.createElement("canvas");
    failRateCanvas.id = failRateCanvasId;
    failRateWrap.appendChild(failRateCanvas);
    section.appendChild(failRateWrap);
```

- [ ] **Step 4: `renderSourceSection` の返り値 target に `failRateCanvasId` を追加**

return しているオブジェクト(≈ L1227-1237)に `failRateCanvasId` を足す:

```js
    return {
      source,
      totalCanvasId,
      failRateCanvasId,
      jobCanvasId,
      jobMetaId,
      summaryId,
      statsId,
      breakdownCanvasId,
      breakdownMetaId,
      sourceMetaId,
    };
```

- [ ] **Step 5: `renderAllCharts` から `buildFailRateChart` を呼ぶ**

`renderAllCharts` 内、`buildTotalChart(filtered, target.totalCanvasId, bucket, emptyMsg);`(≈ L1378)の**直後**に追加:

```js
          buildTotalChart(filtered, target.totalCanvasId, bucket, emptyMsg);
          buildFailRateChart(filtered, target.failRateCanvasId, bucket);
```

- [ ] **Step 6: 構文チェック**

「共通の検証コマンド > JS 構文チェック」を実行。
Expected: `SYNTAX OK`

- [ ] **Step 7: ブラウザ手動確認**

ローカル表示で、時間チャートの直下に「失敗率の推移」セクションが出ることを確認:
- **集計単位 Run**: 「失敗率は日次 / 週次 / 月次の集計で表示されます。」の注記が出る(チャートは描かれない)
- **集計単位 日次/週次/月次**: 失敗率(%)の赤い折れ線が出る。縦軸は 0〜100% で目盛りに `%` が付く
- 点にホバーすると「失敗率 Z% (X/Y 件)」が出る
- 集計単位を Run ↔ 日/週/月 で行き来しても、注記 ↔ 折れ線が正しく切り替わる(`replaceWithEmpty` と `prepareCanvas` の再生成が効く)
- 成功/失敗が 1 件も無い期間(cancelled のみ 等)では「成功 / 失敗の run が無いため…」の注記になる

- [ ] **Step 8: コミット**

```bash
git add assets/index.html
git commit -m "feat: 失敗率(%)の推移チャートを追加

- buildFailRateChart を新設(日/週/月で失敗率の折れ線を表示)
- Run 単位・対象 run 無しのときは注記を表示
- renderSourceSection に失敗率セクションを追加し renderAllCharts から呼び出し"
```

---

## Self-Review(この計画作成者によるチェック結果)

**1. Spec coverage:**
- 集計単位に月次追加(全チャート共通)→ Task 1 ✅
- 失敗件数を時間チャートに右軸・棒で重ねる → Task 2 ✅
- 失敗率チャート(全体のみ・折れ線・日/週/月で表示・Run 単位は注記)→ Task 3 ✅
- 失敗の定義/率の分母(other 除外)→ Task 3 の集計ロジックで担保 ✅
- EN/JA 両対応 → 各文言を `t()` / `I18N_JA` で対応 ✅
- Job 別の率は非スコープ → 計画に含めない ✅

**2. Placeholder scan:** TBD/TODO/「適切に処理」等なし。各コード步は実コードを記載済み ✅

**3. Type consistency:**
- `isFailRun`(Task 2 定義)→ Task 2 の `buildTotalChart` で使用。整合 ✅
- `bucketPeriodLabel`(Task 1 定義)→ Task 2/3 で使用。整合 ✅
- `failRateCanvasId`(Task 3 Step 2 で宣言 → Step 4 で target に格納 → Step 5 で `target.failRateCanvasId` 参照)。命名一致 ✅
- fail 点データの形 `{x,y,(bucketCount,bucket|raw),isFail}` と tooltip 側の参照(`point.isFail`/`point.bucket`/`point.bucketCount`/`point.raw`/`point.y`)整合 ✅
- 率点データ `{x,y,failure,counted,bucket}` と tooltip 参照整合 ✅

問題なし。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../assets/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const context = vm.createContext({ location: { hostname: 'localhost', pathname: '/' } });
// 起動時の通信を除き、実際に配信するスクリプトの関数を実行する。
vm.runInContext(script.slice(0, script.lastIndexOf('  loadManifest()')) +
  ';globalThis.api = { comparisonRanges: typeof comparisonRanges === "function" ? comparisonRanges : null, comparisonRangesForSelection: typeof comparisonRangesForSelection === "function" ? comparisonRangesForSelection : null, comparisonRunsIncomplete: typeof comparisonRunsIncomplete === "function" ? comparisonRunsIncomplete : null, comparisonRows: typeof comparisonRows === "function" ? comparisonRows : null, comparisonJobRows: typeof comparisonJobRows === "function" ? comparisonJobRows : null, comparisonDelta: typeof comparisonDelta === "function" ? comparisonDelta : null, compareDaysForPreset: typeof compareDaysForPreset === "function" ? compareDaysForPreset : null, filterByRange, runsInRange };})();', context);
const { api } = context;
const plain = (value) => JSON.parse(JSON.stringify(value));
const job = (name, duration, conclusion = 'success') => ({ name, duration_sec: duration, conclusion, steps: [] });
const entry = (date, duration, jobs) => ({ date, total_duration_sec: duration, jobs });

test('同じ長さの連続する期間を作り、境界の run を二重に数えない', () => {
  assert.equal(typeof api.comparisonRanges, 'function');
  const ranges = api.comparisonRanges(7, Date.UTC(2026, 8, 6));
  assert.deepEqual(plain(ranges), {
    previous: { from: Date.UTC(2026, 7, 23), to: Date.UTC(2026, 7, 30) - 1 },
    current: { from: Date.UTC(2026, 7, 30), to: Date.UTC(2026, 8, 6) - 1 },
  });
  const entries = [entry(ranges.previous.from - 1), entry(ranges.previous.from), entry(ranges.current.from - 1), entry(ranges.current.from), entry(ranges.current.to), entry(ranges.current.to + 1)];
  assert.equal(api.filterByRange(entries, ranges.previous).length, 2);
  assert.equal(api.filterByRange(entries, ranges.current).length, 2);
});

test('日数は正の整数のみ受け付ける', () => {
  assert.equal(typeof api.comparisonRanges, 'function');
  for (const days of [0, -1, 1.5, NaN, Infinity, '', '7', 100000001]) {
    assert.equal(api.comparisonRanges(days, Date.UTC(2026, 8, 6)), null);
  }
  assert.ok(api.comparisonRanges(1, Date.UTC(2026, 8, 6)));
});

test('中央値・実行回数・成功率を集計し、matrix は run ごとの max を使う', () => {
  assert.equal(typeof api.comparisonRows, 'function');
  const previous = [entry(1, 100, [job('build (1)', 20), job('build (2)', 60)]), entry(2, 200, [job('build (1)', 30, 'failure'), job('build (2)', 40)])];
  const current = [entry(3, 80, [job('build (1)', 10), job('build (2)', 20)]), entry(4, null, [job('build (1)', null, 'cancelled')])];
  const rows = plain(api.comparisonRows(previous, current, true));
  assert.deepEqual(rows[0].previous, { duration: 150, count: 2, rate: 50 });
  assert.deepEqual(rows[0].current, { duration: 80, count: 2, rate: 100 });
  assert.equal(rows[1].name, 'build (matrix)');
  assert.deepEqual(rows[1].previous, { duration: 50, count: 2, rate: 50 });
  assert.deepEqual(rows[1].current, { duration: 20, count: 2, rate: 100 });
  assert.equal(api.comparisonRows(previous, current, false).length, 3);
});

test('片方だけに存在する job と未記録の値を欠測として扱う', () => {
  assert.equal(typeof api.comparisonRows, 'function');
  const rows = plain(api.comparisonRows([entry(1, NaN, [job('old', null, 'neutral')])], [entry(2, 0, [job('new', 0, 'timed_out')])], false));
  assert.deepEqual(rows.find(r => r.name === 'old').current, { duration: null, count: 0, rate: null });
  assert.deepEqual(rows.find(r => r.name === 'new').current, { duration: 0, count: 1, rate: 0 });
  assert.equal(rows[0].previous.duration, null);
  assert.equal(rows[0].previous.rate, null);
});

test('差分は current − previous、ゼロ基準と欠測の比率を捏造しない', () => {
  assert.equal(typeof api.comparisonDelta, 'function');
  assert.deepEqual(plain(api.comparisonDelta(100, 80)), { absolute: -20, percent: -20 });
  assert.deepEqual(plain(api.comparisonDelta(0, 10)), { absolute: 10, percent: null });
  assert.deepEqual(plain(api.comparisonDelta(null, 10)), { absolute: null, percent: null });
});

test('比較日数は期間セレクタから自動で決まり、全期間と不正な custom は比較不可にする', () => {
  assert.equal(typeof api.compareDaysForPreset, 'function');
  assert.equal(api.compareDaysForPreset('7d', '', ''), 7);
  assert.equal(api.compareDaysForPreset('30d', '', ''), 30);
  assert.equal(api.compareDaysForPreset('90d', '', ''), 90);
  assert.equal(api.compareDaysForPreset('all', '', ''), null);
  assert.equal(api.compareDaysForPreset('custom', '2026-08-01', '2026-08-07'), 7);
  assert.equal(api.compareDaysForPreset('custom', '2026-08-01', '2026-08-01'), 1);
  assert.equal(api.compareDaysForPreset('custom', '', '2026-08-07'), null);
  assert.equal(api.compareDaysForPreset('custom', '2026-08-01', ''), null);
  assert.equal(api.compareDaysForPreset('custom', '2026-08-07', '2026-08-01'), null);
});

test('custom は選択期間を現在期間とし、直前の同長期間を比較する', () => {
  assert.equal(typeof api.comparisonRangesForSelection, 'function');
  const ranges = plain(api.comparisonRangesForSelection(
    'custom', '2026-08-01', '2026-08-07', Date.UTC(2026, 8, 6),
  ));
  const currentFrom = new Date(2026, 7, 1).getTime();
  assert.deepEqual(ranges, {
    previous: { from: currentFrom - 7 * 86400000, to: currentFrom - 1 },
    current: { from: currentFrom, to: new Date(2026, 7, 8).getTime() - 1 },
  });
});

test('Job 比較は 1 Job 1 行で指標を集計し、片方にしかない Job を含める', () => {
  assert.equal(typeof api.comparisonJobRows, 'function');
  const rows = plain(api.comparisonJobRows(
    [entry(1, 100, [job('build', 20), job('old', 10, 'failure')])],
    [entry(2, 80, [job('build', 10), job('build', 30), job('new', 5)])],
    false,
  ));
  assert.deepEqual(rows.map((row) => row.name), ['build', 'new', 'old']);
  assert.deepEqual(rows.find((row) => row.name === 'build').previous, { duration: 20, count: 1, rate: 100 });
  assert.deepEqual(rows.find((row) => row.name === 'build').current, { duration: 30, count: 1, rate: 100 });
  assert.deepEqual(rows.find((row) => row.name === 'old').current, { duration: null, count: 0, rate: null });
});

test('比較対象のキャッシュ欠落だけを不完全と判定し、境界日の取得済みrunは欠落扱いしない', () => {
  assert.equal(typeof api.comparisonRunsIncomplete, 'function');
  const ranges = api.comparisonRangesForSelection('custom', '2026-08-01', '2026-08-01', Date.now());
  const runs = [
    { date: '2026/07/31', run_id: 1, run_attempt: 1 },
    { date: '2026/08/01', run_id: 2, run_attempt: 1 },
    { date: '2026/08/02', run_id: 3, run_attempt: 1 },
  ];
  assert.equal(api.comparisonRunsIncomplete(runs, ranges, new Set(['wf|1|1', 'wf|2|1']), 'wf'), false);
  assert.equal(api.comparisonRunsIncomplete(runs, ranges, new Set(['wf|1|1']), 'wf'), true);
  assert.equal(api.comparisonRunsIncomplete(runs, ranges, new Set(['wf|1|1', 'wf|2|1']), 'wf'), false);
});

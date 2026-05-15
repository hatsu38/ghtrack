// v1 (data/<file>.json に entries[] を集約していた構成) を v2 (per-run file +
// workflow index + manifest schema 2) に変換するワンショットスクリプト。
//
// Usage:
//   node scripts/migrate-v1-to-v2.mjs <src-dir> <dest-dir> [index-html-src]
//
//   <src-dir>          v1 構成のディレクトリ。直下に index.html と data/manifest.json がある想定
//                      (例: gh-pages-v1-backup を checkout したパス)
//   <dest-dir>         v2 構成を書き出す先 (空または存在しないディレクトリ推奨)
//   <index-html-src>   コピー元の index.html。省略時は <repo>/assets/index.html
//
// 出力後の流れ:
//   1. <dest-dir> を gh-pages branch として push
//   2. ghtrack v2 Action がそのまま追記モードで動く

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST_SCHEMA_VERSION = 2;
const WORKFLOW_INDEX_SCHEMA_VERSION = 1;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_INDEX_HTML = path.resolve(__dirname, "..", "assets", "index.html");

async function main() {
  const [srcDir, destDir, indexHtmlSrcArg] = process.argv.slice(2);
  if (!srcDir || !destDir) {
    console.error(
      "Usage: node scripts/migrate-v1-to-v2.mjs <src-dir> <dest-dir> [index-html-src]",
    );
    process.exit(1);
  }
  const indexHtmlSrc = indexHtmlSrcArg ?? DEFAULT_INDEX_HTML;

  const v1ManifestPath = path.join(srcDir, "data", "manifest.json");
  const v1Manifest = JSON.parse(await fs.readFile(v1ManifestPath, "utf-8"));
  if (!Array.isArray(v1Manifest?.sources)) {
    throw new Error(`Expected sources[] in ${v1ManifestPath}`);
  }

  const workflows = [];

  for (const source of v1Manifest.sources) {
    const filePath = source.path;
    if (typeof filePath !== "string" || !filePath.endsWith(".json")) {
      console.warn(`skipping invalid source: ${JSON.stringify(source)}`);
      continue;
    }
    const trackName = path.basename(filePath, ".json");
    const trackDir = `data/${trackName}`;

    const v1Data = JSON.parse(await fs.readFile(path.join(srcDir, filePath), "utf-8"));
    if (!Array.isArray(v1Data?.entries)) {
      console.warn(`skipping ${filePath}: entries[] missing`);
      continue;
    }

    const runs = [];
    for (const entry of v1Data.entries) {
      if (typeof entry?.run_id !== "number" || typeof entry?.date !== "number") {
        console.warn(`skipping malformed entry in ${filePath}: ${JSON.stringify(entry).slice(0, 80)}…`);
        continue;
      }
      const runAttempt = typeof entry.run_attempt === "number" ? entry.run_attempt : 1;
      const di = dateInfoFromMillis(entry.date);
      const perRunRel = `${trackDir}/${di.yyyy}/${di.mm}/${di.dd}/${entry.run_id}-${runAttempt}.json`;
      const perRunAbs = path.join(destDir, perRunRel);
      await fs.mkdir(path.dirname(perRunAbs), { recursive: true });
      const normalized = { ...entry, run_attempt: runAttempt };
      await fs.writeFile(perRunAbs, JSON.stringify(normalized, null, 2) + "\n");
      runs.push({ date: di.dateStr, run_id: entry.run_id, run_attempt: runAttempt });
    }

    runs.sort((a, b) => a.run_id - b.run_id || a.run_attempt - b.run_attempt);

    const workflowIndex = {
      schema_version: WORKFLOW_INDEX_SCHEMA_VERSION,
      track_name: trackName,
      runs,
      last_updated: typeof source.first_seen === "number" ? source.first_seen : Date.now(),
    };
    const indexAbs = path.join(destDir, trackDir, "index.json");
    await fs.mkdir(path.dirname(indexAbs), { recursive: true });
    await fs.writeFile(indexAbs, JSON.stringify(workflowIndex, null, 2) + "\n");

    workflows.push({
      track_name: trackName,
      dir: trackDir,
      first_seen: typeof source.first_seen === "number" ? source.first_seen : Date.now(),
    });

    console.log(`migrated ${trackName}: ${runs.length} runs`);
  }

  const v2Manifest = { schema_version: MANIFEST_SCHEMA_VERSION, workflows };
  const manifestAbs = path.join(destDir, "data", "manifest.json");
  await fs.mkdir(path.dirname(manifestAbs), { recursive: true });
  await fs.writeFile(manifestAbs, JSON.stringify(v2Manifest, null, 2) + "\n");

  // dashboard は v2 仕様の index.html を置く必要がある
  const indexHtml = await fs.readFile(indexHtmlSrc);
  await fs.writeFile(path.join(destDir, "index.html"), indexHtml);

  console.log(`done: ${workflows.length} workflow(s) → ${destDir}`);
}

function dateInfoFromMillis(millis) {
  const d = new Date(millis);
  const yyyy = String(d.getUTCFullYear()).padStart(4, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return { yyyy, mm, dd, dateStr: `${yyyy}/${mm}/${dd}` };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

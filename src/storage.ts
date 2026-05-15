import * as core from "@actions/core";
import * as github from "@actions/github";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DataFile, Entry, Inputs } from "./types";
import { SCHEMA_VERSION, emptyDataFile } from "./types";
import {
  MANIFEST_FILE_PATH,
  buildInitialManifest,
  ensureManifestEntry,
  serializeManifest,
} from "./manifest";

type Octokit = ReturnType<typeof github.getOctokit>;

const COMMITTER = {
  name: "github-actions[bot]",
  email: "41898282+github-actions[bot]@users.noreply.github.com",
} as const;

const MAX_PUSH_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 500;

// 利用者から見える HTML エントリポイントのパス。gh-pages の root に置く。
const INDEX_HTML_REMOTE_PATH = "index.html";
const INDEX_HTML_LOCAL_PATH = "assets/index.html";

export interface WriteEntryArgs {
  octokit: Octokit;
  owner: string;
  repo: string;
  inputs: Inputs;
  entry: Entry;
}

export async function writeEntryToGhPages(args: WriteEntryArgs): Promise<void> {
  const branchExists = await branchExistsOnRemote(args);

  if (!branchExists) {
    const bootstrapped = await bootstrapBranch(args);
    if (bootstrapped) return;
    // race condition: branch was concurrently created → fall through to update flow
  }

  await appendWithRetry(args);
  await ensureManifestEntry({
    octokit: args.octokit,
    owner: args.owner,
    repo: args.repo,
    inputs: args.inputs,
  });
  await ensureIndexHtml(args);
}

async function branchExistsOnRemote(args: WriteEntryArgs): Promise<boolean> {
  try {
    await args.octokit.rest.git.getRef({
      owner: args.owner,
      repo: args.repo,
      ref: `heads/${args.inputs.ghPagesBranch}`,
    });
    return true;
  } catch (err) {
    if (errorStatus(err) === 404) return false;
    throw err;
  }
}

async function bootstrapBranch(args: WriteEntryArgs): Promise<boolean> {
  const initial = appendEntry(emptyDataFile(), args.entry, args.inputs.maxItemsInHistory);
  const indexHtml = await loadBundledIndexHtml();
  const initialManifest = buildInitialManifest(args.inputs.dataFilePath);

  const [dataBlob, htmlBlob, manifestBlob] = await Promise.all([
    args.octokit.rest.git.createBlob({
      owner: args.owner,
      repo: args.repo,
      content: Buffer.from(serializeDataFile(initial), "utf-8").toString("base64"),
      encoding: "base64",
    }),
    args.octokit.rest.git.createBlob({
      owner: args.owner,
      repo: args.repo,
      content: indexHtml.toString("base64"),
      encoding: "base64",
    }),
    args.octokit.rest.git.createBlob({
      owner: args.owner,
      repo: args.repo,
      content: Buffer.from(serializeManifest(initialManifest), "utf-8").toString("base64"),
      encoding: "base64",
    }),
  ]);

  const tree = await args.octokit.rest.git.createTree({
    owner: args.owner,
    repo: args.repo,
    tree: [
      {
        path: args.inputs.dataFilePath,
        mode: "100644",
        type: "blob",
        sha: dataBlob.data.sha,
      },
      {
        path: INDEX_HTML_REMOTE_PATH,
        mode: "100644",
        type: "blob",
        sha: htmlBlob.data.sha,
      },
      {
        path: MANIFEST_FILE_PATH,
        mode: "100644",
        type: "blob",
        sha: manifestBlob.data.sha,
      },
    ],
  });

  const commit = await args.octokit.rest.git.createCommit({
    owner: args.owner,
    repo: args.repo,
    message: `chore(ghtrack): bootstrap ${args.inputs.ghPagesBranch} with first entry, index.html, and manifest`,
    tree: tree.data.sha,
    parents: [], // orphan commit — gh-pages を main 履歴と分離する
    author: COMMITTER,
    committer: COMMITTER,
  });

  try {
    await args.octokit.rest.git.createRef({
      owner: args.owner,
      repo: args.repo,
      ref: `refs/heads/${args.inputs.ghPagesBranch}`,
      sha: commit.data.sha,
    });
    core.notice(
      `Auto-created branch "${args.inputs.ghPagesBranch}" with the first ghtrack entry.`,
    );
    return true;
  } catch (err) {
    // 422 = ref already exists(他 runner が同時に作った)。update フローへフォールバック
    if (errorStatus(err) === 422) {
      core.warning(
        `Branch "${args.inputs.ghPagesBranch}" was concurrently created. Falling back to update flow.`,
      );
      return false;
    }
    throw err;
  }
}

async function ensureIndexHtml(args: WriteEntryArgs): Promise<void> {
  const html = await loadBundledIndexHtml();
  const localBlobSha = computeGitBlobSha(html);

  let remoteSha: string | null = null;
  try {
    const res = await args.octokit.rest.repos.getContent({
      owner: args.owner,
      repo: args.repo,
      path: INDEX_HTML_REMOTE_PATH,
      ref: args.inputs.ghPagesBranch,
    });
    if (!Array.isArray(res.data) && res.data.type === "file") {
      remoteSha = res.data.sha;
    }
  } catch (err) {
    if (errorStatus(err) !== 404) throw err;
  }

  if (remoteSha === localBlobSha) {
    core.info(`index.html is up to date on ${args.inputs.ghPagesBranch} (sha=${localBlobSha.slice(0, 7)}).`);
    return;
  }

  await args.octokit.rest.repos.createOrUpdateFileContents({
    owner: args.owner,
    repo: args.repo,
    path: INDEX_HTML_REMOTE_PATH,
    branch: args.inputs.ghPagesBranch,
    message: remoteSha === null
      ? `chore(ghtrack): add index.html to ${args.inputs.ghPagesBranch}`
      : `chore(ghtrack): sync index.html on ${args.inputs.ghPagesBranch}`,
    content: html.toString("base64"),
    sha: remoteSha ?? undefined,
    author: COMMITTER,
    committer: COMMITTER,
  });
  core.info(
    `${remoteSha === null ? "Added" : "Updated"} index.html on ${args.inputs.ghPagesBranch} (new sha=${localBlobSha.slice(0, 7)}).`,
  );
}

async function loadBundledIndexHtml(): Promise<Buffer> {
  // 利用側 repo から `uses: hatsu38/ghtrack@vX.Y.Z` で呼ばれた時、
  // GITHUB_ACTION_PATH は composite action 用の env で Node.js Action では未定義のことがある。
  // ncc バンドル後の __dirname は <action-checkout>/dist/ を指すため、`..` で action repo
  // のルートに上がって assets/index.html を読む。GITHUB_ACTION_PATH が定義されていれば優先。
  const candidates: string[] = [];
  if (process.env.GITHUB_ACTION_PATH) {
    candidates.push(path.join(process.env.GITHUB_ACTION_PATH, INDEX_HTML_LOCAL_PATH));
  }
  candidates.push(path.join(__dirname, "..", INDEX_HTML_LOCAL_PATH));

  for (const filePath of candidates) {
    try {
      return await fs.readFile(filePath);
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") throw err;
    }
  }
  throw new Error(
    `assets/index.html not found. Tried: ${candidates.join(", ")}`,
  );
}

function computeGitBlobSha(content: Buffer): string {
  // git の blob hash は sha1("blob " + size + "\0" + content)。Contents API が返す sha と一致するため、
  // ローカルでハッシュを計算してリモートとの差分を 0 API call で判定できる。
  const header = Buffer.from(`blob ${content.length}\0`, "utf-8");
  return crypto.createHash("sha1").update(header).update(content).digest("hex");
}

async function appendWithRetry(args: WriteEntryArgs): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
    try {
      await appendOnce(args);
      return;
    } catch (err) {
      lastError = err;
      const status = errorStatus(err);
      const retryable = status === 409 || status === 422;
      if (!retryable || attempt >= MAX_PUSH_ATTEMPTS) {
        throw err;
      }
      const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      core.warning(
        `Conflict (status=${status}) on attempt ${attempt}/${MAX_PUSH_ATTEMPTS}. Retrying in ${delay}ms.`,
      );
      await sleep(delay);
    }
  }
  throw lastError;
}

async function appendOnce(args: WriteEntryArgs): Promise<void> {
  const existing = await readDataFile(args);
  const next = appendEntry(existing.data, args.entry, args.inputs.maxItemsInHistory);

  // Git Data API ベースで read-modify-write する。Contents API は >1MB のファイルで
  // content を返さなくなるため、履歴を積み上げる用途では Blob/Tree/Commit を直接扱う。
  const blob = await args.octokit.rest.git.createBlob({
    owner: args.owner,
    repo: args.repo,
    content: Buffer.from(serializeDataFile(next), "utf-8").toString("base64"),
    encoding: "base64",
  });

  const tree = await args.octokit.rest.git.createTree({
    owner: args.owner,
    repo: args.repo,
    base_tree: existing.baseTreeSha,
    tree: [
      {
        path: args.inputs.dataFilePath,
        mode: "100644",
        type: "blob",
        sha: blob.data.sha,
      },
    ],
  });

  const commit = await args.octokit.rest.git.createCommit({
    owner: args.owner,
    repo: args.repo,
    message: buildCommitMessage(args.entry),
    tree: tree.data.sha,
    parents: [existing.headSha],
    author: COMMITTER,
    committer: COMMITTER,
  });

  // force:false で他 runner の同時 push と競合した場合は 422 が返る。
  // appendWithRetry がそれを retry する。
  await args.octokit.rest.git.updateRef({
    owner: args.owner,
    repo: args.repo,
    ref: `heads/${args.inputs.ghPagesBranch}`,
    sha: commit.data.sha,
    force: false,
  });

  core.info(
    `Appended entry (run_id=${args.entry.run_id}) to ${args.inputs.dataFilePath} on ${args.inputs.ghPagesBranch}. ` +
      `Total entries: ${next.entries.length}.`,
  );
}

interface ReadResult {
  data: DataFile;
  // 既存ファイルの blob sha。新規作成時は null。
  fileSha: string | null;
  // ブランチ HEAD のコミット sha。createCommit の parent に渡す。
  headSha: string;
  // HEAD コミットの tree sha。createTree の base_tree に渡して差分更新する。
  baseTreeSha: string;
}

async function readDataFile(args: WriteEntryArgs): Promise<ReadResult> {
  const ref = await args.octokit.rest.git.getRef({
    owner: args.owner,
    repo: args.repo,
    ref: `heads/${args.inputs.ghPagesBranch}`,
  });
  const headSha = ref.data.object.sha;

  const commit = await args.octokit.rest.git.getCommit({
    owner: args.owner,
    repo: args.repo,
    commit_sha: headSha,
  });
  const baseTreeSha = commit.data.tree.sha;

  // recursive=true を渡すとサブツリーまで展開される。data ファイルは
  // ネストされたパス(e.g. data/e2e-admin.json)に置かれるためこれが必要。
  const tree = await args.octokit.rest.git.getTree({
    owner: args.owner,
    repo: args.repo,
    tree_sha: baseTreeSha,
    recursive: "true",
  });
  if (tree.data.truncated) {
    // gh-pages の管理対象は ghtrack が生成する数十ファイル程度を想定しており、
    // GitHub 側の上限(>100k entries)に達することは実質起きないが、念のため明示エラー化する。
    throw new Error(
      `Tree at ${args.inputs.ghPagesBranch} is too large to enumerate recursively. ` +
        `Please reduce the number of files on the branch.`,
    );
  }

  const node = tree.data.tree.find(
    (n) => n.path === args.inputs.dataFilePath && n.type === "blob",
  );
  if (!node?.sha) {
    // ブランチは存在するが data ファイルがまだ無いケース。空から始める。
    return { data: emptyDataFile(), fileSha: null, headSha, baseTreeSha };
  }

  const blob = await args.octokit.rest.git.getBlob({
    owner: args.owner,
    repo: args.repo,
    file_sha: node.sha,
  });
  // getBlob は encoding を返す。通常 base64 だが念のため動的に処理する。
  const encoding = blob.data.encoding === "utf-8" ? "utf-8" : "base64";
  const text = Buffer.from(blob.data.content, encoding).toString("utf-8");
  return { data: parseDataFile(text), fileSha: node.sha, headSha, baseTreeSha };
}

function parseDataFile(text: string): DataFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `Existing data file is not valid JSON: ${(e as Error).message}`,
    );
  }
  if (!isDataFile(parsed)) {
    throw new Error(
      `Existing data file does not match the expected schema (schema_version=${SCHEMA_VERSION}).`,
    );
  }
  return parsed;
}

function isDataFile(value: unknown): value is DataFile {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { schema_version?: unknown; entries?: unknown };
  return (
    candidate.schema_version === SCHEMA_VERSION &&
    Array.isArray(candidate.entries)
  );
}

function appendEntry(
  data: DataFile,
  entry: Entry,
  maxItems: number | null,
): DataFile {
  const entries = [...data.entries, entry];
  const truncated =
    maxItems !== null && entries.length > maxItems
      ? entries.slice(entries.length - maxItems)
      : entries;
  return { schema_version: SCHEMA_VERSION, entries: truncated };
}

function serializeDataFile(data: DataFile): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function buildCommitMessage(entry: Entry): string {
  return `chore(ghtrack): append run ${entry.run_id} for ${entry.workflow}`;
}

function errorStatus(err: unknown): number | null {
  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === "number") return status;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import * as core from "@actions/core";
import * as github from "@actions/github";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DataFile, Entry, Inputs } from "./types";
import { SCHEMA_VERSION, emptyDataFile } from "./types";

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
    if (!args.inputs.autoCreateBranch) {
      throw new Error(
        `Branch "${args.inputs.ghPagesBranch}" does not exist and auto-create-branch is disabled.`,
      );
    }
    const bootstrapped = await bootstrapBranch(args);
    if (bootstrapped) return;
    // race condition: branch was concurrently created → fall through to update flow
  }

  await appendWithRetry(args);
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

  const [dataBlob, htmlBlob] = await Promise.all([
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
    ],
  });

  const commit = await args.octokit.rest.git.createCommit({
    owner: args.owner,
    repo: args.repo,
    message: `chore(ghtrack): bootstrap ${args.inputs.ghPagesBranch} with first entry and index.html`,
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

  await args.octokit.rest.repos.createOrUpdateFileContents({
    owner: args.owner,
    repo: args.repo,
    path: args.inputs.dataFilePath,
    branch: args.inputs.ghPagesBranch,
    message: buildCommitMessage(args.entry),
    content: Buffer.from(serializeDataFile(next), "utf-8").toString("base64"),
    sha: existing.fileSha ?? undefined,
    author: COMMITTER,
    committer: COMMITTER,
  });

  core.info(
    `Appended entry (run_id=${args.entry.run_id}) to ${args.inputs.dataFilePath} on ${args.inputs.ghPagesBranch}. ` +
      `Total entries: ${next.entries.length}.`,
  );
}

interface ReadResult {
  data: DataFile;
  fileSha: string | null;
}

async function readDataFile(args: WriteEntryArgs): Promise<ReadResult> {
  try {
    const res = await args.octokit.rest.repos.getContent({
      owner: args.owner,
      repo: args.repo,
      path: args.inputs.dataFilePath,
      ref: args.inputs.ghPagesBranch,
    });

    if (Array.isArray(res.data)) {
      throw new Error(
        `${args.inputs.dataFilePath} is a directory on ${args.inputs.ghPagesBranch}, expected a file.`,
      );
    }
    if (res.data.type !== "file") {
      throw new Error(
        `${args.inputs.dataFilePath} is not a regular file (type=${res.data.type}).`,
      );
    }
    if (typeof res.data.content !== "string" || res.data.content.length === 0) {
      // Contents API は >1MB のファイルでは content を返さない。
      // 履歴が肥大化したら max-items-in-history で切り詰めるか、後続で git data API 移行を検討。
      throw new Error(
        `${args.inputs.dataFilePath} is too large for the Contents API. ` +
          `Set max-items-in-history to prune history.`,
      );
    }

    const text = Buffer.from(res.data.content, "base64").toString("utf-8");
    return { data: parseDataFile(text), fileSha: res.data.sha };
  } catch (err) {
    if (errorStatus(err) === 404) {
      return { data: emptyDataFile(), fileSha: null };
    }
    throw err;
  }
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

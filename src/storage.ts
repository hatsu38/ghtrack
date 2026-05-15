import * as core from "@actions/core";
import * as github from "@actions/github";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Entry, Inputs, WorkflowIndex } from "./types";
import {
  MANIFEST_FILE_PATH,
  buildInitialManifest,
  ensureManifestEntry,
  serializeManifest,
  workflowDir,
} from "./manifest";
import {
  buildInitialWorkflowIndex,
  parseWorkflowIndex,
  serializeWorkflowIndex,
  upsertRun,
  workflowIndexPath,
} from "./workflow-index";

type Octokit = ReturnType<typeof github.getOctokit>;

const COMMITTER = {
  name: "github-actions[bot]",
  email: "41898282+github-actions[bot]@users.noreply.github.com",
} as const;

// 同一 workflow が同タイミングで複数 run される CI でも吸収できるように余裕を持たせる。
const MAX_PUSH_ATTEMPTS = 10;
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
  await Promise.all([
    ensureManifestEntry({
      octokit: args.octokit,
      owner: args.owner,
      repo: args.repo,
      inputs: args.inputs,
    }),
    ensureIndexHtml(args),
  ]);
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
  const trackName = args.inputs.trackName;
  const di = dateInfoFromMillis(args.entry.date);
  const entryPath = perRunFilePath(trackName, di, args.entry.run_id, args.entry.run_attempt);
  const indexPath = workflowIndexPath(trackName);

  const now = Date.now();
  const initialIndex = buildInitialWorkflowIndex(
    trackName,
    {
      date: di.dateStr,
      run_id: args.entry.run_id,
      run_attempt: args.entry.run_attempt,
    },
    now,
  );
  const initialManifest = buildInitialManifest(trackName);

  const [entryBlob, indexBlob, manifestBlob, htmlBlob] = await Promise.all([
    args.octokit.rest.git.createBlob({
      owner: args.owner,
      repo: args.repo,
      content: Buffer.from(serializeEntry(args.entry), "utf-8").toString("base64"),
      encoding: "base64",
    }),
    args.octokit.rest.git.createBlob({
      owner: args.owner,
      repo: args.repo,
      content: Buffer.from(serializeWorkflowIndex(initialIndex), "utf-8").toString("base64"),
      encoding: "base64",
    }),
    args.octokit.rest.git.createBlob({
      owner: args.owner,
      repo: args.repo,
      content: Buffer.from(serializeManifest(initialManifest), "utf-8").toString("base64"),
      encoding: "base64",
    }),
    loadBundledIndexHtml().then((html) =>
      args.octokit.rest.git.createBlob({
        owner: args.owner,
        repo: args.repo,
        content: html.toString("base64"),
        encoding: "base64",
      }),
    ),
  ]);

  const tree = await args.octokit.rest.git.createTree({
    owner: args.owner,
    repo: args.repo,
    tree: [
      { path: entryPath, mode: "100644", type: "blob", sha: entryBlob.data.sha },
      { path: indexPath, mode: "100644", type: "blob", sha: indexBlob.data.sha },
      { path: MANIFEST_FILE_PATH, mode: "100644", type: "blob", sha: manifestBlob.data.sha },
      { path: INDEX_HTML_REMOTE_PATH, mode: "100644", type: "blob", sha: htmlBlob.data.sha },
    ],
  });

  const commit = await args.octokit.rest.git.createCommit({
    owner: args.owner,
    repo: args.repo,
    message: `chore(ghtrack): bootstrap ${args.inputs.ghPagesBranch} for ${trackName} ${args.entry.run_id}-${args.entry.run_attempt}`,
    tree: tree.data.sha,
    parents: [],
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
    core.info(
      `index.html is up to date on ${args.inputs.ghPagesBranch} (sha=${localBlobSha.slice(0, 7)}).`,
    );
    return;
  }

  await args.octokit.rest.repos.createOrUpdateFileContents({
    owner: args.owner,
    repo: args.repo,
    path: INDEX_HTML_REMOTE_PATH,
    branch: args.inputs.ghPagesBranch,
    message:
      remoteSha === null
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
  throw new Error(`assets/index.html not found. Tried: ${candidates.join(", ")}`);
}

function computeGitBlobSha(content: Buffer): string {
  // git の blob hash は sha1("blob " + size + "\0" + content)。Contents API が返す sha と一致するため、
  // ローカルでハッシュを計算してリモートとの差分を 0 API call で判定できる。
  const header = Buffer.from(`blob ${content.length}\0`, "utf-8");
  return crypto.createHash("sha1").update(header).update(content).digest("hex");
}

async function appendWithRetry(args: WriteEntryArgs): Promise<void> {
  for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
    const ok = await appendOnce(args);
    if (ok) return;
    if (attempt >= MAX_PUSH_ATTEMPTS) {
      throw new Error(
        `Failed to push after ${MAX_PUSH_ATTEMPTS} ref-conflict retries.`,
      );
    }
    const base = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
    const jitter = Math.floor(Math.random() * RETRY_BASE_DELAY_MS);
    const delay = base + jitter;
    core.warning(
      `Ref conflict on attempt ${attempt}/${MAX_PUSH_ATTEMPTS}. Retrying in ${delay}ms.`,
    );
    await sleep(delay);
  }
}

// 戻り値 false は updateRef が 422 を返した = 親 commit が古い (他 run が先に push)
// のため retry すべき状態を表す。createBlob 等の 422 (バリデーションエラー) はここで
// 区別したいので updateRef の呼び出し点でだけ 422 を拾う。
async function appendOnce(args: WriteEntryArgs): Promise<boolean> {
  const trackName = args.inputs.trackName;
  const di = dateInfoFromMillis(args.entry.date);
  const entryPath = perRunFilePath(trackName, di, args.entry.run_id, args.entry.run_attempt);
  const indexPath = workflowIndexPath(trackName);
  const branchRef = `heads/${args.inputs.ghPagesBranch}`;

  const [{ parentSha, baseTreeSha }, currentIndex] = await Promise.all([
    args.octokit.rest.git
      .getRef({ owner: args.owner, repo: args.repo, ref: branchRef })
      .then((ref) =>
        args.octokit.rest.git
          .getCommit({
            owner: args.owner,
            repo: args.repo,
            commit_sha: ref.data.object.sha,
          })
          .then((commit) => ({
            parentSha: ref.data.object.sha,
            baseTreeSha: commit.data.tree.sha,
          })),
      ),
    readWorkflowIndexAt(args, args.inputs.ghPagesBranch, indexPath),
  ]);

  const now = Date.now();
  const run = {
    date: di.dateStr,
    run_id: args.entry.run_id,
    run_attempt: args.entry.run_attempt,
  };
  const nextIndex = currentIndex
    ? upsertRun(currentIndex, run, now)
    : buildInitialWorkflowIndex(trackName, run, now);

  const [entryBlob, indexBlob] = await Promise.all([
    args.octokit.rest.git.createBlob({
      owner: args.owner,
      repo: args.repo,
      content: Buffer.from(serializeEntry(args.entry), "utf-8").toString("base64"),
      encoding: "base64",
    }),
    args.octokit.rest.git.createBlob({
      owner: args.owner,
      repo: args.repo,
      content: Buffer.from(serializeWorkflowIndex(nextIndex), "utf-8").toString("base64"),
      encoding: "base64",
    }),
  ]);

  const tree = await args.octokit.rest.git.createTree({
    owner: args.owner,
    repo: args.repo,
    base_tree: baseTreeSha,
    tree: [
      { path: entryPath, mode: "100644", type: "blob", sha: entryBlob.data.sha },
      { path: indexPath, mode: "100644", type: "blob", sha: indexBlob.data.sha },
    ],
  });

  const commit = await args.octokit.rest.git.createCommit({
    owner: args.owner,
    repo: args.repo,
    message: `chore(ghtrack): record ${trackName} ${args.entry.run_id}-${args.entry.run_attempt}`,
    tree: tree.data.sha,
    parents: [parentSha],
    author: COMMITTER,
    committer: COMMITTER,
  });

  try {
    await args.octokit.rest.git.updateRef({
      owner: args.owner,
      repo: args.repo,
      ref: branchRef,
      sha: commit.data.sha,
    });
  } catch (err) {
    if (errorStatus(err) === 422) return false;
    throw err;
  }

  core.info(
    `Recorded ${trackName} run ${args.entry.run_id}-${args.entry.run_attempt} (${di.dateStr}).`,
  );
  return true;
}

async function readWorkflowIndexAt(
  args: WriteEntryArgs,
  ref: string,
  indexPath: string,
): Promise<WorkflowIndex | null> {
  try {
    const res = await args.octokit.rest.repos.getContent({
      owner: args.owner,
      repo: args.repo,
      path: indexPath,
      ref,
    });
    if (Array.isArray(res.data) || res.data.type !== "file") {
      throw new Error(`${indexPath} is not a regular file.`);
    }
    if (typeof res.data.content !== "string" || res.data.content.length === 0) {
      throw new Error(`${indexPath} content is empty or unreadable.`);
    }
    const text = Buffer.from(res.data.content, "base64").toString("utf-8");
    return parseWorkflowIndex(text);
  } catch (err) {
    if (errorStatus(err) === 404) return null;
    throw err;
  }
}

interface DateInfo {
  yyyy: string;
  mm: string;
  dd: string;
  dateStr: string;
}

function dateInfoFromMillis(millis: number): DateInfo {
  const d = new Date(millis);
  const yyyy = String(d.getUTCFullYear()).padStart(4, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return { yyyy, mm, dd, dateStr: `${yyyy}/${mm}/${dd}` };
}

function perRunFilePath(
  trackName: string,
  di: DateInfo,
  runId: number,
  runAttempt: number,
): string {
  return `${workflowDir(trackName)}/${di.yyyy}/${di.mm}/${di.dd}/${runId}-${runAttempt}.json`;
}

function serializeEntry(entry: Entry): string {
  return `${JSON.stringify(entry, null, 2)}\n`;
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

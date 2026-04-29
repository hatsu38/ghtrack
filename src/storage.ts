import * as core from "@actions/core";
import * as github from "@actions/github";
import type { DataFile, Entry, Inputs } from "./types";
import { SCHEMA_VERSION, emptyDataFile } from "./types";

type Octokit = ReturnType<typeof github.getOctokit>;

const COMMITTER = {
  name: "github-actions[bot]",
  email: "41898282+github-actions[bot]@users.noreply.github.com",
} as const;

const MAX_PUSH_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 500;

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

  const blob = await args.octokit.rest.git.createBlob({
    owner: args.owner,
    repo: args.repo,
    content: Buffer.from(serializeDataFile(initial), "utf-8").toString("base64"),
    encoding: "base64",
  });

  const tree = await args.octokit.rest.git.createTree({
    owner: args.owner,
    repo: args.repo,
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
    message: `chore(ghtrack): bootstrap ${args.inputs.ghPagesBranch} with first entry`,
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

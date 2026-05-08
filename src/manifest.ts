import * as core from "@actions/core";
import * as github from "@actions/github";
import type { Inputs, Manifest, ManifestSource } from "./types";
import { MANIFEST_SCHEMA_VERSION, emptyManifest } from "./types";

type Octokit = ReturnType<typeof github.getOctokit>;

export const MANIFEST_FILE_PATH = "data/manifest.json";

const COMMITTER = {
  name: "github-actions[bot]",
  email: "41898282+github-actions[bot]@users.noreply.github.com",
} as const;

const MAX_PUSH_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 500;

export interface EnsureManifestArgs {
  octokit: Octokit;
  owner: string;
  repo: string;
  inputs: Inputs;
}

// 利用者が data-file-path を分けて複数 workflow から同一 repo に蓄積するケースを
// dashboard が描画できるよう、自分の path を data/manifest.json に upsert する。
// 既登録なら no-op で API call も発生しない。
export async function ensureManifestEntry(args: EnsureManifestArgs): Promise<void> {
  for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
    try {
      const upserted = await upsertOnce(args);
      if (!upserted) {
        core.info(`Manifest already lists ${args.inputs.dataFilePath}; skipping write.`);
      } else {
        core.info(`Updated ${MANIFEST_FILE_PATH} with ${args.inputs.dataFilePath}.`);
      }
      return;
    } catch (err) {
      const status = errorStatus(err);
      const retryable = status === 409 || status === 422;
      if (!retryable || attempt >= MAX_PUSH_ATTEMPTS) throw err;
      const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      core.warning(
        `Manifest conflict (status=${status}) on attempt ${attempt}/${MAX_PUSH_ATTEMPTS}. Retrying in ${delay}ms.`,
      );
      await sleep(delay);
    }
  }
}

interface ReadResult {
  manifest: Manifest;
  fileSha: string | null;
}

async function upsertOnce(args: EnsureManifestArgs): Promise<boolean> {
  const existing = await readManifest(args);
  if (existing.manifest.sources.some((s) => s.path === args.inputs.dataFilePath)) {
    return false;
  }

  const next = appendSource(existing.manifest, {
    path: args.inputs.dataFilePath,
    first_seen: Date.now(),
  });

  await args.octokit.rest.repos.createOrUpdateFileContents({
    owner: args.owner,
    repo: args.repo,
    path: MANIFEST_FILE_PATH,
    branch: args.inputs.ghPagesBranch,
    message: `chore(ghtrack): register ${args.inputs.dataFilePath} in manifest`,
    content: Buffer.from(serializeManifest(next), "utf-8").toString("base64"),
    sha: existing.fileSha ?? undefined,
    author: COMMITTER,
    committer: COMMITTER,
  });
  return true;
}

async function readManifest(args: EnsureManifestArgs): Promise<ReadResult> {
  try {
    const res = await args.octokit.rest.repos.getContent({
      owner: args.owner,
      repo: args.repo,
      path: MANIFEST_FILE_PATH,
      ref: args.inputs.ghPagesBranch,
    });

    if (Array.isArray(res.data)) {
      throw new Error(`${MANIFEST_FILE_PATH} is a directory, expected a file.`);
    }
    if (res.data.type !== "file") {
      throw new Error(`${MANIFEST_FILE_PATH} is not a regular file.`);
    }
    if (typeof res.data.content !== "string" || res.data.content.length === 0) {
      throw new Error(`${MANIFEST_FILE_PATH} content is empty or unreadable.`);
    }

    const text = Buffer.from(res.data.content, "base64").toString("utf-8");
    return { manifest: parseManifest(text), fileSha: res.data.sha };
  } catch (err) {
    if (errorStatus(err) === 404) {
      return { manifest: emptyManifest(), fileSha: null };
    }
    throw err;
  }
}

function parseManifest(text: string): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Existing manifest is not valid JSON: ${(e as Error).message}`);
  }
  if (!isManifest(parsed)) {
    throw new Error(
      `Existing manifest does not match the expected schema (schema_version=${MANIFEST_SCHEMA_VERSION}).`,
    );
  }
  return parsed;
}

function isManifest(value: unknown): value is Manifest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { schema_version?: unknown; sources?: unknown };
  if (candidate.schema_version !== MANIFEST_SCHEMA_VERSION) return false;
  if (!Array.isArray(candidate.sources)) return false;
  return candidate.sources.every(isManifestSource);
}

function isManifestSource(value: unknown): value is ManifestSource {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { path?: unknown; first_seen?: unknown };
  return (
    typeof candidate.path === "string" &&
    typeof candidate.first_seen === "number"
  );
}

function appendSource(manifest: Manifest, source: ManifestSource): Manifest {
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    sources: [...manifest.sources, source],
  };
}

export function serializeManifest(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function buildInitialManifest(dataFilePath: string): Manifest {
  return appendSource(emptyManifest(), {
    path: dataFilePath,
    first_seen: Date.now(),
  });
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

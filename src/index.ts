import * as core from "@actions/core";
import * as github from "@actions/github";
import { collectEntry } from "./collect";
import { writeEntryToGhPages } from "./storage";
import type { Inputs } from "./types";

async function run(): Promise<void> {
  try {
    const inputs = resolveInputs();
    core.setSecret(inputs.token);

    const octokit = github.getOctokit(inputs.token);
    const { owner, repo } = github.context.repo;

    const entry = await collectEntry({
      octokit,
      owner,
      repo,
      context: github.context,
    });

    const skipReason = decideSkip(github.context, inputs);
    if (skipReason !== null) {
      core.notice(`Skipping push: ${skipReason}`);
      return;
    }

    await writeEntryToGhPages({ octokit, owner, repo, inputs, entry });
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err));
  }
}

function resolveInputs(): Inputs {
  const maxItemsRaw = core.getInput("max-items-in-history");
  const maxItemsInHistory =
    maxItemsRaw === "" ? null : parsePositiveInt(maxItemsRaw, "max-items-in-history");

  return {
    token: core.getInput("github-token", { required: true }),
    ghPagesBranch: core.getInput("gh-pages-branch") || "gh-pages",
    dataFilePath: core.getInput("data-file-path") || "data/data.json",
    autoPush: core.getBooleanInput("auto-push"),
    autoCreateBranch: core.getBooleanInput("auto-create-branch"),
    maxItemsInHistory,
    skipForkPr: core.getBooleanInput("skip-fork-pr"),
  };
}

function parsePositiveInt(raw: string, name: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid value for ${name}: "${raw}" — must be a positive integer.`);
  }
  return n;
}

function decideSkip(
  context: typeof github.context,
  inputs: Inputs,
): string | null {
  if (!inputs.autoPush) {
    return "auto-push is disabled";
  }
  if (inputs.skipForkPr && isForkPullRequest(context)) {
    return "running on a pull_request from a fork (no write access to base repo)";
  }
  return null;
}

function isForkPullRequest(context: typeof github.context): boolean {
  if (
    context.eventName !== "pull_request" &&
    context.eventName !== "pull_request_target"
  ) {
    return false;
  }
  const payload = context.payload as {
    pull_request?: { head?: { repo?: { full_name?: string | null } | null } };
  };
  const headFullName = payload.pull_request?.head?.repo?.full_name ?? null;
  const baseFullName = `${context.repo.owner}/${context.repo.repo}`;
  return headFullName !== null && headFullName !== baseFullName;
}

run();

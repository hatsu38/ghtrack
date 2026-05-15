import * as core from "@actions/core";
import * as github from "@actions/github";
import { collectEntry } from "./collect";
import { writeEntryToGhPages } from "./storage";
import type { Inputs } from "./types";
import { defaultTrackName, validateTrackName } from "./workflow-file";

async function run(): Promise<void> {
  try {
    if (isForkPullRequest(github.context)) {
      core.notice(
        "Skipping ghtrack: running on a pull_request from a fork (no write access to base repo).",
      );
      return;
    }

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

    await writeEntryToGhPages({ octokit, owner, repo, inputs, entry });
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err));
  }
}

function resolveInputs(): Inputs {
  const raw = core.getInput("track-name").trim();
  let trackName: string;
  if (raw === "") {
    trackName = defaultTrackName();
  } else {
    validateTrackName(raw);
    trackName = raw;
  }

  return {
    token: core.getInput("github-token", { required: true }),
    ghPagesBranch: core.getInput("gh-pages-branch") || "gh-pages",
    trackName,
  };
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

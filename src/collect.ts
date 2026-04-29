import * as core from "@actions/core";
import * as github from "@actions/github";
import type { Entry, JobEntry, StepEntry } from "./types";
import { SCHEMA_VERSION } from "./types";

type Octokit = ReturnType<typeof github.getOctokit>;
type Context = typeof github.context;

export interface CollectArgs {
  octokit: Octokit;
  owner: string;
  repo: string;
  context: Context;
}

export async function collectEntry({
  octokit,
  owner,
  repo,
  context,
}: CollectArgs): Promise<Entry> {
  const runId = context.runId;
  core.info(`Collecting jobs for ${owner}/${repo} run ${runId}...`);

  // 注意: 自分自身の run を観測しているため、現在実行中の最後の step は
  // completed_at が null で返る。duration_sec は null のまま記録する。
  const jobs = await octokit.paginate(
    octokit.rest.actions.listJobsForWorkflowRun,
    { owner, repo, run_id: runId, per_page: 100 },
  );

  const jobEntries: JobEntry[] = jobs.map((job) => ({
    name: job.name,
    duration_sec: computeDurationSec(job.started_at, job.completed_at),
    status: job.status,
    conclusion: job.conclusion,
    steps: (job.steps ?? []).map(toStepEntry),
  }));

  logSummary(jobEntries);

  return {
    schema_version: SCHEMA_VERSION,
    commit: context.sha,
    branch: resolveBranch(context),
    event: context.eventName,
    date: Date.now(),
    workflow: context.workflow,
    workflow_file: resolveWorkflowFile(),
    run_id: runId,
    run_attempt: resolveRunAttempt(),
    total_duration_sec: computeTotalDurationSec(jobs),
    jobs: jobEntries,
  };
}

function toStepEntry(step: {
  name: string;
  number: number;
  status: string | null;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}): StepEntry {
  return {
    name: step.name,
    number: step.number,
    duration_sec: computeDurationSec(step.started_at, step.completed_at),
    status: step.status,
    conclusion: step.conclusion,
  };
}

function computeDurationSec(
  startedAt: string | null | undefined,
  completedAt: string | null | undefined,
): number | null {
  if (!startedAt || !completedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(completedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return (end - start) / 1000;
}

function computeTotalDurationSec(
  jobs: ReadonlyArray<{ started_at?: string | null; completed_at?: string | null }>,
): number | null {
  const starts = jobs
    .map((j) => j.started_at)
    .filter((v): v is string => typeof v === "string")
    .map((v) => new Date(v).getTime())
    .filter((v) => !Number.isNaN(v));
  const ends = jobs
    .map((j) => j.completed_at)
    .filter((v): v is string => typeof v === "string")
    .map((v) => new Date(v).getTime())
    .filter((v) => !Number.isNaN(v));
  if (starts.length === 0 || ends.length === 0) return null;
  return (Math.max(...ends) - Math.min(...starts)) / 1000;
}

function resolveBranch(context: Context): string | null {
  if (
    context.eventName === "pull_request" ||
    context.eventName === "pull_request_target"
  ) {
    const headRef = (
      context.payload as { pull_request?: { head?: { ref?: string } } }
    ).pull_request?.head?.ref;
    return typeof headRef === "string" ? headRef : null;
  }
  if (context.ref.startsWith("refs/heads/")) {
    return context.ref.slice("refs/heads/".length);
  }
  return null;
}

function resolveWorkflowFile(): string {
  // GITHUB_WORKFLOW_REF 例:
  //   "<owner>/<repo>/.github/workflows/test.yml@refs/heads/main"
  const ref = process.env.GITHUB_WORKFLOW_REF ?? "";
  const beforeAt = ref.split("@")[0] ?? "";
  const parts = beforeAt.split("/");
  return parts[parts.length - 1] ?? "";
}

function resolveRunAttempt(): number {
  const raw = process.env.GITHUB_RUN_ATTEMPT;
  const parsed = raw ? Number.parseInt(raw, 10) : 1;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function logSummary(jobs: ReadonlyArray<JobEntry>): void {
  for (const job of jobs) {
    core.info(
      [
        `Job: ${job.name}`,
        `status=${job.status ?? "-"}`,
        `conclusion=${job.conclusion ?? "-"}`,
        `duration=${formatDurationSec(job.duration_sec)}`,
      ].join(" | "),
    );
    for (const step of job.steps) {
      core.info(
        [
          `  Step ${step.number}: ${step.name}`,
          `status=${step.status ?? "-"}`,
          `conclusion=${step.conclusion ?? "-"}`,
          `duration=${formatDurationSec(step.duration_sec)}`,
        ].join(" | "),
      );
    }
  }
}

function formatDurationSec(durationSec: number | null): string {
  return durationSec === null ? "-" : `${durationSec.toFixed(2)}s`;
}

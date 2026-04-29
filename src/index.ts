import * as core from "@actions/core";
import * as github from "@actions/github";

type Octokit = ReturnType<typeof github.getOctokit>;

async function run(): Promise<void> {
  try {
    core.info("Hello from ghtrack!");

    const token = core.getInput("github-token", { required: true });
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;
    const runId = github.context.runId;

    core.info(`Repository: ${owner}/${repo}`);
    core.info(`Workflow run id: ${runId}`);

    await logJobAndStepDurations(octokit, owner, repo, runId);
  } catch (err) {
    if (err instanceof Error) {
      core.setFailed(err.message);
    } else {
      core.setFailed(String(err));
    }
  }
}

async function logJobAndStepDurations(
  octokit: Octokit,
  owner: string,
  repo: string,
  runId: number,
): Promise<void> {
  // 注意: 自分自身の run を観測しているため、現在実行中の最後の step は
  // completed_at が null になる。v0.1.0 ではこの仕様を許容する。
  const jobs = await octokit.paginate(
    octokit.rest.actions.listJobsForWorkflowRun,
    { owner, repo, run_id: runId, per_page: 100 },
  );

  for (const job of jobs) {
    const jobDuration = computeDurationSec(job.started_at, job.completed_at);
    core.info(
      [
        `Job: ${job.name}`,
        `status=${job.status}`,
        `conclusion=${job.conclusion ?? "-"}`,
        `started_at=${job.started_at ?? "-"}`,
        `completed_at=${job.completed_at ?? "-"}`,
        `duration=${formatDurationSec(jobDuration)}`,
      ].join(" | "),
    );

    for (const step of job.steps ?? []) {
      const stepDuration = computeDurationSec(
        step.started_at,
        step.completed_at,
      );
      core.info(
        [
          `  Step ${step.number}: ${step.name}`,
          `status=${step.status}`,
          `conclusion=${step.conclusion ?? "-"}`,
          `started_at=${step.started_at ?? "-"}`,
          `completed_at=${step.completed_at ?? "-"}`,
          `duration=${formatDurationSec(stepDuration)}`,
        ].join(" | "),
      );
    }
  }
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

function formatDurationSec(durationSec: number | null): string {
  return durationSec === null ? "-" : `${durationSec.toFixed(2)}s`;
}

run();

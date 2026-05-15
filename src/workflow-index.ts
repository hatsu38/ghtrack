import type { WorkflowIndex, WorkflowIndexRun } from "./types";
import { WORKFLOW_INDEX_SCHEMA_VERSION, emptyWorkflowIndex } from "./types";
import { workflowDir } from "./manifest";

// data/{track_name}/index.json
export function workflowIndexPath(trackName: string): string {
  return `${workflowDir(trackName)}/index.json`;
}

export function parseWorkflowIndex(text: string): WorkflowIndex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `Existing workflow index is not valid JSON: ${(e as Error).message}`,
    );
  }
  if (!isWorkflowIndex(parsed)) {
    throw new Error(
      `Existing workflow index does not match the expected schema ` +
        `(schema_version=${WORKFLOW_INDEX_SCHEMA_VERSION}).`,
    );
  }
  return parsed;
}

function isWorkflowIndex(value: unknown): value is WorkflowIndex {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    schema_version?: unknown;
    track_name?: unknown;
    runs?: unknown;
    last_updated?: unknown;
  };
  if (candidate.schema_version !== WORKFLOW_INDEX_SCHEMA_VERSION) return false;
  if (typeof candidate.track_name !== "string") return false;
  if (!Array.isArray(candidate.runs)) return false;
  if (!candidate.runs.every(isWorkflowIndexRun)) return false;
  if (typeof candidate.last_updated !== "number") return false;
  return true;
}

function isWorkflowIndexRun(value: unknown): value is WorkflowIndexRun {
  if (typeof value !== "object" || value === null) return false;
  const c = value as { date?: unknown; run_id?: unknown; run_attempt?: unknown };
  return (
    typeof c.date === "string" &&
    typeof c.run_id === "number" &&
    typeof c.run_attempt === "number"
  );
}

export function serializeWorkflowIndex(index: WorkflowIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}

// runs は (run_id, run_attempt) で一意。既に登録済みなら no-op、無ければ追加して
// run_id 昇順 (同 run_id なら run_attempt 昇順) でソートする。
export function upsertRun(
  index: WorkflowIndex,
  run: WorkflowIndexRun,
  now: number,
): WorkflowIndex {
  const exists = index.runs.some(
    (r) => r.run_id === run.run_id && r.run_attempt === run.run_attempt,
  );
  const runs = exists
    ? index.runs
    : [...index.runs, run].sort(compareRuns);
  return {
    schema_version: WORKFLOW_INDEX_SCHEMA_VERSION,
    track_name: index.track_name,
    runs,
    last_updated: now,
  };
}

function compareRuns(a: WorkflowIndexRun, b: WorkflowIndexRun): number {
  if (a.run_id !== b.run_id) return a.run_id - b.run_id;
  return a.run_attempt - b.run_attempt;
}

export function buildInitialWorkflowIndex(
  trackName: string,
  run: WorkflowIndexRun,
  now: number,
): WorkflowIndex {
  return upsertRun(emptyWorkflowIndex(trackName), run, now);
}

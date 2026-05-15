export const SCHEMA_VERSION = 1 as const;
export const MANIFEST_SCHEMA_VERSION = 2 as const;
export const WORKFLOW_INDEX_SCHEMA_VERSION = 1 as const;

export interface StepEntry {
  name: string;
  number: number;
  // null = 未完了(自分自身の最終 step など、completed_at が null の場合)
  duration_sec: number | null;
  status: string | null;
  conclusion: string | null;
}

export interface JobEntry {
  name: string;
  duration_sec: number | null;
  status: string | null;
  conclusion: string | null;
  steps: StepEntry[];
}

export interface Entry {
  schema_version: typeof SCHEMA_VERSION;
  commit: string;
  branch: string | null;
  event: string;
  date: number;
  workflow: string;
  workflow_file: string;
  run_id: number;
  run_attempt: number;
  total_duration_sec: number | null;
  jobs: JobEntry[];
}

export interface Inputs {
  token: string;
  ghPagesBranch: string;
  trackName: string;
}

export interface ManifestWorkflow {
  track_name: string;
  dir: string;
  first_seen: number;
}

export interface Manifest {
  schema_version: typeof MANIFEST_SCHEMA_VERSION;
  workflows: ManifestWorkflow[];
}

export function emptyManifest(): Manifest {
  return { schema_version: MANIFEST_SCHEMA_VERSION, workflows: [] };
}

// 1 workflow (= 1 track) 配下に存在する run の一覧。dashboard が run ファイルへの
// パスを構築するために必要。runs は run_id 昇順で保持する。
// 権威データは per-run file 側にあるため、index が壊れても tree 列挙から再生成可能。
export interface WorkflowIndexRun {
  date: string; // "YYYY/MM/DD"
  run_id: number;
  run_attempt: number;
}

export interface WorkflowIndex {
  schema_version: typeof WORKFLOW_INDEX_SCHEMA_VERSION;
  track_name: string;
  runs: WorkflowIndexRun[];
  last_updated: number;
}

export function emptyWorkflowIndex(trackName: string): WorkflowIndex {
  return {
    schema_version: WORKFLOW_INDEX_SCHEMA_VERSION,
    track_name: trackName,
    runs: [],
    last_updated: 0,
  };
}

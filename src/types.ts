export const SCHEMA_VERSION = 1 as const;

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

export interface DataFile {
  schema_version: typeof SCHEMA_VERSION;
  entries: Entry[];
}

export interface Inputs {
  token: string;
  ghPagesBranch: string;
  dataFilePath: string;
  autoPush: boolean;
  autoCreateBranch: boolean;
  maxItemsInHistory: number | null;
  skipForkPr: boolean;
}

export function emptyDataFile(): DataFile {
  return { schema_version: SCHEMA_VERSION, entries: [] };
}

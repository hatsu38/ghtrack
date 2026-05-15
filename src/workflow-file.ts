// GITHUB_WORKFLOW_REF 例:
//   "<owner>/<repo>/.github/workflows/test.yml@refs/heads/main"
// ファイル名ベース (basename) は workflow YAML の name 属性より安定しており、
// ユーザーが name を変更してもデータの蓄積先が変わらない。
export function resolveWorkflowFileBasename(): string {
  const ref = process.env.GITHUB_WORKFLOW_REF ?? "";
  const beforeAt = ref.split("@")[0] ?? "";
  const parts = beforeAt.split("/");
  return parts[parts.length - 1] ?? "";
}

const TRACK_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

export function validateTrackName(name: string): void {
  if (!TRACK_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid track-name "${name}". Must match ${TRACK_NAME_PATTERN.source} ` +
        "(alphanumeric, dot, underscore, hyphen).",
    );
  }
}

export function defaultTrackName(): string {
  const basename = resolveWorkflowFileBasename();
  if (basename === "") {
    throw new Error(
      "Could not resolve the workflow file name from GITHUB_WORKFLOW_REF. " +
        "Set `track-name` explicitly to override.",
    );
  }
  const stem = basename.replace(/\.ya?ml$/i, "");
  validateTrackName(stem);
  return stem;
}

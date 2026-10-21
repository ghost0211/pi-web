export type GitFileStatusKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflict";

export interface GitFileStatus {
  filePath: string;
  status: GitFileStatusKind;
  code: "M" | "A" | "D" | "R" | "U" | "C";
  indexStatus: string;
  worktreeStatus: string;
}

export interface GitStatusResponse {
  isGitRepository: boolean;
  repositoryRoot: string | null;
  files: GitFileStatus[];
  additions: number;
  deletions: number;
}

/**
 * Why a file has no diff. The viewer shows this instead of silently falling
 * back to a plain source view, which looked like "the diff is broken".
 */
export type GitDiffUnavailableReason =
  | "not-a-repository"
  | "outside-repository"
  | "unchanged"
  | "ignored"
  | "binary"
  | "too-large"
  | "not-found"
  | "unreadable";

export interface GitFileDiffResponse {
  supported: boolean;
  status?: GitFileStatusKind;
  patch?: string;
  reason?: GitDiffUnavailableReason;
}

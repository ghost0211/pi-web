/**
 * Contract of `POST /api/ssh/mount`, shared by the route and the picker.
 *
 * The picker used to declare its own `MountResponse` while the route answered
 * `{ localPath }`, so a successful mount produced `HTTP 200` in the UI: the
 * response was fine, the client simply had no `ok`/`mountPoint` to read. Keeping
 * one definition makes that drift a type error instead of a runtime surprise.
 */
export interface MountResponse {
  /** true only when the remote directory is reachable at `mountPoint`. */
  ok?: boolean;
  driveLetter?: string;
  /** Local path to use as the session cwd. */
  mountPoint?: string;
  /** Remote path as resolved (absolute, after `~` expansion). */
  remotePath?: string;
  /** An existing mapping of the same host root was reused. */
  reused?: boolean;
  backend?: "sshfs" | "unc";
  error?: string;
  detail?: string;
  needsSshfsWin?: boolean;
}

/** Success payload builder; the only place that decides the field names. */
export function mountedResponse(input: {
  driveLetter: string;
  mountPoint: string;
  remotePath: string;
  reused: boolean;
  backend: "sshfs" | "unc";
}): MountResponse {
  return {
    ok: true,
    driveLetter: input.driveLetter,
    mountPoint: input.mountPoint,
    remotePath: input.remotePath,
    reused: input.reused,
    backend: input.backend,
  };
}

/** Failure payload builder. */
export function mountFailure(error: string, extra: Omit<MountResponse, "ok" | "error"> = {}): MountResponse {
  return { ok: false, error, ...extra };
}

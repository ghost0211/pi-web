type SessionGuardState = {
  activeMutations: number;
  deletionToken?: symbol;
};

declare global {
  // Kept on globalThis because Next.js hot reload replaces this module while
  // route requests and SDK startup promises can still be in flight.
  var __piSessionDeletionGuards: Map<string, SessionGuardState> | undefined;
}

const MUTATION_BLOCKED_CODE = "PI_SESSION_DELETION_IN_PROGRESS";
const BARRIER_CONFLICT_CODE = "PI_SESSION_DELETE_BARRIER_CONFLICT";

export class SessionMutationBlockedError extends Error {
  readonly code = MUTATION_BLOCKED_CODE;

  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} is being permanently deleted; retry after deletion completes`);
    this.name = "SessionMutationBlockedError";
  }
}

export class SessionDeletionBarrierConflictError extends Error {
  readonly code = BARRIER_CONFLICT_CODE;

  constructor(
    readonly sessionId: string,
    readonly reason: "mutation-in-progress" | "deletion-in-progress",
  ) {
    super(reason === "mutation-in-progress"
      ? `Session ${sessionId} is starting or being modified; wait for that operation to finish and retry deletion`
      : `Session ${sessionId} is already being permanently deleted`);
    this.name = "SessionDeletionBarrierConflictError";
  }
}

export function isSessionDeletionGuardError(error: unknown): error is Error & { code: string } {
  return typeof error === "object" && error !== null
    && "code" in error
    && ((error as { code?: unknown }).code === MUTATION_BLOCKED_CODE
      || (error as { code?: unknown }).code === BARRIER_CONFLICT_CODE);
}

function getStates(): Map<string, SessionGuardState> {
  if (!globalThis.__piSessionDeletionGuards) globalThis.__piSessionDeletionGuards = new Map();
  return globalThis.__piSessionDeletionGuards;
}

function cleanState(sessionId: string, state: SessionGuardState): void {
  if (state.activeMutations === 0 && !state.deletionToken && getStates().get(sessionId) === state) {
    getStates().delete(sessionId);
  }
}

/** Track one operation that may start or mutate the SDK session / JSONL file. */
export async function withSessionMutationGuard<T>(
  sessionId: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  const states = getStates();
  let state = states.get(sessionId);
  if (state?.deletionToken) throw new SessionMutationBlockedError(sessionId);
  if (!state) {
    state = { activeMutations: 0 };
    states.set(sessionId, state);
  }
  state.activeMutations += 1;

  try {
    return await operation();
  } finally {
    state.activeMutations -= 1;
    cleanState(sessionId, state);
  }
}

export interface SessionDeletionBarrier {
  /** Atomically protect more ids before inspecting or rewriting dependents. */
  add(sessionIds: Iterable<string>): void;
  /** Always release in a finally block; idempotent for defensive cleanup. */
  release(): void;
}

/**
 * Synchronously reserve ids for deletion. Existing mutations/startups are
 * refused rather than waited on, so callers never race an unbounded SDK task.
 */
export function beginSessionDeletion(sessionIds: Iterable<string>): SessionDeletionBarrier {
  const states = getStates();
  const token = Symbol("session-deletion");
  const protectedIds = new Set<string>();
  let released = false;

  const add = (ids: Iterable<string>) => {
    if (released) throw new Error("Cannot extend a released session deletion barrier");
    const additions = [...new Set(ids)].filter((id) => !protectedIds.has(id));

    // Validate the complete set before marking any new id, keeping extension
    // atomic when one dependent is already starting or being mutated.
    for (const sessionId of additions) {
      const state = states.get(sessionId);
      if (state?.deletionToken) {
        throw new SessionDeletionBarrierConflictError(sessionId, "deletion-in-progress");
      }
      if (state && state.activeMutations > 0) {
        throw new SessionDeletionBarrierConflictError(sessionId, "mutation-in-progress");
      }
    }

    for (const sessionId of additions) {
      const state = states.get(sessionId) ?? { activeMutations: 0 };
      state.deletionToken = token;
      states.set(sessionId, state);
      protectedIds.add(sessionId);
    }
  };

  add(sessionIds);

  return {
    add,
    release() {
      if (released) return;
      released = true;
      for (const sessionId of protectedIds) {
        const state = states.get(sessionId);
        if (state?.deletionToken !== token) continue;
        delete state.deletionToken;
        cleanState(sessionId, state);
      }
      protectedIds.clear();
    },
  };
}

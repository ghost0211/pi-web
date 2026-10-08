import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  attachSessionProjectInfo,
  resolveSessionPath,
  resolveSessionIdByPath,
  invalidateSessionPathCache,
  invalidateSessionListCache,
  buildSessionContext,
  buildSessionHistory,
  buildSessionTurnIndex,
  readSessionHeader,
  getAgentDir,
} from "@/lib/session-reader";
import { sessionPathKey } from "@/lib/session-path";
import { getLoadedRpcDependentSessionIds, getRpcSession, isRpcSessionStarting } from "@/lib/rpc-manager";
import { beginSessionDeletion, isSessionDeletionGuardError, withSessionMutationGuard } from "@/lib/session-deletion-guard";
import { projectTreeForResponse, stripLabelEntries } from "@/lib/project-tree";
import { computeSessionTotalActiveMs } from "@/lib/session-timing";
import { computeSessionStats } from "@/lib/session-stats";
import type { SessionEntry } from "@/lib/types";
import { readSubagentRun, readSubagentSessionResources, SUBAGENT_META_TYPE } from "@/lib/subagents";
import { readSessionToolSelection } from "@/lib/session-tool-selection";
import lockfile from "proper-lockfile";
import { jsonResponse } from "@/lib/json-response";
import { forgetDeletedSessionMetadata } from "@/lib/session-management-store";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const rpc = getRpcSession(id);
    const searchParams = new URL(req.url).searchParams;
    const force = searchParams.get("force") === "1";

    // A live wrapper only reflects the appends pi-web itself made. When another
    // pi process (the TUI) writes the same session file, the in-memory index
    // stays stale. Only probe on ?force=1 (session mount / page refresh): two
    // processes writing one JSONL is unsupported, so post-turn reads must not
    // scan disk. Eviction is idle-only; mid-run the wrapper owns the write path.
    let liveWrapper = rpc?.isAlive() ? rpc : undefined;
    let wrapperRebuilt = false;
    if (force && liveWrapper?.evictIfDiskAhead()) {
      wrapperRebuilt = true;
      liveWrapper = undefined;
    }
    const liveRpc = liveWrapper;
    const resolvedPath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !resolvedPath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = liveRpc?.inner.sessionManager ?? SessionManager.open(resolvedPath!);
    const filePath = liveRpc?.sessionFile || sm.getSessionFile() || resolvedPath || "";
    const entries = sm.getEntries();
    const leafId = sm.getLeafId();
    const tree = projectTreeForResponse(stripLabelEntries(sm.getTree()));
    const deferThinking = searchParams.has("deferThinking");
    const deferToolResultImages = searchParams.has("deferMedia");
    const rawTail = Number(searchParams.get("tail"));
    const tail = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 1000) : 50;
    const contextOptions = {
      deferThinking,
      deferToolResultImages,
      tail,
      sessionId: id, // local: lazy URLs for historical tool-result images
    };
    // Keep the SDK-selected, compaction-aware context separate from the raw
    // active-branch history. The model uses `context`; the UI renders `history`.
    const context = buildSessionContext(entries as never, leafId, contextOptions);
    const history = buildSessionHistory(entries as never, leafId, contextOptions);
    // Whole-branch turn index for the chat's turn rail: the client only
    // receives `history`'s page, so the rail needs the full turn list to show
    // where every turn sits before the user scrolls back.
    const turnIndex = buildSessionTurnIndex(entries as never, leafId);
    const totalActiveMs = computeSessionTotalActiveMs(entries);
    // Cumulative usage over ALL entries, including history compacted away —
    // the same aggregation the SDK's getSessionStats() uses. Lets the client
    // keep monotonic token/cost counters across compaction and page reloads.
    const stats = computeSessionStats(entries as unknown as SessionEntry[]);
    const sessionName = sm.getSessionName();
    const firstUserEntry = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
    const firstUserMessage = firstUserEntry?.type === "message" ? firstUserEntry.message : undefined;

    const header = sm.getHeader();
    let modified = header?.timestamp ?? new Date().toISOString();
    try { modified = statSync(filePath).mtime.toISOString(); } catch { /* use header timestamp */ }
    const parentSessionId = header?.parentSession
      ? await resolveSessionIdByPath(header.parentSession)
      : undefined;
    const subagent = header
      ? readSubagentRun(entries as never, header.id, filePath)
      : null;
    const toolNames = readSubagentSessionResources(entries as never)?.tools
      ?? readSessionToolSelection(entries as never);
    const info = header ? (await attachSessionProjectInfo([{
      path: filePath,
      id: header.id,
      cwd: header.cwd ?? "",
      name: sessionName,
      created: header.timestamp,
      modified,
      messageCount: stats.totalMessages,
      firstMessage: firstUserMessage
        ? (() => {
            const c = (firstUserMessage as { content: unknown }).content;
            return typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b: { type: string }) => b.type === "text") as { text: string } | undefined)?.text ?? "" : "") || "(no messages)";
          })()
        : "(no messages)",
      parentSessionId,
      ...(subagent
        ? { relation: { kind: "subagent" as const, parentSessionId: subagent.parentSessionId, profile: subagent.profile, description: subagent.description, status: liveRpc?.isRunning() ? "running" as const : subagent.status } }
        : header.parentSession
          ? { relation: { kind: "fork" as const, ...(parentSessionId ? { originSessionId: parentSessionId } : {}) } }
          : {}),
      transient: !filePath || !existsSync(filePath),
    }]))[0] : null;

    return jsonResponse(
      req,
      {
        sessionId: id,
        filePath,
        info,
        leafId,
        tree,
        context,
        history,
        turnIndex,
        stats,
        totalActiveMs,
        ...(toolNames !== undefined ? { toolNames } : {}),
        ...(wrapperRebuilt ? { wrapperRebuilt: true } : {}),
      },
    );
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PATCH /api/sessions/[id]  body: { name: string }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    return await withSessionMutationGuard(id, async () => {
      const { name } = await req.json() as { name?: string };
      if (typeof name !== "string") {
        return NextResponse.json({ error: "name is required" }, { status: 400 });
      }
      const filePath = await resolveSessionPath(id);
      if (!filePath) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      const sm = SessionManager.open(filePath);
      sm.appendSessionInfo(name.trim());
      invalidateSessionListCache();
      return NextResponse.json({ ok: true });
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
    }, { status: isSessionDeletionGuardError(error) ? 409 : 500 });
  }
}

declare global {
  // One queue for this Node process (and across Next hot reloads), covering the
  // entire read/reparent/shutdown/unlink transaction for each DELETE request.
  var __piSessionDeleteQueue: Promise<void> | undefined;
}

class SessionDeleteConflictError extends Error {}

interface SessionRewritePlan {
  path: string;
  original: string;
  rewritten: string;
  mode: number;
}

function isSessionBusy(session: ReturnType<typeof getRpcSession>): boolean {
  if (!session) return false;
  const internals = session as unknown as {
    activeMutatingCommands?: number;
    sessionReplacement?: unknown;
  };
  return session.isRunning()
    || Boolean(session.hasMcpActionInProgress?.())
    || (typeof internals.activeMutatingCommands === "number" && internals.activeMutatingCommands > 0)
    || Boolean(internals.sessionReplacement);
}

async function serializeSessionDeletes<T>(task: () => Promise<T>): Promise<T> {
  const previous = globalThis.__piSessionDeleteQueue ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  globalThis.__piSessionDeleteQueue = current;
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (globalThis.__piSessionDeleteQueue === current) globalThis.__piSessionDeleteQueue = undefined;
  }
}

async function withCrossProcessSessionDeleteLock<T>(task: () => Promise<T>): Promise<T> {
  const directory = join(getAgentDir(), "pi-web");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, "session-delete.lock");
  try {
    writeFileSync(lockPath, "", { encoding: "utf8", flag: "wx", mode: 0o600, flush: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const lockInfo = lstatSync(lockPath);
  if (!lockInfo.isFile() || lockInfo.isSymbolicLink()) throw new Error("Unsafe session deletion lock file");

  let compromised: Error | undefined;
  const release = await lockfile.lock(lockPath, {
    retries: { retries: 10, factor: 2, minTimeout: 50, maxTimeout: 1_000, randomize: true },
    stale: 60_000,
    onCompromised: (error) => { compromised = error; },
  });
  let operationError: unknown;
  let taskCompleted = false;
  try {
    if (compromised) throw compromised;
    const result = await task();
    taskCompleted = true;
    return result;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await release();
    } catch (error) {
      if (!taskCompleted && operationError === undefined) throw error;
    }
    // Once the handler has produced its result, retain truthful per-item delete
    // semantics even if releasing the coordination lock reports an error.
    if (compromised && !taskCompleted && operationError === undefined) throw compromised;
  }
}

function writeSessionFileAtomically(path: string, contents: string, mode: number): void {
  const temporaryPath = join(dirname(path), `.${basename(path)}-${randomUUID()}.delete.tmp`);
  try {
    writeFileSync(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode, flush: true });
    chmodSync(temporaryPath, mode);
    renameSync(temporaryPath, path);
  } finally {
    try { unlinkSync(temporaryPath); } catch { /* rename already consumed it */ }
  }
}

function findDirectDependentSessionIds(filePath: string, targetPathKey: string): string[] {
  const directory = dirname(filePath);
  const files = readdirSync(directory).filter((file) => (
    file.endsWith(".jsonl") && sessionPathKey(join(directory, file)) !== targetPathKey
  ));
  const dependents = new Map<string, string>();
  for (const file of files) {
    const childPath = join(directory, file);
    const header = readSessionHeader(childPath);
    if (!header || typeof header.parentSession !== "string" || !header.parentSession
      || sessionPathKey(header.parentSession) !== targetPathKey) continue;
    if (typeof header.id !== "string" || !header.id) {
      throw new SessionDeleteConflictError(`Cannot safely delete this session because dependent file ${childPath} has no session id`);
    }
    const previousPath = dependents.get(header.id);
    if (previousPath && previousPath !== childPath) {
      throw new SessionDeleteConflictError(`Cannot safely delete this session because dependent session id ${header.id} appears in multiple files`);
    }
    dependents.set(header.id, childPath);
  }
  return [...dependents.keys()];
}

function makeSessionRewritePlans(
  filePath: string,
  parentSessionPath: string | undefined,
  parentSessionId: string | undefined,
  targetPathKey: string,
  protectedDependentIds: ReadonlySet<string>,
): SessionRewritePlan[] {
  const directory = dirname(filePath);
  const files = readdirSync(directory).filter((file) => (
    file.endsWith(".jsonl") && sessionPathKey(join(directory, file)) !== targetPathKey
  ));
  const plans: SessionRewritePlan[] = [];
  for (const file of files) {
    const childPath = join(directory, file);
    const boundedHeader = readSessionHeader(childPath);
    if (!boundedHeader || typeof boundedHeader.parentSession !== "string" || !boundedHeader.parentSession
      || sessionPathKey(boundedHeader.parentSession) !== targetPathKey) continue;

    if (typeof boundedHeader.id !== "string" || !boundedHeader.id
      || !protectedDependentIds.has(boundedHeader.id)) {
      throw new SessionDeleteConflictError(`Dependent sessions changed while deletion was being prepared; retry deletion`);
    }
    if (isRpcSessionStarting(boundedHeader.id)) {
      throw new SessionDeleteConflictError(`Cannot delete this session while dependent session ${boundedHeader.id} is starting in Pi Web`);
    }
    const childLive = getRpcSession(boundedHeader.id);
    if (childLive?.isAlive()) {
      throw new SessionDeleteConflictError(`Cannot delete this session while dependent session ${boundedHeader.id} is loaded in Pi Web (even if idle); wait until it is unloaded, then retry`);
    }

    // Read/rewrite only valid direct dependents. Their filesystem errors must
    // fail the delete rather than silently leave a broken relation behind.
    const original = readFileSync(childPath, "utf8");
    const lines = original.split("\n");
    let header: { type?: string; id?: string; parentSession?: string };
    try {
      header = JSON.parse(lines[0]) as { type?: string; id?: string; parentSession?: string };
    } catch {
      throw new SessionDeleteConflictError(`Dependent session ${boundedHeader.id} changed while deletion was being prepared; retry deletion`);
    }
    if (header.type !== "session" || header.id !== boundedHeader.id
      || typeof header.parentSession !== "string" || !header.parentSession
      || sessionPathKey(header.parentSession) !== targetPathKey) {
      throw new SessionDeleteConflictError(`Dependent session ${boundedHeader.id} changed while deletion was being prepared; retry deletion`);
    }

    // Re-attach direct children to the deleted session's parent. This keeps
    // fork headers and subagent metadata in sync, matching prior behavior.
    header.parentSession = parentSessionPath;
    lines[0] = JSON.stringify(header);
    if (parentSessionPath && parentSessionId) {
      for (let index = 1; index < lines.length; index += 1) {
        let entry: { type?: string; customType?: string; data?: unknown };
        try {
          entry = JSON.parse(lines[index]);
        } catch {
          continue;
        }
        if (entry.type !== "custom" || entry.customType !== SUBAGENT_META_TYPE
          || typeof entry.data !== "object" || entry.data === null || Array.isArray(entry.data)) continue;
        entry.data = { ...entry.data, parentSessionId, parentSessionPath };
        lines[index] = JSON.stringify(entry);
        break;
      }
    }
    plans.push({
      path: childPath,
      original,
      rewritten: lines.join("\n"),
      mode: statSync(childPath).mode & 0o777,
    });
  }
  return plans;
}

function rollbackSessionRewrites(rewritten: SessionRewritePlan[]): string[] {
  const failures: string[] = [];
  for (const plan of [...rewritten].reverse()) {
    try {
      writeSessionFileAtomically(plan.path, plan.original, plan.mode);
    } catch (error) {
      failures.push(`${plan.path}: ${String(error)}`);
    }
  }
  return failures;
}

function deleteError(message: string, status: number): Response {
  return NextResponse.json({ error: message, deleted: false }, { status });
}

// DELETE /api/sessions/[id] requires { confirm: true } before any runtime or
// filesystem deletion. The client sends one item at a time for per-item results.
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return deleteError("Permanent deletion requires a JSON body with confirm: true", 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)
    || (body as { confirm?: unknown }).confirm !== true) {
    return deleteError("Permanent deletion requires confirm: true", 400);
  }

  const { id } = await params;
  try {
    return await serializeSessionDeletes(() => withCrossProcessSessionDeleteLock(async () => {
    let deletionBarrier: ReturnType<typeof beginSessionDeletion>;
    try {
      deletionBarrier = beginSessionDeletion([id]);
    } catch (error) {
      if (isSessionDeletionGuardError(error)) return deleteError(error.message, 409);
      throw error;
    }

    try {
      const liveTarget = getRpcSession(id);
      if (isSessionBusy(liveTarget)) {
        return deleteError("Cannot permanently delete a session while it is running or busy", 409);
      }
      // A startup started before a hot reload may still be represented only in
      // the legacy global start-lock map, not in the new per-id guard.
      if (isRpcSessionStarting(id)) {
        return deleteError(`Session ${id} is still starting in Pi Web; wait for startup to finish and retry deletion`, 409);
      }

      const filePath = await resolveSessionPath(id);
      const targetSessionPath = filePath
        || liveTarget?.inner?.sessionManager?.getSessionFile?.()
        || liveTarget?.sessionFile;
      const loadedDependentIds = getLoadedRpcDependentSessionIds(id, targetSessionPath || undefined);
      try {
        // Keep discovered in-memory children behind the same mutation barrier
        // as persisted children, even though deletion will be refused below.
        deletionBarrier.add(loadedDependentIds);
      } catch (error) {
        if (isSessionDeletionGuardError(error)) return deleteError(error.message, 409);
        throw error;
      }
      if (loadedDependentIds.length > 0) {
        return deleteError(
          `Cannot permanently delete this session while dependent session ${loadedDependentIds[0]} is loaded in Pi Web (even if idle); wait until it is unloaded, then retry`,
          409,
        );
      }

      if (!filePath) {
        // Ephemeral sessions have no JSONL file; deleting one means shutting
        // down its idle runtime. Never abort a running session implicitly.
        if (!liveTarget?.isAlive()) return NextResponse.json({ error: "Session not found", deleted: false }, { status: 404 });
        await liveTarget.shutdown();
        invalidateSessionListCache();
        try {
          await forgetDeletedSessionMetadata(id);
        } catch (error) {
          return NextResponse.json({
            ok: true,
            deleted: true,
            warnings: [`Session was deleted, but management metadata cleanup failed: ${String(error)}`],
          }, { status: 200 });
        }
        return NextResponse.json({ ok: true, deleted: true });
      }

      const targetHeader = readSessionHeader(filePath);
      if (!targetHeader || targetHeader.id !== id) {
        return deleteError("Session header is unreadable or does not match the requested session", 409);
      }
      const parentSessionPath = typeof targetHeader.parentSession === "string" && targetHeader.parentSession
        ? targetHeader.parentSession
        : undefined;
      const parentSessionId = parentSessionPath ? readSessionHeader(parentSessionPath)?.id : undefined;
      const targetPathKey = sessionPathKey(filePath);
      const dependentIds = findDirectDependentSessionIds(filePath, targetPathKey);
      try {
        deletionBarrier.add(dependentIds);
      } catch (error) {
        if (isSessionDeletionGuardError(error)) return deleteError(error.message, 409);
        throw error;
      }
      for (const dependentId of dependentIds) {
        if (isRpcSessionStarting(dependentId)) {
          return deleteError(`Dependent session ${dependentId} is still starting in Pi Web; wait for startup to finish and retry deletion`, 409);
        }
      }

      const protectedDependentIds = new Set(dependentIds);
      const plans = makeSessionRewritePlans(
        filePath,
        parentSessionPath,
        parentSessionId,
        targetPathKey,
        protectedDependentIds,
      );
      const rewritten: SessionRewritePlan[] = [];

      try {
        if (isSessionBusy(liveTarget)) {
          throw new SessionDeleteConflictError("Cannot permanently delete a session while it is running or busy");
        }
        for (const plan of plans) {
          writeSessionFileAtomically(plan.path, plan.rewritten, plan.mode);
          rewritten.push(plan);
        }
        // The target and all direct dependents remain barred through shutdown,
        // unlink, rollback, and metadata cleanup. No new start/prompt/PATCH can
        // recreate or append to either side while shutdown is awaited.
        if (isSessionBusy(liveTarget)) {
          throw new SessionDeleteConflictError("Cannot permanently delete a session while it is running or busy");
        }
        if (liveTarget?.isAlive()) await liveTarget.shutdown();
        unlinkSync(filePath);
      } catch (error) {
        const rollbackFailures = rollbackSessionRewrites(rewritten);
        if (rollbackFailures.length) {
          throw new Error(`${String(error)}; dependent-session rollback also failed: ${rollbackFailures.join("; ")}`);
        }
        throw error;
      }

      invalidateSessionPathCache(id);
      invalidateSessionListCache();
      try {
        await forgetDeletedSessionMetadata(id);
      } catch (error) {
        return NextResponse.json({
          ok: true,
          deleted: true,
          warnings: [`Session was deleted, but management metadata cleanup failed: ${String(error)}`],
        }, { status: 200 });
      }
      return NextResponse.json({ ok: true, deleted: true });
    } catch (error) {
      if (error instanceof SessionDeleteConflictError) return deleteError(error.message, 409);
      if (isSessionDeletionGuardError(error)) return deleteError(error.message, 409);
      return NextResponse.json({ error: `Session deletion failed: ${String(error)}`, deleted: false }, { status: 500 });
    } finally {
      deletionBarrier.release();
    }
    }));
  } catch (error) {
    return NextResponse.json({ error: `Session deletion failed: ${String(error)}`, deleted: false }, { status: 500 });
  }
}

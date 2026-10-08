/**
 * Deduplicates successful completion effects for a prompt run and remembers
 * cancellations until a newer monotonic run id starts.
 */
export function isStaleLocalPromptToken(token: unknown, owner: string | null, active: string | null): boolean {
  return typeof token === "string"
    && owner !== null
    && token.startsWith(`${owner}:`)
    && token !== active;
}

export class PromptCompletionTracker {
  private currentRunId = 0;
  private abortedRunId: number | null = null;
  private notifiedRunId = -1;
  private abortRequestId = 0;
  private pendingAbortRequests = new Map<number, Set<number>>();

  beginRun(runId: number): void {
    if (runId <= this.currentRunId) return;
    this.currentRunId = runId;
    this.abortedRunId = null;
    this.pendingAbortRequests.clear();
  }

  /** A later SDK run without a local prompt can supersede an aborted run. */
  beginAgentRun(runId: number): void {
    if (runId === this.currentRunId && this.abortedRunId === runId) {
      this.abortedRunId = null;
      this.pendingAbortRequests.delete(runId);
    }
  }

  /** Temporarily suppress success while an explicit UI abort is in flight. */
  beginAbortRequest(runId: number): number | null {
    if (runId !== this.currentRunId) return null;
    const requestId = ++this.abortRequestId;
    const requests = this.pendingAbortRequests.get(runId) ?? new Set<number>();
    requests.add(requestId);
    this.pendingAbortRequests.set(runId, requests);
    return requestId;
  }

  /** Confirm or release only this request, and only while its run is current. */
  finishAbortRequest(runId: number, requestId: number, aborted: boolean): boolean {
    if (runId !== this.currentRunId) return false;
    const requests = this.pendingAbortRequests.get(runId);
    if (!requests?.delete(requestId)) return false;
    if (requests.size === 0) this.pendingAbortRequests.delete(runId);
    if (aborted) this.abortedRunId = runId;
    return true;
  }

  markAborted(runId: number): boolean {
    if (runId !== this.currentRunId) return false;
    this.abortedRunId = runId;
    return true;
  }

  isAborted(runId: number): boolean {
    return this.abortedRunId === runId || this.pendingAbortRequests.has(runId);
  }

  /** Returns true exactly once for the current, non-aborted run. */
  notify(runId: number): boolean {
    if (
      runId !== this.currentRunId
      || this.abortedRunId === runId
      || this.pendingAbortRequests.has(runId)
      || this.notifiedRunId === runId
    ) return false;
    this.notifiedRunId = runId;
    return true;
  }
}

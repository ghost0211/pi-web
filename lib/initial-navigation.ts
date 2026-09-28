export interface InitialNavigation {
  requestedCwd: string | null;
  sessionId: string | null;
  entryId: string | null;
}

export function getInitialNavigation(searchParams: Pick<URLSearchParams, "get">): InitialNavigation {
  const requestedCwd = searchParams.get("cwd")?.trim() || null;

  return {
    requestedCwd,
    sessionId: requestedCwd ? null : searchParams.get("session"),
    entryId: requestedCwd ? null : searchParams.get("entry"),
  };
}

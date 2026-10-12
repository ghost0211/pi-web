import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import {
  applySessionManagementAction,
  getSessionManagementState,
  migrateLegacySessionManagement,
  SessionManagementValidationError,
} from "@/lib/session-management-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function errorResponse(error: unknown, invalidBody = false): Response {
  if (invalidBody || error instanceof SessionManagementValidationError) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request" }, {
      status: 400,
      headers: NO_STORE,
    });
  }
  return NextResponse.json({ error: "Session management storage operation failed" }, {
    status: 500,
    headers: NO_STORE,
  });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new SessionManagementValidationError("Request body must be valid JSON");
  }
}

export async function GET(): Promise<Response> {
  try {
    return NextResponse.json({ state: getSessionManagementState() }, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  try {
    const action = await readJson(request);
    const state = await applySessionManagementAction(action);
    const ids = (action as { ids?: unknown }).ids;
    if (Array.isArray(ids)) for (const id of ids) {
      if (typeof id === "string" && state.sessions[id]?.status === "archived") getRpcSession(id)?.pauseAutoAdvance?.("archived");
    }
    return NextResponse.json({ state }, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const state = await migrateLegacySessionManagement(await readJson(request));
    return NextResponse.json({ state }, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}

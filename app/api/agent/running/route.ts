import { NextResponse } from "next/server";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRunningRpcSessionIds,
  getRunningRpcSessionPhases,
} from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
export async function GET() {
  return NextResponse.json(
    {
      runningSessionIds: getRunningRpcSessionIds(),
      runningSessionPhases: getRunningRpcSessionPhases(),
      completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

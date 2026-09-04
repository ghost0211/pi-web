import { NextResponse } from "next/server";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseGeneralSettingsPatch, readGeneralSettings, updateGeneralSettings } from "@/lib/general-settings";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

function getSettingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

export async function GET() {
  try {
    return NextResponse.json(await readGeneralSettings(getSettingsPath()));
  } catch {
    return NextResponse.json({ error: "Failed to read settings." }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let patch;
  try {
    patch = parseGeneralSettingsPatch(body);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid settings" },
      { status: 400 },
    );
  }

  try {
    const settings = await updateGeneralSettings(getSettingsPath(), patch);
    return NextResponse.json({ success: true, settings });
  } catch {
    return NextResponse.json({ error: "Failed to save settings." }, { status: 500 });
  }
}

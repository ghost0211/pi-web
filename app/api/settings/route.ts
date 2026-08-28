import { NextResponse } from "next/server";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

function getSettingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

function readSettings(): Record<string, unknown> {
  const path = getSettingsPath();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeSettings(settings: Record<string, unknown>): void {
  const path = getSettingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2), "utf8");
}

export async function GET() {
  try {
    const settings = readSettings();
    return NextResponse.json({
      theme: (settings.theme as string) || "auto",
      defaultThinkingLevel: (settings.defaultThinkingLevel as string) || "auto",
      compactionEnabled: settings.compactionEnabled !== false,
      retryEnabled: settings.retryEnabled !== false,
      quietStartup: Boolean(settings.quietStartup),
      hideThinkingBlock: Boolean(settings.hideThinkingBlock),
      defaultProjectTrust: (settings.defaultProjectTrust as string) || "prompt",
      enableSkillCommands: settings.enableSkillCommands !== false,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as Record<string, unknown>;
    const current = readSettings();
    const allowedKeys = [
      "defaultThinkingLevel",
      "compactionEnabled",
      "retryEnabled",
      "quietStartup",
      "hideThinkingBlock",
      "defaultProjectTrust",
      "enableSkillCommands",
    ];

    for (const key of allowedKeys) {
      if (body[key] !== undefined) {
        current[key] = body[key];
      }
    }

    writeSettings(current);
    return NextResponse.json({ success: true, settings: current });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

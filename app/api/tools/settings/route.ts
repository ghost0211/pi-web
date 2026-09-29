import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  readShellToolSelection,
  writePowerShellToolEnabled,
  writeShellToolSelection,
  type ShellToolSelection,
} from "@/lib/powershell-settings";
import { detectWindowsShells, type ShellOption } from "@/lib/shell-detect";

export const dynamic = "force-dynamic";

function toResponse(selection: ShellToolSelection, options: ShellOption[]) {
  return {
    isWindows: true,
    powerShellEnabled: selection.tool === "powershell",
    tool: selection.tool,
    shellPath: selection.shellPath,
    options,
  };
}

export async function GET() {
  try {
    if (process.platform !== "win32") {
      return NextResponse.json({
        isWindows: false,
        powerShellEnabled: false,
        tool: "bash",
        shellPath: null,
        options: [],
      });
    }
    const selection = await readShellToolSelection();
    return NextResponse.json(toResponse(selection, detectWindowsShells()));
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
  if (process.platform !== "win32") {
    return NextResponse.json({ error: "Shell tool settings are only available on Windows" }, { status: 404 });
  }

  try {
    const body = await req.json() as {
      enabled?: unknown;
      tool?: unknown;
      shellPath?: unknown;
    };

    let selection: ShellToolSelection;
    if (typeof body.tool === "string") {
      if (body.tool !== "bash" && body.tool !== "powershell") {
        return NextResponse.json({ error: "tool must be \"bash\" or \"powershell\"" }, { status: 400 });
      }
      if (body.shellPath !== undefined && body.shellPath !== null && typeof body.shellPath !== "string") {
        return NextResponse.json({ error: "shellPath must be a string or null" }, { status: 400 });
      }
      selection = {
        tool: body.tool,
        shellPath: typeof body.shellPath === "string" && body.shellPath.trim() ? body.shellPath : null,
      };
      // A custom path only makes sense for the bash tool.
      if (selection.tool === "powershell") selection.shellPath = null;
    } else if (typeof body.enabled === "boolean") {
      // Back-compat with the original boolean toggle.
      return NextResponse.json(
        toResponse(
          { tool: (await writePowerShellToolEnabled(body.enabled)) ? "powershell" : "bash", shellPath: null },
          detectWindowsShells(),
        ),
      );
    } else {
      return NextResponse.json({ error: "tool (or legacy enabled) is required" }, { status: 400 });
    }

    const applied = await writeShellToolSelection(selection);
    return NextResponse.json(toResponse(applied, detectWindowsShells()));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

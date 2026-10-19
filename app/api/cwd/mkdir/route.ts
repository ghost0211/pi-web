import { NextRequest, NextResponse } from "next/server";
import { createDirectoryIn } from "@/lib/directory-browser";
import { hasJsonContentType } from "@/lib/request-security";

const ERROR_MESSAGES: Record<string, string> = {
  empty: "Folder name is required",
  "too-long": "Folder name is too long",
  "path-separator": "Folder name cannot contain path separators",
  relative: "Folder name cannot be . or ..",
  absolute: "Folder name cannot contain a drive or path prefix",
  "trailing-dot": "Folder name cannot end with a dot or space",
  "control-character": "Folder name contains control characters",
  "invalid-character": "Folder name contains characters that are not allowed in a file name",
  "reserved-name": "Folder name is reserved by the operating system",
  "parent-missing": "Parent directory does not exist",
  "already-exists": "A file or folder with that name already exists",
};

// POST /api/cwd/mkdir  body: { parent: string, name: string }
// Creates one folder inside the browsed directory for the folder picker.
export async function POST(request: NextRequest) {
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Expected application/json" }, { status: 415 });
  }

  try {
    const body = await request.json() as { parent?: unknown; name?: unknown };
    const parent = typeof body.parent === "string" ? body.parent.trim() : "";
    const name = typeof body.name === "string" ? body.name : "";

    if (!parent) {
      return NextResponse.json({ error: ERROR_MESSAGES["parent-missing"] }, { status: 400 });
    }

    const result = await createDirectoryIn(parent, name);
    if ("error" in result) {
      // "already-exists" is a conflict the user can resolve by renaming; every
      // other rejection is a malformed request.
      const status = result.error === "already-exists" ? 409 : 400;
      return NextResponse.json(
        { error: ERROR_MESSAGES[result.error] ?? "Cannot create folder", code: result.error },
        { status },
      );
    }

    return NextResponse.json({ path: result.path });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

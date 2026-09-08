import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { join } from "path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { allowFileRoot } from "@/lib/file-access";
import {
  invalidateSessionListCache,
  resolveSessionPath,
} from "@/lib/session-reader";
import { writePrivateFileAtomicSync } from "@/lib/atomic-file";
import { parseSessionJsonl } from "@/lib/session-import";

export const runtime = "nodejs";

const MAX_IMPORT_BYTES = 200 * 1024 * 1024;
const SESSION_ID_SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * POST /api/sessions/import?cwd=<target-cwd>
 * Body: raw .jsonl session file content (pi `/export` JSONL or a copied file).
 *
 * Mirrors pi's `/import`: the file is copied into the session store. Unlike
 * the CLI, the target cwd can be overridden (query param) when the original
 * working directory does not exist on this machine; the header is rewritten
 * in that case. A colliding session id is regenerated so the import never
 * shadows an existing session.
 */
export async function POST(req: Request) {
  try {
    const contentLength = Number(req.headers.get("content-length") ?? 0);
    if (contentLength > MAX_IMPORT_BYTES) {
      return NextResponse.json({ error: "File too large" }, { status: 413 });
    }
    const content = await req.text();
    if (Buffer.byteLength(content, "utf8") > MAX_IMPORT_BYTES) {
      return NextResponse.json({ error: "File too large" }, { status: 413 });
    }

    const { header, lines } = parseSessionJsonl(content);

    const requestedCwd = new URL(req.url).searchParams.get("cwd")?.trim() || undefined;
    const headerCwd = typeof header.cwd === "string" && header.cwd ? header.cwd : undefined;
    const targetCwd = requestedCwd ?? headerCwd;
    if (!targetCwd) {
      return NextResponse.json(
        { error: "The session file has no working directory; provide ?cwd=" },
        { status: 400 },
      );
    }
    if (!existsSync(targetCwd)) {
      return NextResponse.json(
        { error: `Directory does not exist: ${targetCwd}` },
        { status: 400 },
      );
    }

    // Resolve the on-disk store the same way pi does — SessionManager.create()
    // encodes the cwd and ensures the directory exists without writing a file.
    const sessionDir = SessionManager.create(targetCwd, undefined).getSessionDir();

    // Never shadow an existing session: regenerate the id on collision (and
    // whenever the id is unsafe for a filename suffix).
    const existing = await resolveSessionPath(header.id).catch(() => null);
    const id = existing || !SESSION_ID_SAFE.test(header.id) ? randomUUID() : header.id;

    const nextHeader = { ...header, id, cwd: targetCwd };
    if (!nextHeader.timestamp || Number.isNaN(Date.parse(nextHeader.timestamp))) {
      nextHeader.timestamp = new Date().toISOString();
    }
    lines[0] = JSON.stringify(nextHeader);

    const fileTimestamp = (nextHeader.timestamp as string).replace(/[:.]/g, "-");
    const filePath = join(sessionDir, `${fileTimestamp}_${id}.jsonl`);
    writePrivateFileAtomicSync(filePath, lines.join("\n") + "\n");

    allowFileRoot(targetCwd);
    invalidateSessionListCache();
    return NextResponse.json({ success: true, sessionId: id, cwd: targetCwd });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

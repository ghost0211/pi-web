// Cache session-list metadata without building the SDK's unused allMessagesText.
// Unchanged files only require a stat call against the cached fingerprint.
// Files that only grew since their last scan are resumed from where that scan stopped.
//
// Remaining limitation / security note:
// The resume check compares the file identity (inode on supported filesystems),
// the header line, and the RESUME_SAMPLE_BYTES before the resume offset.
// An in-place rewrite of the exact same length in the middle of an old prefix
// (between the header and the tail sample) followed by an append cannot be
// detected by boundary sampling alone and would be treated as an append.
// We do not claim absolute detection for arbitrary in-place edits. For explicit
// metadata rewrites, deletes, or forced invalidations in pi-web, use
// invalidateSessionScanEntry() to trigger a full cold rescan.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

export interface ScannedSessionInfo {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	parentSessionPath?: string;
}

interface Fingerprint {
	size: number;
	mtimeMs: number;
}

/**
 * Where the next scan of a file that only grew picks up. `offset` is just past
 * the last newline-terminated line parsed; the row's own name, count and first
 * message are the running totals (a scan that counted an unterminated last line
 * keeps no resume point). `check` hashes the header line, [0, headerEnd), with
 * the RESUME_SAMPLE_BYTES before `offset`: a rewrite in place fails it. `ino`
 * catches a file replaced by a rename (sed -i, editors, git checkout, a backup
 * restored), whatever its bytes.
 */
interface ResumePoint {
	ino: number;
	offset: number;
	headerEnd: number;
	check: string;
	/** False while no user message had text: the row shows "(no messages)". */
	hasFirstMessage: boolean;
	lastActivityTime?: number;
}

interface IndexEntry {
	fp: Fingerprint;
	info: ScannedSessionInfo;
	resume?: ResumePoint;
}

type RawEntry = Record<string, unknown>;

function isRecord(value: unknown): value is RawEntry {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Bump on any change to what foldEntry() counts: a resumed scan adds to totals
// counted under the rules its prefix was scanned with.
const INDEX_FORMAT_VERSION = 1;
const RESUME_SAMPLE_BYTES = 512;
const NEWLINE = Buffer.from("\n");
const MAX_CONCURRENT_SCANS = 10;

declare global {
	var __piWebScanIndex: Map<string, IndexEntry> | undefined;
	var __piWebScanIndexLoaded: boolean | undefined;
	var __piWebScanIndexSave: PendingIndexSave | undefined;
}

/** A queued index write: where it goes and what, both fixed by the last scan that changed it. */
interface PendingIndexSave {
	path: string;
	entries: Array<[string, IndexEntry]>;
}

function parseLine(line: string): RawEntry | null {
	if (!line.trim()) return null;
	try {
		const entry = JSON.parse(line) as RawEntry;
		return entry && typeof entry === "object" ? entry : null;
	} catch {
		return null;
	}
}

function hasMatchingFingerprint(
	cached: IndexEntry | undefined,
	fingerprint: Fingerprint,
): cached is IndexEntry {
	return Boolean(
		cached &&
		cached.fp.size === fingerprint.size &&
		cached.fp.mtimeMs === fingerprint.mtimeMs,
	);
}

/** Only a file strictly larger than at its last scan may resume where that scan stopped. */
function hasGrown(
	cached: IndexEntry | undefined,
	fingerprint: Fingerprint,
): cached is IndexEntry & { resume: ResumePoint } {
	return Boolean(
		cached?.resume &&
		fingerprint.size > cached.fp.size &&
		fingerprint.size >= cached.resume.offset,
	);
}

function extractTextContent(message: RawEntry): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: string; text: string } =>
				!!block &&
				typeof block === "object" &&
				(block as RawEntry).type === "text" &&
				typeof (block as RawEntry).text === "string",
		)
		.map((block) => block.text)
		.join(" ");
}

function activityTimeOf(entry: RawEntry): number | undefined {
	const message = entry.message as RawEntry | undefined;
	if (
		!message ||
		typeof message.role !== "string" ||
		!("content" in message) ||
		(message.role !== "user" && message.role !== "assistant")
	) {
		return undefined;
	}
	if (typeof message.timestamp === "number") return message.timestamp;
	const t = new Date(entry.timestamp as string).getTime();
	return Number.isNaN(t) ? undefined : t;
}

interface SessionHeader {
	id: string;
	cwd: string;
	created: Date;
	parentSessionPath?: string;
	/** NaN unless the header's timestamp is a string. */
	time: number;
	/** The header line and its newline, kept when a later scan may resume. */
	head?: Buffer;
}

interface ScanTotals {
	name?: string;
	messageCount: number;
	firstMessage: string;
	lastActivityTime?: number;
}

function readHeader(entry: RawEntry, head: Buffer | undefined): SessionHeader {
	return {
		id: entry.id as string,
		cwd: typeof entry.cwd === "string" ? entry.cwd : "",
		created: new Date(entry.timestamp as string),
		parentSessionPath: typeof entry.parentSession === "string" ? entry.parentSession : undefined,
		time: typeof entry.timestamp === "string" ? new Date(entry.timestamp).getTime() : NaN,
		// A resumed scan rebuilds the header from the row, which holds it
		// faithfully only for a string id and timestamp.
		head: typeof entry.id === "string" && typeof entry.timestamp === "string" ? head : undefined,
	};
}

// Uses the SDK's buildSessionInfo() semantics for displayed metadata. A change
// to these rules must bump INDEX_FORMAT_VERSION (resumed totals keep the old ones).
function foldEntry(totals: ScanTotals, entry: RawEntry): void {
	if (entry.type === "session_info") {
		totals.name =
			typeof entry.name === "string" && entry.name.trim()
				? entry.name.trim()
				: undefined;
	}
	if (entry.type !== "message") return;
	totals.messageCount++;

	const activityTime = activityTimeOf(entry);
	if (typeof activityTime === "number") {
		totals.lastActivityTime = Math.max(totals.lastActivityTime ?? 0, activityTime);
	}

	if (totals.firstMessage) return;
	const message = entry.message as RawEntry | undefined;
	if (
		!message ||
		typeof message.role !== "string" ||
		!("content" in message)
	)
		return;
	if (message.role !== "user") return;
	totals.firstMessage = extractTextContent(message);
}

function sampleCheck(head: Buffer, tail: Buffer): string {
	return createHash("sha1").update(head).update(tail).digest("base64");
}

/** Drop leading parts not needed for the last RESUME_SAMPLE_BYTES of `parts`. */
function keepLastBytes(parts: Buffer[]): Buffer[] {
	let total = 0;
	for (const part of parts) total += part.length;
	let first = 0;
	while (first < parts.length - 1 && total - parts[first].length >= RESUME_SAMPLE_BYTES) {
		total -= parts[first].length;
		first++;
	}
	return first > 0 ? parts.slice(first) : parts;
}

/**
 * One newline-free run of bytes split into lines as the scan's readline read
 * did on Node 22: \r\n and a lone \r end a line. U+2028 and U+2029, which
 * JSON.stringify leaves raw and Node 24's readline splits on, stay inside the
 * line, as pi's own loader keeps them.
 */
function linesOf(bytes: Buffer): string[] {
	const text = bytes.toString("utf8");
	return text.includes("\r") ? text.split("\r") : [text];
}

interface LineScan {
	/** Just past the last newline read. */
	offset: number;
	/** The RESUME_SAMPLE_BYTES before `offset` (fewer near the start). */
	sample: Buffer;
	/** The bytes after the last newline: a line its writer may still be appending. */
	rest: Buffer;
}

/**
 * Hand each newline-terminated line from `start` on to `onLine`, with the
 * offset just past its newline. Returns null when `onLine` returns false.
 */
async function readLines(
	filePath: string,
	start: number,
	sample: Buffer,
	onLine: (bytes: Buffer, end: number) => boolean,
): Promise<LineScan | null> {
	let offset = start;
	let pending: Buffer[] = [];
	// The bytes read up to `offset`, as views, trimmed to what the sample needs
	// once per chunk (not per line: a full scan of short lines stays as fast).
	let read = [sample];
	for await (const chunk of createReadStream(filePath, { start }) as AsyncIterable<Buffer>) {
		let newline = chunk.indexOf(0x0a);
		if (newline === -1) {
			pending.push(chunk);
			continue;
		}
		const carried = pending;
		let lineStart = 0;
		while (newline !== -1) {
			const piece = chunk.subarray(lineStart, newline);
			const bytes = pending.length > 0 ? Buffer.concat([...pending, piece]) : piece;
			pending = [];
			offset += bytes.length + 1;
			if (!onLine(bytes, offset)) return null;
			lineStart = newline + 1;
			newline = chunk.indexOf(0x0a, lineStart);
		}
		read = keepLastBytes([...read, ...carried, chunk.subarray(0, lineStart)]);
		if (lineStart < chunk.length) pending.push(chunk.subarray(lineStart));
	}
	const joined = Buffer.concat(read);
	return {
		offset,
		sample: joined.subarray(Math.max(0, joined.length - RESUME_SAMPLE_BYTES)),
		rest: Buffer.concat(pending),
	};
}

/**
 * The header line and the bytes before the resume offset, when they still hash
 * to the resume point's check; null sends the caller to a full scan.
 */
async function readResumeSample(
	filePath: string,
	resume: ResumePoint,
): Promise<{ head: Buffer; tail: Buffer } | null> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(filePath, "r");
		const tailStart = Math.max(0, resume.offset - RESUME_SAMPLE_BYTES);
		const head = Buffer.alloc(resume.headerEnd);
		const tail = Buffer.alloc(resume.offset - tailStart);
		const headRead = await handle.read(head, 0, head.length, 0);
		const tailRead = await handle.read(tail, 0, tail.length, tailStart);
		if (headRead.bytesRead !== head.length || tailRead.bytesRead !== tail.length) return null;
		return sampleCheck(head, tail) === resume.check ? { head, tail } : null;
	} catch {
		return null;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

/**
 * Scan a session file for its row, from where `previous` stopped when the
 * file only grew since and its sampled prefix is unchanged, else from byte 0.
 * Either way the row is the one a full read of the file gives.
 */
async function scanSessionFile(
	filePath: string,
	previous?: IndexEntry,
): Promise<Omit<IndexEntry, "fp"> | null> {
	try {
		const stats = await stat(filePath);
		const hasValidIno = typeof stats.ino === "number" && Number.isFinite(stats.ino) && stats.ino > 0;
		const resumed = previous?.resume && hasValidIno && previous.resume.ino === stats.ino
			? await readResumeSample(filePath, previous.resume)
			: null;

		let header: SessionHeader | null = null;
		let headerEnd = 0;
		let start = 0;
		let sample: Buffer = Buffer.alloc(0);
		const totals: ScanTotals = { messageCount: 0, firstMessage: "" };
		if (previous?.resume && resumed) {
			const { info, resume } = previous;
			start = resume.offset;
			sample = resumed.tail;
			header = {
				id: info.id,
				cwd: info.cwd,
				created: new Date(info.created.getTime()),
				parentSessionPath: info.parentSessionPath,
				time: info.created.getTime(),
				head: resumed.head,
			};
			headerEnd = resume.headerEnd;
			totals.name = info.name;
			totals.messageCount = info.messageCount;
			totals.firstMessage = resume.hasFirstMessage ? info.firstMessage : "";
			totals.lastActivityTime = resume.lastActivityTime;
		}

		let restCounted = false;
		const parseLines = (bytes: Buffer, end: number | null): boolean => {
			for (const line of linesOf(bytes)) {
				const entry = parseLine(line);
				if (!entry) continue;
				if (end === null) restCounted = true;
				if (!header) {
					if (entry.type !== "session") return false;
					// Only a header on the file's first line is sampled for resuming.
					const firstLine = end !== null && end === bytes.length + 1;
					header = readHeader(entry, firstLine ? Buffer.concat([bytes, NEWLINE]) : undefined);
					headerEnd = firstLine ? end : 0;
					continue;
				}
				foldEntry(totals, entry);
			}
			return true;
		};

		const scan = await readLines(filePath, start, sample, parseLines);
		// The unterminated rest counts for this listing, as it did when the scan
		// read lines with readline; a resume point is kept only when it changed nothing.
		if (!scan || (scan.rest.length > 0 && !parseLines(scan.rest, null))) return null;
		if (!header) return null;
		const { id, cwd, created, parentSessionPath, time, head } = header;

		const modified =
			typeof totals.lastActivityTime === "number" && totals.lastActivityTime > 0
				? new Date(totals.lastActivityTime)
				: !Number.isNaN(time)
					? new Date(time)
					: stats.mtime;

		return {
			info: {
				path: filePath,
				id,
				cwd,
				name: totals.name,
				parentSessionPath,
				created,
				modified,
				messageCount: totals.messageCount,
				firstMessage: totals.firstMessage || "(no messages)",
			},
			// An inode of 0 (no stable one on this filesystem) never resumes.
			resume: head && headerEnd > 0 && !restCounted && hasValidIno
				? {
					ino: stats.ino,
					offset: scan.offset,
					headerEnd,
					check: sampleCheck(head, scan.sample),
					hasFirstMessage: totals.firstMessage !== "",
					...(totals.lastActivityTime !== undefined ? { lastActivityTime: totals.lastActivityTime } : {}),
				}
				: undefined,
		};
	} catch {
		return null;
	}
}

// Uses the SDK's buildSessionInfo() semantics for displayed metadata.
export async function scanSessionFileInfo(
	filePath: string,
): Promise<ScannedSessionInfo | null> {
	return (await scanSessionFile(filePath))?.info ?? null;
}

async function enumerateSessionFiles(sessionsDir: string): Promise<string[]> {
	let dirs: Dirent[];
	try {
		const entries = await readdir(sessionsDir, { withFileTypes: true });
		dirs = entries.filter(
			(entry) => entry.isDirectory() || entry.isSymbolicLink(),
		);
	} catch {
		return [];
	}

	const files: string[] = [];
	for (const dir of dirs) {
		const dirPath = join(sessionsDir, dir.name);
		try {
			for (const f of await readdir(dirPath)) {
				if (f.endsWith(".jsonl")) files.push(join(dirPath, f));
			}
		} catch {
			// unreadable project dir: same skip-as-absent semantics as the SDK
		}
	}
	return files;
}

async function runPool<T>(items: T[], worker: (item: T) => Promise<void>) {
	let next = 0;
	const inFlight = new Set<Promise<void>>();
	while (next < items.length || inFlight.size > 0) {
		while (next < items.length && inFlight.size < MAX_CONCURRENT_SCANS) {
			const item = items[next++];
			const task = worker(item).finally(() => inFlight.delete(task));
			inFlight.add(task);
		}
		if (inFlight.size > 0) await Promise.race(inFlight);
	}
}

function getIndex(): Map<string, IndexEntry> {
	if (!globalThis.__piWebScanIndex) globalThis.__piWebScanIndex = new Map();
	return globalThis.__piWebScanIndex;
}

function indexFilePath(agentDir = getAgentDir()): string {
	return join(agentDir, "pi-web-session-index.json");
}

/** A persisted resume point, or undefined when it is missing or malformed (the entry stays). */
function readResumePoint(value: unknown): ResumePoint | undefined {
	if (!isRecord(value)) return undefined;
	const { ino, offset, headerEnd, check, hasFirstMessage, lastActivityTime } = value;
	if (
		typeof ino !== "number" || !Number.isFinite(ino) || ino <= 0 ||
		typeof headerEnd !== "number" || !Number.isSafeInteger(headerEnd) || headerEnd <= 0 ||
		typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < headerEnd ||
		typeof check !== "string" ||
		typeof hasFirstMessage !== "boolean" ||
		(lastActivityTime !== undefined && (typeof lastActivityTime !== "number" || !Number.isFinite(lastActivityTime)))
	) return undefined;
	return {
		ino,
		offset,
		headerEnd,
		check,
		hasFirstMessage,
		...(lastActivityTime !== undefined ? { lastActivityTime } : {}),
	};
}

function loadPersistedIndex(): void {
	if (globalThis.__piWebScanIndexLoaded) return;
	globalThis.__piWebScanIndexLoaded = true;
	const path = indexFilePath();
	if (!existsSync(path)) return;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(parsed) || parsed.version !== INDEX_FORMAT_VERSION || !isRecord(parsed.entries)) return;
		const index = getIndex();
		for (const [pathKey, entry] of Object.entries(parsed.entries)) {
			if (!isRecord(entry) || !isRecord(entry.fp) || !isRecord(entry.info)) continue;
			const { fp, info } = entry;
			if (
				typeof fp.size !== "number" || !Number.isSafeInteger(fp.size) || fp.size < 0 ||
				typeof fp.mtimeMs !== "number" || !Number.isFinite(fp.mtimeMs) ||
				info.path !== pathKey ||
				typeof info.id !== "string" ||
				typeof info.cwd !== "string" ||
				typeof info.firstMessage !== "string" ||
				(info.name !== undefined && typeof info.name !== "string") ||
				(info.parentSessionPath !== undefined && typeof info.parentSessionPath !== "string") ||
				typeof info.messageCount !== "number" || !Number.isSafeInteger(info.messageCount) || info.messageCount < 0 ||
				typeof info.created !== "string" || typeof info.modified !== "string"
			) continue;
			const created = new Date(info.created);
			const modified = new Date(info.modified);
			if (!Number.isFinite(created.getTime()) || !Number.isFinite(modified.getTime())) continue;
			index.set(pathKey, {
				fp: { size: fp.size, mtimeMs: fp.mtimeMs },
				info: {
					path: pathKey,
					id: info.id,
					cwd: info.cwd,
					name: info.name,
					parentSessionPath: info.parentSessionPath,
					firstMessage: info.firstMessage,
					messageCount: info.messageCount,
					created,
					modified,
				},
				// Entries from before resume points get one full scan when they change.
				resume: readResumePoint(entry.resume),
			});
		}
	} catch {
		// corrupt index => cold rebuild, never an error surfaced to callers
	}
}

function persistIndex(): void {
	const pending = globalThis.__piWebScanIndexSave;
	if (!pending) return;
	globalThis.__piWebScanIndexSave = undefined;
	try {
		writePrivateFileAtomicSync(
			pending.path,
			JSON.stringify({ version: INDEX_FORMAT_VERSION, entries: Object.fromEntries(pending.entries) }),
		);
	} catch {
		// persistence is best-effort; the in-memory index remains authoritative
	}
}

/**
 * Queue index persistence asynchronously in a microtask.
 * Consecutive scans within the same tick coalesce writes.
 */
function queueIndexPersist(path: string = indexFilePath()): void {
	const entries = [...getIndex()];
	const pending = globalThis.__piWebScanIndexSave;
	if (pending?.path === path) {
		pending.entries = entries;
		return;
	}
	if (pending) persistIndex();
	globalThis.__piWebScanIndexSave = { path, entries };
	queueMicrotask(persistIndex);
}

/**
 * Incremental equivalent of SessionManager.listAll(): rescans only files whose
 * (size, mtimeMs) changed since the last pass. Output ordering matches the SDK
 * catalogue (modified descending, tie-broken stably).
 */
export async function listSessionsIncremental(): Promise<ScannedSessionInfo[]> {
	loadPersistedIndex();

	const agentDir = getAgentDir();
	const sessionsDir = join(agentDir, "sessions");
	const files = await enumerateSessionFiles(sessionsDir);

	const index = getIndex();
	const present = new Set(files);
	const stale: string[] = [];
	for (const known of index.keys()) {
		if (!present.has(known)) stale.push(known);
	}
	for (const pathKey of stale) index.delete(pathKey);

	const fingerprints = await Promise.all(
		files.map(async (filePath) => {
			try {
				const s = await stat(filePath);
				return {
					filePath,
					fp: { size: s.size, mtimeMs: s.mtimeMs } as Fingerprint,
				};
			} catch {
				return { filePath, fp: null as Fingerprint | null };
			}
		}),
	);

	const changed: Array<{ filePath: string; fp: Fingerprint; resultIndex: number; previous?: IndexEntry }> = [];
	const results: (ScannedSessionInfo | null)[] = new Array(files.length).fill(null);
	const mtimes: number[] = new Array(files.length).fill(Number.NEGATIVE_INFINITY);
	for (const [resultIndex, { filePath, fp }] of fingerprints.entries()) {
		if (!fp) {
			index.delete(filePath);
			continue;
		}
		mtimes[resultIndex] = fp.mtimeMs;
		const cached = index.get(filePath);
		if (hasMatchingFingerprint(cached, fp)) {
			results[resultIndex] = cached.info;
			continue;
		}
		// A running session's file grows on every append: parse only the tail.
		changed.push({ filePath, fp, resultIndex, previous: hasGrown(cached, fp) ? cached : undefined });
	}

	await runPool(changed, async ({ filePath, fp, resultIndex, previous }) => {
		const scanned = await scanSessionFile(filePath, previous);
		if (scanned) {
			index.set(filePath, { fp, ...scanned });
			results[resultIndex] = scanned.info;
		} else {
			index.delete(filePath);
		}
	});

	if (changed.length > 0 || stale.length > 0) queueIndexPersist(indexFilePath(agentDir));

	// Preserve catalogue order for timestamp ties, independently of cache hits
	// and the order in which concurrent file reads complete.
	return results
		.flatMap((info, resultIndex) => (info ? [{ info, mtimeMs: mtimes[resultIndex] }] : []))
		.sort((a, b) =>
			b.info.modified.getTime() - a.info.modified.getTime()
			|| b.mtimeMs - a.mtimeMs
			|| basename(b.info.path).localeCompare(basename(a.info.path)),
		)
		.map(({ info }) => info);
}

/**
 * Invalidate scan index entries, forcing a full cold rescan on next pass.
 * - Call with a specific `filePath` when that session file was deleted, truncated,
 *   or had its internal metadata rewritten in-place (e.g. session-info rewrite, fork, delete).
 * - Call without arguments to clear all cached scan entries in memory.
 */
export function invalidateSessionScanEntry(filePath?: string): void {
	const index = getIndex();
	if (filePath) {
		index.delete(filePath);
	} else {
		index.clear();
	}
	queueIndexPersist(indexFilePath());
}

/** Test seam: write a pending index save now instead of after its delay. */
export function flushSessionScanIndexForTests(): void {
	persistIndex();
}

/** Test seam: drop all in-memory index state and any pending index save. */
export function resetSessionScanIndexForTests(): void {
	globalThis.__piWebScanIndex = undefined;
	globalThis.__piWebScanIndexLoaded = undefined;
	globalThis.__piWebScanIndexSave = undefined;
}

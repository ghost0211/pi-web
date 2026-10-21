import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./git-status.ts");
}

test("parses null-delimited Git status entries including renames", async () => {
  const { parseGitPorcelainV1 } = await loadSubject();
  const entries = parseGitPorcelainV1([
    " M components/App.tsx",
    "?? notes.txt",
    "R  src/new-name.ts",
    "src/old-name.ts",
    "",
  ].join("\0"));

  assert.deepEqual(entries, [
    {
      path: "components/App.tsx",
      indexStatus: " ",
      worktreeStatus: "M",
    },
    {
      path: "notes.txt",
      indexStatus: "?",
      worktreeStatus: "?",
    },
    {
      path: "src/new-name.ts",
      originalPath: "src/old-name.ts",
      indexStatus: "R",
      worktreeStatus: " ",
    },
  ]);
});

test("classifies Git status for explorer badges", async () => {
  const { classifyGitStatus } = await loadSubject();
  const classify = (pair) => classifyGitStatus({
    path: "file.ts",
    indexStatus: pair[0],
    worktreeStatus: pair[1],
  });

  assert.deepEqual(classify(" M"), { status: "modified", code: "M" });
  assert.deepEqual(classify("??"), { status: "untracked", code: "U" });
  assert.deepEqual(classify("A "), { status: "added", code: "A" });
  assert.deepEqual(classify("R "), { status: "renamed", code: "R" });
  assert.deepEqual(classify("UU"), { status: "conflict", code: "C" });
  assert.deepEqual(classify(" D"), { status: "deleted", code: "D" });
});

test("a file without a diff reports why instead of an empty diff", { skip: process.platform !== "win32" && process.platform !== "linux" }, async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createJiti } = await import("jiti");
  // git-changes.ts uses extensionless relative imports; jiti resolves them the
  // way the app build does.
  const { getGitFileDiff } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./git-changes.ts");

  const root = mkdtempSync(join(tmpdir(), "pi-web-diff-reason-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, ".gitignore"), "ignored.log\n");
  writeFileSync(join(root, "tracked.txt"), "one\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: root });
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "ignored.log"), "noise\n");
  writeFileSync(join(root, "sub", "new.ts"), "export const a = 1;\n");

  // Unchanged tracked file: nothing to compare.
  assert.deepEqual(await getGitFileDiff(root, join(root, "tracked.txt")), { supported: false, reason: "unchanged" });
  // Ignored file: git reports nothing at all.
  assert.deepEqual(await getGitFileDiff(root, join(root, "ignored.log")), { supported: false, reason: "ignored" });
  // A new file inside the repo is a real (all-added) diff.
  const added = await getGitFileDiff(root, join(root, "sub", "new.ts"));
  assert.equal(added.supported, true);
  assert.equal(added.status, "untracked");
  assert.match(added.patch, /^\+export const a = 1;$/m);
  // Outside the repository / no repository at all.
  const outside = mkdtempSync(join(tmpdir(), "pi-web-diff-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const outsideFile = join(outside, "x.txt");
  writeFileSync(outsideFile, "x\n");
  assert.deepEqual(await getGitFileDiff(root, outsideFile), { supported: false, reason: "outside-repository" });
  assert.deepEqual(await getGitFileDiff(outside, outsideFile), { supported: false, reason: "not-a-repository" });
  // Modified tracked file still diffs.
  writeFileSync(join(root, "tracked.txt"), "one\ntwo\n");
  const modified = await getGitFileDiff(root, join(root, "tracked.txt"));
  assert.equal(modified.supported, true);
  assert.equal(modified.status, "modified");
  assert.match(modified.patch, /^\+two$/m);
});

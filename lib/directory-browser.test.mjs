import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./directory-browser.ts");
}

test("lists directories and directory symlinks without returning files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-web-browse-"));
  try {
    await mkdir(path.join(root, "project"));
    await writeFile(path.join(root, "notes.txt"), "test", "utf8");
    await symlink(path.join(root, "project"), path.join(root, "linked-project"), process.platform === "win32" ? "junction" : "dir");

    const { listDirectories } = await loadSubject();
    const directories = await listDirectories(root);

    assert.deepEqual(directories.map((entry) => entry.name), ["linked-project", "project"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expands home-relative paths and rejects missing directories", async () => {
  const {
    getBrowseStartDirectory,
    normalizeDirectory,
    resolveDirectory,
    shouldShowWindowsDrivePicker,
  } = await loadSubject();
  assert.equal(getBrowseStartDirectory(), homedir());
  assert.equal(getBrowseStartDirectory("/project"), "/project");
  assert.equal(shouldShowWindowsDrivePicker(undefined, "win32"), true);
  assert.equal(shouldShowWindowsDrivePicker(undefined, "darwin"), false);
  assert.equal(shouldShowWindowsDrivePicker(undefined, "linux"), false);
  assert.equal(shouldShowWindowsDrivePicker("C:\\Projects", "win32"), false);
  assert.equal(normalizeDirectory("~/project"), path.join(homedir(), "project"));
  await assert.rejects(resolveDirectory(path.join(tmpdir(), `pi-web-missing-${Date.now()}`)));
});

test("builds every Windows drive-letter candidate", async () => {
  const { getWindowsDriveCandidates } = await loadSubject();
  const drives = getWindowsDriveCandidates();

  assert.equal(drives.length, 26);
  assert.deepEqual(drives[0], { name: "A:", path: "A:\\" });
  assert.deepEqual(drives.at(-1), { name: "Z:", path: "Z:\\" });
});

test("finds parent directories across POSIX and Windows paths", async () => {
  const { getParentDirectory } = await loadSubject();

  assert.equal(getParentDirectory("/Users/alex/project"), "/Users/alex");
  assert.equal(getParentDirectory("/"), null);
  assert.equal(getParentDirectory("C:\\Users\\Alex\\project"), "C:\\Users\\Alex");
  assert.equal(getParentDirectory("C:\\"), null);
});

test("rejects folder names that could escape or alias the parent directory", async () => {
  const { validateNewDirectoryName } = await loadSubject();
  for (const name of ["", "   ", ".", "..", "a/b", "a\\b", "../evil", "C:", "C:\\Windows", "nested/child"]) {
    assert.notEqual(validateNewDirectoryName(name), null, `${JSON.stringify(name)} must be rejected`);
  }
  assert.equal(validateNewDirectoryName("a/b"), "path-separator");
  assert.equal(validateNewDirectoryName(".."), "relative");
  assert.equal(validateNewDirectoryName("C:\\Windows"), "path-separator");
  assert.equal(validateNewDirectoryName(""), "empty");
});

test("rejects names the target filesystem cannot represent", async () => {
  const { validateNewDirectoryName } = await loadSubject();
  assert.equal(validateNewDirectoryName("a?b"), "invalid-character");
  assert.equal(validateNewDirectoryName('a"b'), "invalid-character");
  assert.equal(validateNewDirectoryName("a\u0000b"), "control-character");
  assert.equal(validateNewDirectoryName("x".repeat(121)), "too-long");
  for (const reserved of ["CON", "nul", "com1", "LPT9", "aux.txt"]) {
    assert.equal(validateNewDirectoryName(reserved), "reserved-name", reserved);
  }
  // Reserved device names are stem-based, so a normal name that merely starts
  // with one is still allowed.
  assert.equal(validateNewDirectoryName("console"), null);
  // Trailing dot/space is only fatal where Windows enforces it.
  assert.equal(validateNewDirectoryName("trailing.", "win32"), "trailing-dot");
  assert.equal(validateNewDirectoryName("trailing.", "linux"), null);
});

test("accepts ordinary folder names including CJK and dotted versions", async () => {
  const { validateNewDirectoryName } = await loadSubject();
  for (const name of ["project", "my-project_2", "v1.0.0", "浦东数据稽核", "a b", "工具.新版"]) {
    assert.equal(validateNewDirectoryName(name), null, name);
  }
});

test("creates exactly one folder inside the parent and never a missing ancestor", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-web-mkdir-"));
  try {
    const { createDirectoryIn } = await loadSubject();
    const created = await createDirectoryIn(root, "new-folder");
    assert.ok("path" in created);
    assert.equal(path.basename(created.path), "new-folder");
    assert.equal((await stat(created.path)).isDirectory(), true);

    // Existing targets are a conflict, not an overwrite.
    assert.deepEqual(await createDirectoryIn(root, "new-folder"), { error: "already-exists" });
    // A missing parent is never built implicitly.
    assert.deepEqual(
      await createDirectoryIn(path.join(root, "missing", "deeper"), "child"),
      { error: "parent-missing" },
    );
    // Traversal and separators never reach the filesystem.
    assert.deepEqual(await createDirectoryIn(root, "../escaped"), { error: "path-separator" });
    assert.deepEqual(await createDirectoryIn(root, "nested/child"), { error: "path-separator" });
    assert.equal(existsSync(path.join(root, "..", "escaped")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("creation rejects a parent that is a file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-web-mkdir-file-"));
  try {
    const filePath = path.join(root, "notes.txt");
    await writeFile(filePath, "x", "utf8");
    const { createDirectoryIn } = await loadSubject();
    assert.deepEqual(await createDirectoryIn(filePath, "child"), { error: "parent-missing" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

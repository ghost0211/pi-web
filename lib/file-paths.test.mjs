import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  getFileName,
  getRelativeFilePath,
  joinFilePath,
  normalizeFilePathSlashes,
  toAbsoluteFilePath,
} = await jiti.import("./file-paths.ts");

test("normalizes Windows separators for API encoding", () => {
  assert.equal(normalizeFilePathSlashes("C:\\proj\\a.ts"), "C:/proj/a.ts");
  assert.equal(normalizeFilePathSlashes("/home/user/a.ts"), "/home/user/a.ts");
});

test("splits names, directories, and cwd-relative paths", () => {
  assert.equal(getFileName("C:/proj/src/a.ts"), "a.ts");
  assert.equal(getFileName("C:/proj/src/"), "src");
  assert.equal(getRelativeFilePath("C:/proj/src/a.ts", "C:/proj"), "src/a.ts");
  assert.equal(joinFilePath("C:/proj", "src/a.ts"), "C:/proj/src/a.ts");
});

test("resolves viewer paths into absolute paths for the desktop shell", () => {
  // Already-absolute inputs pass through unchanged.
  assert.equal(toAbsoluteFilePath("C:\\proj\\src\\a.ts", "C:/proj"), "C:/proj/src/a.ts");
  assert.equal(toAbsoluteFilePath("C:/proj/src/a.ts", null), "C:/proj/src/a.ts");
  assert.equal(toAbsoluteFilePath("/home/me/a.ts", null), "/home/me/a.ts");
  assert.equal(toAbsoluteFilePath("//server/share/a.ts", null), "//server/share/a.ts");

  // Workspace-relative inputs are joined onto the session cwd.
  assert.equal(toAbsoluteFilePath("src/a.ts", "C:/proj"), "C:/proj/src/a.ts");
  assert.equal(toAbsoluteFilePath("./src/a.ts", "C:/proj"), "C:/proj/./src/a.ts");
  assert.equal(toAbsoluteFilePath("src\\a.ts", "C:\\proj\\"), "C:/proj/src/a.ts");

  // Without a cwd a relative path cannot be opened locally, so the desktop
  // actions must stay hidden instead of opening something wrong.
  assert.equal(toAbsoluteFilePath("src/a.ts", undefined), null);
  assert.equal(toAbsoluteFilePath("src/a.ts", null), null);
  assert.equal(toAbsoluteFilePath("", "C:/proj"), null);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  encodeFilePathForApi,
  getFileDirectory,
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

test("encodeFilePathForApi keeps a UNC root inside the first segment", () => {
  // The catch-all route cannot carry a literal "//" prefix — URL routing
  // normalizes it away — so the root is folded into segment one as %2F%2Fhost.
  assert.equal(
    encodeFilePathForApi("\\\\192.0.2.1\\share\\dir"),
    "%2F%2F192.0.2.1/share/dir",
  );
  assert.equal(
    encodeFilePathForApi("//192.0.2.1/share/dir"),
    "%2F%2F192.0.2.1/share/dir",
  );
  assert.equal(
    encodeFilePathForApi("\\\\192.0.2.1\\share"),
    "%2F%2F192.0.2.1/share",
  );
});

test("encodeFilePathForApi encodes drive and POSIX paths per segment", () => {
  assert.equal(encodeFilePathForApi("D:\\repo\\a file.ts"), "D%3A/repo/a%20file.ts");
  assert.equal(encodeFilePathForApi("/tmp/a file.ts"), "tmp/a%20file.ts");
  assert.equal(encodeFilePathForApi("/tmp/dir/"), "tmp/dir");
});

test("getFileName and getFileDirectory handle UNC paths", () => {
  assert.equal(getFileName("\\\\host\\share\\dir\\file.ts"), "file.ts");
  assert.equal(getFileDirectory("\\\\host\\share\\dir\\file.ts"), "//host/share/dir");
  assert.equal(getFileDirectory("//host/share/dir"), "//host/share");
});

test("joinFilePath preserves the UNC root", () => {
  assert.equal(joinFilePath("\\\\host\\share\\dir", "child"), "//host/share/dir/child");
});

test("getRelativeFilePath strips a UNC cwd prefix", () => {
  assert.equal(
    getRelativeFilePath("\\\\host\\share\\dir\\sub\\file.ts", "\\\\host\\share\\dir"),
    "sub/file.ts",
  );
});

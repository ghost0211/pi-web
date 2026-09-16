// The file viewer header must not offer a download inside Pi Web Desktop: the
// project already lives on this machine, so the header opens it with the system
// application instead. The browser build keeps the download link because the
// server may be another host.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (await readFile(new URL("./FileActions.tsx", import.meta.url), "utf8"))
  .replace(/\r\n/g, "\n");
const viewer = (await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8"))
  .replace(/\r\n/g, "\n");

test("desktop hides the download link and opens with the system default app", () => {
  assert.match(source, /const desktop = useIsDesktopApp\(\)/);
  assert.match(source, /if \(!available \|\| !absolutePath\) \{[\s\S]*?href=\{downloadUrl\}[\s\S]*?download=\{getFileName\(filePath\)\}/);
  assert.match(source, /onClick=\{\(\) => void run\(\(\) => openDesktopPath\(absolutePath\)\)\}/);
  assert.match(source, /t\("files\.openWithSystem"\)/);
});

test("the caret menu offers the app chooser, reveal, and copy path", () => {
  assert.match(source, /openDesktopPath\(absolutePath, "chooser"\)/);
  assert.match(source, /revealDesktopPath\(absolutePath\)/);
  assert.match(source, /copyText\(absolutePath\)/);
  assert.match(source, /t\("files\.openWithOther"\)/);
  assert.match(source, /t\("files\.revealInExplorer"\)/);
  assert.match(source, /t\("files\.copyFullPath"\)/);
});

test("menu closes on outside click and Escape", () => {
  assert.match(source, /rootRef\.current\?\.contains\(event\.target as Node\)/);
  assert.match(source, /event\.key === "Escape"/);
});

test("shell failures surface as a visible notice instead of failing silently", () => {
  assert.match(source, /catch \(failure\) \{[\s\S]*?setError\(failure instanceof Error \? failure\.message : String\(failure\)\)/);
  assert.match(source, /t\("files\.openFileFailed", \{ error \}\)/);
});

test("every viewer header uses the shared desktop-aware actions", () => {
  assert.doesNotMatch(viewer, /function DownloadLink\(/);
  const usages = viewer.match(/<FileHeaderActions filePath=\{filePath\} cwd=\{cwd\} sourceSessionId=\{sourceSessionId\} \/>/g) ?? [];
  assert.equal(usages.length, 4, "image, audio, document, and text headers must all use it");
  assert.match(viewer, /downloadUrl=\{getFileApiUrl\(filePath, "download", sourceSessionId\)\}/);
});

test("desktop detection is hydration-safe in server-rendered components", async () => {
  const hook = await readFile(new URL("../hooks/useIsDesktopApp.ts", import.meta.url), "utf8");
  const explorer = (await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");
  assert.match(hook, /useSyncExternalStore\(subscribe, getClientSnapshot, getServerSnapshot\)/);
  assert.match(hook, /const getServerSnapshot = \(\) => false/);
  // The explorer tree is prerendered too: it must not read the bridge in render.
  assert.match(explorer, /const desktop = useIsDesktopApp\(\)/);
  assert.doesNotMatch(explorer, /useState\(\(\) => isDesktopApp\(\)\)/);
});

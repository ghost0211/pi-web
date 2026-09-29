import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { detectWindowsShells, shellOptionId } = await jiti.import("./shell-detect.ts");

test("shellOptionId is stable and path-scoped", () => {
  assert.equal(shellOptionId("powershell", null), "powershell");
  assert.equal(shellOptionId("bash", null), "bash-auto");
  assert.equal(shellOptionId("bash", "C:\\Git\\bin\\bash.exe"), "bash:C:\\Git\\bin\\bash.exe");
});

test("detectWindowsShells always offers the generic entries", () => {
  const options = detectWindowsShells({
    exists: () => false,
    where: () => [],
    env: {},
  });
  assert.deepEqual(
    options.map((option) => option.id),
    ["powershell", "bash-auto"],
  );
});

test("detectWindowsShells finds Git Bash, PATH bash and WSL bash without duplicates", () => {
  const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
  const cygwinBash = "C:\\cygwin64\\bin\\bash.exe";
  const wslBash = "C:\\Windows\\System32\\bash.exe";
  const existing = new Set([gitBash, cygwinBash, wslBash].map((p) => p.toLowerCase()));
  const options = detectWindowsShells({
    exists: (path) => existing.has(path.toLowerCase()),
    // `where bash.exe` returns WSL's launcher first on many machines.
    where: (exe) => (exe === "bash.exe" ? [wslBash, cygwinBash] : []),
    env: { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" },
  });

  const ids = options.map((option) => option.id);
  assert.deepEqual(ids, [
    "powershell",
    "bash-auto",
    `bash:${gitBash}`,
    `bash:${cygwinBash}`,
    `bash:${wslBash}`,
  ]);
  // Labels distinguish the entries in the dropdown.
  const byId = new Map(options.map((option) => [option.id, option.labelKey]));
  assert.equal(byId.get(`bash:${gitBash}`), "gitBash");
  assert.equal(byId.get(`bash:${cygwinBash}`), "bashPath");
  assert.equal(byId.get(`bash:${wslBash}`), "wslBash");
});

test("detectWindowsShells dedupes PATH bash against Git Bash and tolerates missing PATH entries", () => {
  const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
  const options = detectWindowsShells({
    exists: (path) => path === gitBash, // `where` can return stale paths
    where: () => [gitBash, "C:\\gone\\bash.exe"],
    env: { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" },
  });
  assert.deepEqual(
    options.map((option) => option.id),
    ["powershell", "bash-auto", `bash:${gitBash}`],
  );
});

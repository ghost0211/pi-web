import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  deleteSshHost,
  getSshHostsPath,
  loadSshHosts,
  normalizeSshHostInput,
  saveSshHosts,
  upsertSshHost,
  validateSshHostInput,
} from "./ssh-hosts.ts";
import {
  buildSshTestArgs,
  buildSshfsArgs,
  buildUncTarget,
  findFreeDriveLetter,
  parseNetUse,
  parseRemotePath,
} from "./ssh-remote.ts";

function tempHostsFile() {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-ssh-test-"));
  return { path: join(dir, "ssh-hosts.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const VALID = { name: "dev", host: "192.168.1.10", user: "root", port: 22, identityFile: null };

test("getSshHostsPath stores hosts next to other agent settings", () => {
  assert.match(getSshHostsPath("X:\\agent"), /ssh-hosts\.json$/);
});

test("validateSshHostInput accepts a minimal valid entry", () => {
  assert.equal(validateSshHostInput(VALID), null);
  assert.equal(validateSshHostInput({ ...VALID, port: "2222" }), null);
});

test("validateSshHostInput rejects bad host/user/port and hostile identity paths", () => {
  assert.match(validateSshHostInput({ ...VALID, host: "bad host!" }) ?? "", /hostname or IP/);
  assert.match(validateSshHostInput({ ...VALID, user: "root;rm -rf /" }) ?? "", /user/);
  assert.match(validateSshHostInput({ ...VALID, port: 0 }) ?? "", /port/);
  assert.match(validateSshHostInput({ ...VALID, port: 70000 }) ?? "", /port/);
  assert.match(validateSshHostInput({ ...VALID, identityFile: 'C:\\bad"path' }) ?? "", /identityFile/);
  assert.match(validateSshHostInput({ ...VALID, name: "" }) ?? "", /name/);
});

test("loadSshHosts fails closed on missing or malformed files", () => {
  const { path, cleanup } = tempHostsFile();
  try {
    assert.deepEqual(loadSshHosts(path), []);
    writeFileSync(path, "not json", "utf8");
    assert.deepEqual(loadSshHosts(path), []);
    writeFileSync(path, JSON.stringify({ hosts: [{ id: "", bogus: true }] }), "utf8");
    assert.deepEqual(loadSshHosts(path), []);
  } finally {
    cleanup();
  }
});

test("upsert/delete roundtrip preserves entries and updates in place", () => {
  const { path, cleanup } = tempHostsFile();
  try {
    const created = upsertSshHost(VALID, undefined, path);
    assert.equal(loadSshHosts(path).length, 1);
    const updated = upsertSshHost({ ...VALID, name: "dev2", port: 2222 }, created.id, path);
    assert.equal(updated.id, created.id);
    assert.equal(updated.port, 2222);
    assert.equal(loadSshHosts(path).length, 1);
    assert.equal(loadSshHosts(path)[0].name, "dev2");
    assert.equal(deleteSshHost(created.id, path), true);
    assert.equal(deleteSshHost(created.id, path), false);
    assert.deepEqual(loadSshHosts(path), []);
  } finally {
    cleanup();
  }
});

test("normalizeSshHostInput trims and defaults identityFile", () => {
  assert.deepEqual(
    normalizeSshHostInput({ name: " a ", host: " h ", user: " u ", port: 22, identityFile: "  " }),
    { name: "a", host: "h", user: "u", port: 22, authType: "key", identityFile: null, password: null },
  );
});

test("password auth is validated, normalized and persisted", () => {
  // Password auth requires a password.
  assert.match(
    validateSshHostInput({ ...VALID, authType: "password" }) ?? "",
    /password is required/,
  );
  // Key auth drops any stored password; password auth drops the identity file.
  assert.deepEqual(
    normalizeSshHostInput({ ...VALID, authType: "password", password: "s3cret", identityFile: "C:/k" }),
    { name: "dev", host: "192.168.1.10", user: "root", port: 22, authType: "password", identityFile: null, password: "s3cret" },
  );
  assert.deepEqual(
    normalizeSshHostInput({ ...VALID, authType: "key", password: "s3cret" }),
    { name: "dev", host: "192.168.1.10", user: "root", port: 22, authType: "key", identityFile: null, password: null },
  );
  const { path, cleanup } = tempHostsFile();
  try {
    const created = upsertSshHost({ ...VALID, authType: "password", password: "pw" }, undefined, path);
    const loaded = loadSshHosts(path);
    assert.equal(loaded[0].authType, "password");
    assert.equal(loaded[0].password, "pw");
    assert.equal(created.authType, "password");
  } finally {
    cleanup();
  }
});

test("buildSshTestArgs uses batch mode, fast timeout and the success marker", () => {
  const args = buildSshTestArgs({ host: "h", port: 2222, user: "u", identityFile: "C:\\keys\\id" });
  const text = args.join(" ");
  assert.match(text, /BatchMode=yes/);
  assert.match(text, /ConnectTimeout=8/);
  assert.match(text, /-p 2222/);
  assert.match(text, /-i C:\\keys\\id/);
  assert.match(text, /IdentitiesOnly=yes/);
  assert.match(text, /u@h echo __pi_ssh_ok__/);
  // No identity file → no -i flag.
  assert.ok(!buildSshTestArgs({ host: "h", port: 22, user: "u", identityFile: null }).includes("-i"));
});

test("parseRemotePath classifies home-relative and absolute paths", () => {
  assert.deepEqual(parseRemotePath(""), { absolute: false, path: "" });
  assert.deepEqual(parseRemotePath("~/app"), { absolute: false, path: "app" });
  assert.deepEqual(parseRemotePath("projects/foo bar"), { absolute: false, path: "projects/foo bar" });
  assert.deepEqual(parseRemotePath("/srv/data/"), { absolute: true, path: "/srv/data" });
  assert.equal(parseRemotePath("C:\\evil"), null);
  assert.equal(parseRemotePath("a,b"), null);
  assert.equal(parseRemotePath("a!b"), null);
});

test("buildUncTarget picks the sshfs provider by path kind", () => {
  const host = { host: "h", port: 22, user: "root" };
  assert.equal(buildUncTarget(host, { absolute: false, path: "app/x" }), "\\\\sshfs.k\\root@h\\app\\x");
  assert.equal(buildUncTarget(host, { absolute: true, path: "/srv" }), "\\\\sshfs.kr\\root@h\\srv");
  assert.equal(buildUncTarget({ ...host, port: 2222 }, { absolute: false, path: "" }), "\\\\sshfs.k\\root@h!2222");
});

test("buildSshfsArgs targets the drive letter and carries the identity file", () => {
  const args = buildSshfsArgs(
    { host: "h", port: 2222, user: "root", identityFile: "C:/Users/x/.ssh/id" },
    { absolute: true, path: "/srv" },
    "Z",
  );
  assert.deepEqual(args, [
    "-o", "idmap=user,port=2222,reconnect,StrictHostKeyChecking=accept-new,IdentityFile=C:\\Users\\x\\.ssh\\id",
    "root@h:/srv",
    "Z:",
  ]);
});

test("findFreeDriveLetter walks Z downward and skips used letters", () => {
  assert.equal(findFreeDriveLetter(new Set()), "Z");
  assert.equal(findFreeDriveLetter(new Set(["Z", "Y"])), "X");
  assert.equal(findFreeDriveLetter(new Set("DEFGHIJKLMNOPQRSTUVWXYZ".split(""))), null);
});

test("parseNetUse extracts letters and UNC remotes from localized output", () => {
  const output = [
    "New connections will be remembered.",
    "",
    "Status       Local     Remote                    Network",
    "-------------------------------------------------------------------------------",
    "OK           Z:        \\\\sshfs.k\\root@h\\app      Windows Network",
    "Unavailable  Y:        \\\\sshfs.kr\\root@h!2222\\srv Windows Network",
  ].join("\r\n");
  assert.deepEqual(parseNetUse(output), [
    { letter: "Z", remote: "\\\\sshfs.k\\root@h\\app" },
    { letter: "Y", remote: "\\\\sshfs.kr\\root@h!2222\\srv" },
  ]);
});

test("saveSshHosts writes atomically-renameable json", () => {
  const { path, cleanup } = tempHostsFile();
  try {
    saveSshHosts([{ id: "a", ...VALID, createdAt: "x", updatedAt: "y" }], path);
    assert.equal(loadSshHosts(path)[0].id, "a");
  } finally {
    cleanup();
  }
});

test("parseNetUse tolerates localized status words", () => {
  const output = "\u6210\u529f           Z:        \\\\sshfs.k\\root@h\\app      Windows Network";
  assert.deepEqual(parseNetUse(output), [{ letter: "Z", remote: "\\\\sshfs.k\\root@h\\app" }]);
});

test("remote directory picker is wired into the new-session workspace menu", async () => {
  const { readFile } = await import("node:fs/promises");
  const chatWindow = await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");
  assert.match(chatWindow, /sidebar\.openRemoteDirectory/);
  assert.match(chatWindow, /<RemoteDirPicker/);
  // Opening a mounted drive reuses the normal cwd selection path.
  assert.match(chatWindow, /onSelectCwd\?\.\(localPath\)/);
  const settingsPanel = await readFile(new URL("../components/SettingsPanel.tsx", import.meta.url), "utf8");
  assert.match(settingsPanel, /sectionHost\("ssh", <SshConfig/);
});

test("remote directory browsing: sh paths, ls args and output parsing", async () => {
  const remote = await import("./ssh-remote.ts");

  assert.equal(remote.toShPath(""), '"$HOME"');
  assert.equal(remote.toShPath("~"), '"$HOME"');
  assert.equal(remote.toShPath("~/my app"), `"$HOME"/'my app'`);
  assert.equal(remote.toShPath("/etc/nginx"), "'/etc/nginx'");
  assert.equal(remote.toShPath("/it's"), "'/it'\"'\"'s'"); // POSIX single-quote escape

  const host = { host: "h", port: 2222, user: "root", identityFile: "C:/k" };
  const args = remote.buildSshLsArgs(host, "~/app");
  assert.ok(args.includes("-p") && args.includes("2222"));
  assert.ok(args.includes("root@h"));
  const command = args[args.length - 1];
  assert.ok(command.includes(`cd -- "$HOME"/'app'`));
  assert.ok(command.includes("__PI_PWD__"));
  // The [ -d ] test follows symlinks, so symlinked directories are listed.
  assert.ok(command.includes('for f in .[!.]* ..?* *; do [ -d "$f" ]'));

  const parsed = remote.parseSshLsOutput("__PI_PWD__/home/u\nproj\nnotes.txt\na b\nlinkdir/\n");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.path, "/home/u");
  assert.equal(parsed.parentPath, "/home");
  assert.deepEqual(parsed.directories, [
    { name: "proj", path: "/home/u/proj" },
    { name: "notes.txt", path: "/home/u/notes.txt" }, // every line is a directory per the remote command
    { name: "a b", path: "/home/u/a b" },
    { name: "linkdir", path: "/home/u/linkdir" }, // legacy trailing slash tolerated
  ]);

  const root = remote.parseSshLsOutput("__PI_PWD__/\netc\n");
  assert.equal(root.parentPath, null);
  assert.deepEqual(root.directories, [{ name: "etc", path: "/etc" }]);

  assert.equal(remote.parseSshLsOutput("garbage").ok, false);
  assert.equal(remote.remoteParentPath("/a/b/"), "/a");
  assert.equal(remote.remoteParentPath("/a"), "/");
  assert.equal(remote.remoteParentPath("/"), null);

  // Logical path normalization: symlinks stay as typed, ~/ and relative
  // paths resolve against the login home, dot segments collapse textually.
  const home = "/home/u";
  assert.equal(remote.normalizeLogicalRemotePath("", home), home);
  assert.equal(remote.normalizeLogicalRemotePath("~", home), home);
  assert.equal(remote.normalizeLogicalRemotePath("~/app", home), "/home/u/app");
  assert.equal(remote.normalizeLogicalRemotePath("rel/dir", home), "/home/u/rel/dir");
  assert.equal(remote.normalizeLogicalRemotePath("/a//b/./c/../d", home), "/a/b/d");
  assert.equal(remote.normalizeLogicalRemotePath("../../etc", home), "/etc");
  assert.equal(remote.normalizeLogicalRemotePath("/", home), "/");
});

test("remote directory picker UI browses via /api/ssh/ls like the local picker", async () => {
  const { readFile } = await import("node:fs/promises");
  const pickerSource = await readFile(new URL("../components/RemoteDirPicker.tsx", import.meta.url), "utf8");
  assert.match(pickerSource, /\/api\/ssh\/ls/);
  assert.match(pickerSource, /directoryPicker\.goToParent/);
  assert.match(pickerSource, /\/api\/ssh\/mount/);
  const routeSource = await readFile(new URL("../app/api/ssh/ls/route.ts", import.meta.url), "utf8");
  assert.match(routeSource, /buildSshLsArgs/);
  assert.match(routeSource, /listRemotePasswordDir/);
});

test("UNC mounts map the host root and join the path onto the drive", async () => {
  const remote = await import("./ssh-remote.ts");
  const host = { host: "h", port: 22, user: "u" };

  // Windows rejects a path inside the UNC name ("error 67: The network name
  // cannot be found"), so only the provider root may be mapped.
  assert.equal(remote.buildUncRoot(host, { absolute: true, path: "/home/u/p" }), "\\\\sshfs.r\\u@h");
  assert.equal(remote.buildUncRoot(host, { absolute: false, path: "p" }), "\\\\sshfs\\u@h");
  assert.equal(remote.buildUncRoot(host, { absolute: true, path: "/srv" }, { keyAuth: true }), "\\\\sshfs.kr\\u@h");
  assert.equal(remote.buildUncRoot(host, { absolute: false, path: "" }, { keyAuth: true }), "\\\\sshfs.k\\u@h");
  assert.equal(remote.buildUncRoot({ ...host, port: 2222 }, { absolute: true, path: "/srv" }), "\\\\sshfs.r\\u@h!2222");

  assert.equal(remote.mappedDrivePath("Y", { absolute: true, path: "/home/u/projects/app" }), "Y:\\home\\u\\projects\\app");
  assert.equal(remote.mappedDrivePath("Y", { absolute: false, path: "projects/app" }), "Y:\\projects\\app");
  assert.equal(remote.mappedDrivePath("Y", { absolute: true, path: "/" }), "Y:\\");
  assert.equal(remote.mappedDrivePath("Y", { absolute: false, path: "" }), "Y:\\");
});

test("child-process output is decoded from the Windows OEM code page", async (t) => {
  const remote = await import("./ssh-remote.ts");
  let gbkAvailable = true;
  try { new TextDecoder("gbk"); } catch { gbkAvailable = false; }
  if (!gbkAvailable) {
    t.skip("this Node build has no GBK decoder (small-icu)");
    return;
  }
  // GBK bytes for 系统错误 67 (what net.exe writes on a zh-CN console).
  const gbk = Buffer.from([0xcf, 0xb5, 0xcd, 0xb3, 0xb4, 0xed, 0xce, 0xf3, 0x20, 0x36, 0x37]);
  assert.equal(remote.decodeWindowsOutput(gbk), "系统错误 67");
  assert.equal(remote.decodeWindowsOutput(Buffer.from("System error 67", "utf8")), "System error 67");
  assert.equal(remote.decodeWindowsOutput(Buffer.alloc(0)), "");
});

test("startSshfsMount observes readiness instead of waiting for the mount to exit", async (t) => {
  const remote = await import("./ssh-remote.ts");
  const { execFileSync } = await import("node:child_process");
  const { existsSync, readFileSync } = await import("node:fs");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pi-web-sshfs-mount-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const script = join(dir, "fake-sshfs.mjs");
  const pidFile = join(dir, "pid");
  const { writeFileSync } = await import("node:fs");
  // A long-lived "mount": it must NOT be awaited, exactly like sshfs.exe.
  writeFileSync(script, [
    `import { writeFileSync } from "node:fs";`,
    `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    `console.error("fake-sshfs started");`,
    `setTimeout(() => console.error("mount reset by peer"), 50);`,
    `setInterval(() => {}, 1000);`,
  ].join("\n"), "utf8");

  const killPid = (pid) => {
    try {
      if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
      else process.kill(pid, "SIGKILL");
    } catch { /* gone */ }
  };
  const alive = (pid) => {
    try {
      // Signal 0 probes existence without touching the process (both platforms).
      process.kill(pid, 0);
      return true;
    } catch { return false; }
  };

  // 1. A drive that becomes available must leave the process running.
  let probes = 0;
  const ready = await remote.startSshfsMount({
    binary: process.execPath,
    args: [script],
    driveLetter: "Q",
    timeoutMs: 8_000,
    probeDrive: () => (++probes >= 2),
  });
  assert.equal(ready.ready, true, "a live mount is reported ready");
  assert.ok(probes >= 2, "readiness is polled, not assumed");
  const pid = Number(readFileSync(pidFile, "utf8"));
  t.after(() => killPid(pid));
  assert.equal(alive(pid), true, "the mount process is left running for the mount to survive");
  assert.match(ready.detail, /fake-sshfs started/);

  // 2. A mount that never becomes available is killed and reported.
  const deadPidFile = join(dir, "pid2");
  writeFileSync(script, [
    `import { writeFileSync } from "node:fs";`,
    `writeFileSync(${JSON.stringify(deadPidFile)}, String(process.pid));`,
    `console.error("read: Connection reset by peer");`,
    `setInterval(() => {}, 1000);`,
  ].join("\n"), "utf8");
  const failed = await remote.startSshfsMount({
    binary: process.execPath,
    args: [script],
    driveLetter: "Q",
    timeoutMs: 1_200,
    probeDrive: () => false,
  });
  assert.equal(failed.ready, false);
  assert.match(failed.detail, /Connection reset by peer/, "the child's own error is reported");
  const deadPid = Number(readFileSync(deadPidFile, "utf8"));
  // The killed process disappears; give Windows a moment to reap it.
  let stillAlive = true;
  for (let i = 0; i < 20 && stillAlive; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    stillAlive = alive(deadPid);
  }
  assert.equal(stillAlive, false, "a failed mount must not leave an orphan process");
  assert.equal(existsSync(pidFile), true);
});

test("the mount route and the picker share one payload contract", async () => {
  const { readFile } = await import("node:fs/promises");
  const { mountedResponse, mountFailure } = await import("./ssh-mount-contract.ts");

  // The client accepts a mount only when `ok` and `mountPoint` are present.
  const success = mountedResponse({
    driveLetter: "Z",
    mountPoint: "Z:\\home\\u\\proj",
    remotePath: "/home/u/proj",
    reused: false,
    backend: "unc",
  });
  assert.equal(success.ok, true);
  assert.equal(success.mountPoint, "Z:\\home\\u\\proj");
  assert.equal(success.driveLetter, "Z");
  assert.equal(success.remotePath, "/home/u/proj");
  assert.equal(success.backend, "unc");
  assert.deepEqual(mountFailure("boom", { backend: "sshfs" }), { ok: false, error: "boom", backend: "sshfs" });

  const picker = await readFile(new URL("../components/RemoteDirPicker.tsx", import.meta.url), "utf8");
  assert.match(picker, /import type \{ MountResponse \} from "@\/lib\/ssh-mount-contract"/);
  assert.doesNotMatch(picker, /interface MountResponse/, "the picker must not redeclare the shape");
  assert.match(picker, /!data\.ok \|\| !data\.mountPoint/);

  const route = await readFile(new URL("../app/api/ssh/mount/route.ts", import.meta.url), "utf8");
  assert.match(route, /mountedResponse\(\{/);
  assert.doesNotMatch(route, /localPath, reused/, "the route must not answer with the private field name");
});

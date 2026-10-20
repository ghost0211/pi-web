import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createPresentFilesExtension } = await jiti.import("./present-files-extension.ts");
const { PRESENT_FILES_DETAILS_KIND } = await jiti.import("./present-files.ts");
const { allowFileRoot } = await jiti.import("./file-access.ts");
const { createAskUserQuestionExtension } = await jiti.import("./ask-user-question-extension.ts");

/** Run one inline extension's factory against a stub API and capture its tools. */
function loadTools(extension, options = {}) {
  const tools = new Map();
  extension.factory({
    registerTool(tool) {
      const name = options.nameOverride ?? tool.name;
      tools.set(name, tool);
    },
  });
  return tools;
}

const call = (tool, params, ctx) => tool.execute("call-1", params, undefined, undefined, ctx);

test("present_files declares a model-only tool that never runs programs", () => {
  const tools = loadTools(createPresentFilesExtension({ fallbackCwd: process.cwd() }));
  const tool = tools.get("present_files");
  assert.ok(tool);
  assert.equal(tool.exposure, "model-only");
  assert.match(tool.description, /primary results/i);
  assert.ok(Array.isArray(tool.promptGuidelines) && tool.promptGuidelines.length > 0);
  assert.ok(tool.promptGuidelines.some((line) => /present_files/.test(line)));
  // The guidance must also say to leave helper scripts out of the list.
  assert.ok(tool.promptGuidelines.some((line) => /helper/i.test(line)));
});

test("present_files fails closed when nothing can be verified", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-web-present-outside-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const tools = loadTools(createPresentFilesExtension({ fallbackCwd: root }));
  // A path that does not exist cannot be presented, whatever the roots are.
  await assert.rejects(
    () => call(tools.get("present_files"), { items: [{ path: "definitely-missing.sql" }] }, { cwd: root }),
    /No presentable file/,
  );
  // A relative path with no session cwd is rejected before any probe.
  const standalone = loadTools(createPresentFilesExtension());
  await assert.rejects(
    () => call(standalone.get("present_files"), { items: [{ path: "a.sql" }] }, {}),
    /working directory/,
  );
});

test("present_files resolves a workspace-relative file inside an allowed root", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-web-present-ok-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "sql"));
  await writeFile(path.join(root, "sql", "init.sql"), "-- migration", "utf8");
  allowFileRoot(root);

  const tools = loadTools(createPresentFilesExtension({ fallbackCwd: root }));
  const result = await call(tools.get("present_files"), {
    title: "Migration",
    items: [{ path: "sql/init.sql", caption: "final script" }],
  }, { cwd: root });

  const details = result.details;
  assert.equal(details.kind, PRESENT_FILES_DETAILS_KIND);
  assert.equal(details.title, "Migration");
  assert.equal(details.items.length, 1);
  assert.equal(details.items[0].kind, "text");
  assert.equal(details.items[0].caption, "final script");
  assert.ok(details.items[0].size > 0);
  assert.match(details.items[0].abs, /sql\/init\.sql$/);
  // The model-facing result stays a pointer list: no file body is repeated.
  const text = result.content[0].text;
  assert.match(text, /sql\/init\.sql/);
  assert.doesNotMatch(text, /-- migration/);
  assert.match(text, /Do not paste/);
});

test("present_files reports verified and rejected items separately", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-web-present-mixed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "ok.md"), "# report", "utf8");
  allowFileRoot(root);

  const tools = loadTools(createPresentFilesExtension({ fallbackCwd: root }));
  const result = await call(tools.get("present_files"), {
    items: [{ path: "ok.md" }, { path: "missing.md" }],
  }, { cwd: root });
  const kinds = result.details.items.map((item) => [item.path, item.kind]);
  assert.deepEqual(kinds, [["ok.md", "markdown"], ["missing.md", "missing"]]);
  assert.match(result.content[0].text, /Not shown/);
});

test("present_files cannot be used to escape the allow-list through a link", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-web-present-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  allowFileRoot(root);
  // A real system directory that no session cwd would authorize.
  const target = process.platform === "win32" ? "C:\\Windows" : "/etc";
  try {
    await symlink(target, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
  } catch {
    t.skip("this platform cannot create a directory link without elevation");
    return;
  }
  const inside = process.platform === "win32" ? "escape/win.ini" : "escape/hostname";

  const tools = loadTools(createPresentFilesExtension({ fallbackCwd: root }));
  // The lexical path is inside the root, but the realpath is not: fail closed.
  await assert.rejects(
    () => call(tools.get("present_files"), { items: [{ path: inside }] }, { cwd: root }),
    /No presentable file/,
  );
});

test("present_files honours its runtime switch", async () => {
  let enabled = false;
  const tools = loadTools(createPresentFilesExtension({ enabled: () => enabled }));
  await assert.rejects(() => call(tools.get("present_files"), { items: [{ path: "x" }] }, { cwd: "/" }), /disabled/);
  enabled = true;
  // Enabled but no session cwd is still a clear error, not a silent no-op.
  await assert.rejects(() => call(tools.get("present_files"), { items: [{ path: "x" }] }, {}), /working directory/);
});

test("ask_user_question validates arguments and reports a dismissal as a decline", async () => {
  const seen = [];
  const extension = createAskUserQuestionExtension({
    ask: async (questions, toolCallId) => {
      seen.push([questions, toolCallId]);
      return undefined;
    },
  });
  const tool = loadTools(extension).get("ask_user_question");
  assert.ok(tool);
  assert.equal(tool.exposure, "model-only");

  await assert.rejects(
    () => call(tool, { questions: [] }),
    /Invalid questionnaire/,
  );
  assert.equal(seen.length, 0);

  await assert.rejects(
    () => call(tool, {
      questions: [{
        header: "Env",
        question: "Which environment?",
        options: [{ label: "Test" }, { label: "Prod" }],
      }],
    }),
    /dismissed/,
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0][1], "call-1");
});

test("ask_user_question returns a plain-text answer summary the model can use", async () => {
  const extension = createAskUserQuestionExtension({
    ask: async () => [{ kind: "option", optionIndex: 0 }],
  });
  const tool = loadTools(extension).get("ask_user_question");
  const result = await call(tool, {
    questions: [{
      header: "Env",
      question: "Which environment?",
      options: [{ label: "Test", description: "rehearsal" }, { label: "Prod" }],
    }],
  });
  assert.match(result.content[0].text, /Test/);
  assert.equal(result.details.kind, "pi-web-questionnaire-answers/v1");
  assert.deepEqual(result.details.answers, [{ kind: "option", optionIndex: 0 }]);
});

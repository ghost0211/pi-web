import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { KimiTaskDock } = await jiti.import("./KimiTaskDock.tsx");
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

function pills(props = {}) {
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(KimiTaskDock, { messages: [], ...props })));
  assert.doesNotMatch(html, /kimi-task-live-dot/);
  const buttons = [...html.matchAll(/<button\b([^>]*class="kimi-task-pill[^>]+)>([\s\S]*?)<\/button>/g)].map(([, attributes, children]) => ({
    attributes,
    children,
    running: /class="[^"]*\bis-running\b/.test(attributes),
    label: attributes.match(/aria-label="([^"]*)"/)?.[1],
  }));
  assert.equal(buttons.length, 3);
  return buttons;
}

function subagent(status) {
  return {
    id: "child-session",
    path: "/tmp/child.jsonl",
    cwd: "/repo",
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-02T00:00:00.000Z",
    messageCount: 3,
    firstMessage: "Inspect code",
    relation: { kind: "subagent", parentSessionId: "parent", profile: "explore", description: "Inspect", status },
  };
}

const plan = (status) => Array.from({ length: 4 }, (_, index) => ({
  id: `task-${index}`, title: `Task ${index}`, status: index === 0 ? status : "queued",
}));

test("idle task pills have no running decoration", () => {
  const buttons = pills();
  assert.deepEqual(buttons.map(button => button.running), [false, false, false]);
  for (const button of buttons) assert.doesNotMatch(button.label, /Running/);
});

test("Bash running state changes only decoration and accessible status, never the pill contents", () => {
  const idle = pills();
  const running = pills({ pendingBash: { command: "sleep 10" } });
  assert.deepEqual(running.map(button => button.children), idle.map(button => button.children));
  assert.deepEqual(running.map(button => button.running), [true, false, false]);
  assert.match(running[0].label, / · Running$/);
  assert.match(running[0].attributes, /title="Background Bash · Running"/);
});

test("shell tool completion removes the halo without changing visible text or adding status elements", () => {
  const assistant = { role: "assistant", content: [{ type: "toolCall", toolCallId: "shell-1", toolName: "powershell", input: { command: "echo ready" } }] };
  const running = pills({ messages: [assistant], agentRunning: true });
  assert.equal(running[0].running, true);
  const settled = pills({ messages: [assistant, { role: "toolResult", toolCallId: "shell-1", content: [], isError: false }] });
  assert.equal(settled[0].running, false);
  assert.equal(settled[0].children, running[0].children);
  assert.doesNotMatch(settled[0].label, /Running/);
});

test("subagent halo follows the authoritative running snapshot, not a stale record", () => {
  const completed = pills({ subagentSessions: [subagent("completed")] });
  // A persisted "running" status with no live id is a leftover from an earlier
  // server/session, so it must not keep the pill glowing once the parent idles.
  const stale = pills({ subagentSessions: [subagent("running")] });
  const live = pills({ subagentSessions: [subagent("completed")], runningSessionIds: new Set(["child-session"]) });
  assert.equal(completed[1].running, false);
  assert.equal(stale[1].running, false, "a stale running record must not glow");
  assert.doesNotMatch(stale[1].label, /Running/);

  // The running snapshot is authoritative: a background subagent may still be
  // working while the parent session is idle.
  assert.deepEqual(live.map(button => button.running), [false, true, false]);
  assert.equal(live[1].children, completed[1].children);
  assert.match(live[1].label, / · Running$/);
});

test("task progress uses the same halo contract and preserves its completion counter", () => {
  const queued = pills({ fallbackPlan: plan("queued") });
  // A plan item only counts as running while the turn is: a recorded
  // "in progress" from a settled turn renders as unfinished instead.
  const running = pills({ fallbackPlan: plan("running"), agentRunning: true });
  const settled = pills({ fallbackPlan: plan("running") });
  const completed = pills({ fallbackPlan: plan("done") });
  assert.deepEqual(running.map(button => button.running), [false, false, true]);
  assert.equal(running[2].children, queued[2].children);
  assert.match(running[2].label, /0\/4 · Running$/);
  assert.equal(settled[2].running, false, "a settled turn must not glow");
  assert.doesNotMatch(settled[2].label, /Running/);
  assert.equal(completed[2].running, false);
  assert.match(completed[2].label, /1\/4$/);
});

test("all three pills can glow independently without extra flex children", () => {
  const idle = pills({ fallbackPlan: plan("queued") });
  const running = pills({
    pendingBash: { command: "sleep 10" },
    subagentSessions: [subagent("running")],
    runningSessionIds: new Set(["child-session"]),
    fallbackPlan: plan("running"),
    agentRunning: true,
  });
  assert.deepEqual(running.map(button => button.running), [true, true, true]);
  assert.deepEqual(running.map(button => button.children), idle.map(button => button.children));
  for (const button of running) assert.equal([...button.children.matchAll(/<span\b/g)].length, 1);
});

test("the green breathing halo is inset and paint-only so the scroll container cannot clip it or change layout", () => {
  const base = css.match(/\.kimi-task-pill \{([^}]+)\}/)?.[1];
  assert.match(base, /position: relative/);
  assert.match(base, /flex-shrink: 0/);
  assert.match(base, /font-variant-numeric: tabular-nums/);
  const halo = css.match(/\.kimi-task-pill\.is-running::after \{([^}]+)\}/)?.[1];
  assert.match(halo, /position: absolute/);
  assert.match(halo, /inset: 0/);
  assert.match(halo, /border-radius: inherit/);
  assert.match(halo, /pointer-events: none/);
  assert.match(halo, /box-shadow: inset[^;]+#22c55e/);
  assert.match(halo, /animation: kimi-task-running-halo/);
  assert.doesNotMatch(halo, /(?:^|;)\s*(?:border|padding|margin|width|height|transform)\s*:/);
  const keyframes = css.match(/@keyframes kimi-task-running-halo \{([\s\S]*?)\n\}/)?.[1];
  assert.match(keyframes, /opacity:/);
  assert.doesNotMatch(keyframes, /(?:border|padding|margin|width|height|transform)\s*:/);
  assert.doesNotMatch(css, /kimi-task-live-dot|kimi-live-pulse/);
});

test("reduced motion retains a static visible green ring rather than removing the running indicator", () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.kimi-task-pill\.is-running::after \{\s*animation: none;\s*opacity: 1;/);
});

test("an in-progress plan item is unfinished, not running, once the turn settles", () => {
  const stalePlan = [
    { id: "p1", title: "Done step", status: "done" },
    { id: "p2", title: "Half step", status: "running" },
    { id: "p3", title: "Next step", status: "queued" },
  ];
  const idle = pills({ fallbackPlan: stalePlan });
  // The pill must not glow or claim to be running while the session is idle.
  assert.deepEqual(idle.map(button => button.running), [false, false, false]);
  assert.doesNotMatch(idle[2].label, /Running/);
  assert.match(idle[2].label, /1\/3$/, "the counter still reports the recorded plan");

  const live = pills({ fallbackPlan: stalePlan, agentRunning: true });
  assert.deepEqual(live.map(button => button.running), [false, false, true]);
  assert.match(live[2].label, /Running$/);
});

test("the settled plan rows label the carried-over item as unfinished", () => {
  const stalePlan = [{ id: "p1", title: "Half step", status: "running" }];
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(KimiTaskDock, { messages: [], fallbackPlan: stalePlan })));
  // Opening the panel is a client interaction; the SSR pass only renders pills.
  assert.doesNotMatch(html, /kimi-task-row/);
  // The pill state is the contract that matters here.
  assert.doesNotMatch(html, /is-running/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { parseScheduleTime } = await jiti.import("./ScheduleSendDialog.tsx");
const dialogSource = await (await import("node:fs/promises")).readFile(new URL("./ScheduleSendDialog.tsx", import.meta.url), "utf8");
const menuSource = await (await import("node:fs/promises")).readFile(new URL("./ComposerToolsMenu.tsx", import.meta.url), "utf8");
const chatInputSource = await (await import("node:fs/promises")).readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const hookSource = await (await import("node:fs/promises")).readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");

test("parseScheduleTime rounds to the minute and only accepts future times", () => {
  const now = new Date("2026-10-22T10:00:30").getTime();
  // A time one minute ahead is valid, rounded down to the minute.
  assert.equal(parseScheduleTime("2026-10-22T10:01:45", now), new Date("2026-10-22T10:01:00").getTime());
  // The current minute (already started) is rejected.
  assert.equal(parseScheduleTime("2026-10-22T10:00:00", now), null);
  assert.equal(parseScheduleTime("2026-10-22T10:00:45", now), null);
  // Past and malformed values are rejected.
  assert.equal(parseScheduleTime("2026-10-22T09:59", now), null);
  assert.equal(parseScheduleTime("not-a-time", now), null);
  assert.equal(parseScheduleTime("", now), null);
});

test("the schedule-send dialog is a minute-precision datetime-local form", () => {
  assert.match(dialogSource, /type="datetime-local"/);
  assert.match(dialogSource, /step=\{60\}/);
  assert.match(dialogSource, /role="dialog"/);
  assert.match(dialogSource, /aria-modal="true"/);
  // The description explains the minute precision.
  assert.match(dialogSource, /scheduleSend\.description/);
});

test("the composer tools menu replaces the auto-advance trigger and opens both dialogs", () => {
  // The standalone auto-advance trigger button is gone from ChatInput's tree;
  // AutoAdvanceControl is rendered dialog-only and driven by the menu.
  assert.match(chatInputSource, /<ComposerToolsMenu/);
  assert.match(chatInputSource, /dialogOnly\s+open=\{autoAdvanceOpen\}/);
  assert.match(chatInputSource, /<ScheduleSendDialog/);
  assert.match(chatInputSource, /onSelect: \(\) => setAutoAdvanceOpen\(true\)/);
  assert.match(chatInputSource, /setScheduleSendOpen\(true\)/);
  assert.match(chatInputSource, /scheduledSend \? t\("scheduleSend.cancelScheduled"\) : t\("chat.toolsScheduleSend"\)/);
  // The menu trigger is labelled "tools".
  assert.match(menuSource, /t\("chat.tools"\)/);
});

test("nested tools menus preserve the More panel and only consume Escape while open", () => {
  assert.match(menuSource, /data-composer-controls-portal="tools"/);
  assert.match(menuSource, /if \(event\.key !== "Escape" \|\| !open\) return/);
  assert.match(menuSource, /if \(open\) panelRef\.current\?\.querySelector[\s\S]*?focus\(\{ preventScroll: true \}\)/);
  assert.match(menuSource, /onKeyDown=\{onKeyDown\} style=\{\{ position: "relative"/);
});

test("scheduled sends are cancelled on session change and fire steer/follow-up or send", () => {
  assert.match(hookSource, /cancelScheduledSend/);
  assert.match(hookSource, /clearTimeout\(scheduledSendTimerRef\.current\)/);
  // Session-change effect clears the timer.
  assert.match(hookSource, /\}, \[activeSessionId\]\);/);
  // A running turn queues as follow-up, an idle one sends normally.
  assert.match(hookSource, /agentRunningRef\.current \|\| bashRunningRef\.current/);
  assert.match(hookSource, /sendStreamingPrompt\(message, "followUp"\)/);
  assert.match(hookSource, /handleSend\(message\)/);
  // Only fires while the scheduled conversation is still open.
  assert.match(hookSource, /scheduledSendSessionRef\.current !== sessionIdRef\.current/);
});

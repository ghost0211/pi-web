import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  validateAutoAdvanceConfig,
  parseAutoAdvanceDecision,
  AutoAdvanceController,
  TERMINAL_REASONS,
} = await jiti.import("./auto-advance-controller.ts");

function sampleConfig(overrides = {}) {
  return {
    goal: "Implement and verify feature X",
    scope: "Only edit src/feature-x.ts and tests",
    model: { provider: "anthropic", modelId: "claude-3-5-sonnet" },
    maxRounds: 3,
    ...overrides,
  };
}

const trackedControllers = [];

/** Clean up evaluation/retry work after every test, including failed assertions. */
function createController(ports) {
  const controller = new AutoAdvanceController(ports);
  trackedControllers.push(controller);
  return controller;
}

afterEach(() => {
  while (trackedControllers.length > 0) trackedControllers.pop().destroy();
});

function delay(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("validateAutoAdvanceConfig accepts valid input and returns normalized config", () => {
  const input = sampleConfig();
  const config = validateAutoAdvanceConfig(input);
  assert.deepEqual(config, input);
});

test("surrogate thinking accepts canonical preferences, rejects malformed values, and preserves legacy payloads", () => {
  for (const thinkingLevel of ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.equal(validateAutoAdvanceConfig(sampleConfig({ thinkingLevel })).thinkingLevel, thinkingLevel);
  }
  for (const thinkingLevel of [null, false, 3, "", "HIGH", " high ", "adaptive", {}, []]) {
    assert.throws(() => validateAutoAdvanceConfig(sampleConfig({ thinkingLevel })), /thinkingLevel must be/);
  }
  const legacy = validateAutoAdvanceConfig(sampleConfig());
  assert.equal(Object.hasOwn(legacy, "thinkingLevel"), false, "no inherited main-model preference is invented");
});

test("validateAutoAdvanceConfig rejects non-objects or null/array", () => {
  assert.throws(() => validateAutoAdvanceConfig(null), /non-null object/);
  assert.throws(() => validateAutoAdvanceConfig(undefined), /non-null object/);
  assert.throws(() => validateAutoAdvanceConfig("string"), /non-null object/);
  assert.throws(() => validateAutoAdvanceConfig(42), /non-null object/);
  assert.throws(() => validateAutoAdvanceConfig([]), /non-null object/);
});

test("validateAutoAdvanceConfig enforces bounded nonempty goal and scope", () => {
  assert.throws(() => validateAutoAdvanceConfig(sampleConfig({ goal: "" })), /goal must be a non-empty/);
  assert.throws(() => validateAutoAdvanceConfig(sampleConfig({ goal: "   " })), /goal must be a non-empty/);
  assert.throws(() => validateAutoAdvanceConfig(sampleConfig({ goal: "a".repeat(4001) })), /goal must be a non-empty string <= 4000/);

  assert.throws(() => validateAutoAdvanceConfig(sampleConfig({ scope: "" })), /scope must be a non-empty/);
  assert.throws(() => validateAutoAdvanceConfig(sampleConfig({ scope: "   " })), /scope must be a non-empty/);
  assert.throws(() => validateAutoAdvanceConfig(sampleConfig({ scope: "a".repeat(2001) })), /scope must be a non-empty string <= 2000/);
});

test("validateAutoAdvanceConfig enforces bounded model provider and modelId", () => {
  assert.throws(() => validateAutoAdvanceConfig(sampleConfig({ model: null })), /model must be an object/);
  assert.throws(() => validateAutoAdvanceConfig(sampleConfig({ model: { provider: "", modelId: "m" } })), /model\.provider must be a non-empty/);
  assert.throws(() => validateAutoAdvanceConfig(sampleConfig({ model: { provider: "p".repeat(257), modelId: "m" } })), /model\.provider must be a non-empty/);
  assert.throws(() => validateAutoAdvanceConfig(sampleConfig({ model: { provider: "p", modelId: "" } })), /model\.modelId must be a non-empty/);
  assert.throws(() => validateAutoAdvanceConfig(sampleConfig({ model: { provider: "p", modelId: "m".repeat(257) } })), /model\.modelId must be a non-empty/);
});

test("validateAutoAdvanceConfig accepts 1–99 rounds with no silent coercion or legacy budgets", () => {
  for (const maxRounds of [1, 6, 50, 99]) assert.equal(validateAutoAdvanceConfig(sampleConfig({ maxRounds })).maxRounds, maxRounds);
  for (const maxRounds of [0, -1, 100, 2.5, "3", null, undefined, NaN, Infinity]) {
    assert.throws(() => validateAutoAdvanceConfig(sampleConfig({ maxRounds })), /maxRounds must be an integer between 1 and 99/);
  }
  for (const [maxMinutes, tokenBudget] of [[1, 1000], [null, -1], ["invalid", NaN]]) {
    const normalized = validateAutoAdvanceConfig(sampleConfig({ maxMinutes, tokenBudget }));
    assert.deepEqual(normalized, sampleConfig(), "deprecated fields are stripped, never enforced");
  }
});

test("parseAutoAdvanceDecision parses valid continue, complete, and needs_user decisions", () => {
  const continueDec = parseAutoAdvanceDecision(
    JSON.stringify({
      decision: "continue",
      reason: "Next unit test",
      requiresConfirmation: false,
      nextPrompt: "Run test suite",
    }),
  );
  assert.deepEqual(continueDec, {
    decision: "continue",
    reason: "Next unit test",
    requiresConfirmation: false,
    nextPrompt: "Run test suite",
  });

  const completeDec = parseAutoAdvanceDecision(
    JSON.stringify({
      decision: "complete",
      reason: "All tests passing",
      requiresConfirmation: false,
    }),
  );
  assert.deepEqual(completeDec, {
    decision: "complete",
    reason: "All tests passing",
    requiresConfirmation: false,
  });

  const needsUserDec = parseAutoAdvanceDecision(
    JSON.stringify({
      decision: "needs_user",
      reason: "Need production deployment key",
      requiresConfirmation: true,
    }),
  );
  assert.deepEqual(needsUserDec, {
    decision: "needs_user",
    reason: "Need production deployment key",
    requiresConfirmation: true,
  });
});

test("parseAutoAdvanceDecision accepts entire fenced code block with or without json tag", () => {
  const fenced = "```json\n" + JSON.stringify({
    decision: "complete",
    reason: "Finished successfully",
    requiresConfirmation: false,
  }) + "\n```";
  assert.equal(parseAutoAdvanceDecision(fenced)?.decision, "complete");

  const plainFenced = "```\n" + JSON.stringify({
    decision: "needs_user",
    reason: "Wait for approval",
    requiresConfirmation: true,
  }) + "\n```";
  assert.equal(parseAutoAdvanceDecision(plainFenced)?.decision, "needs_user");
});

test("parseAutoAdvanceDecision fails closed on extraneous commentary or malformed input", () => {
  // Extra commentary outside fence
  const narrative = "Here is my decision:\n```json\n" + JSON.stringify({
    decision: "complete",
    reason: "Done",
    requiresConfirmation: false,
  }) + "\n```\nHope that helps!";
  assert.equal(parseAutoAdvanceDecision(narrative), null);

  // Invalid JSON
  assert.equal(parseAutoAdvanceDecision("not json"), null);
  assert.equal(parseAutoAdvanceDecision(""), null);
  assert.equal(parseAutoAdvanceDecision(null), null);
  assert.equal(parseAutoAdvanceDecision(123), null);

  // Unknown decision
  assert.equal(
    parseAutoAdvanceDecision(JSON.stringify({ decision: "retry", reason: "r", requiresConfirmation: false })),
    null,
  );

  // Non-boolean requiresConfirmation
  assert.equal(
    parseAutoAdvanceDecision(
      JSON.stringify({ decision: "complete", reason: "r", requiresConfirmation: "false" }),
    ),
    null,
  );

  // Reason > 2000 chars
  assert.equal(
    parseAutoAdvanceDecision(
      JSON.stringify({ decision: "complete", reason: "x".repeat(2001), requiresConfirmation: false }),
    ),
    null,
  );

  // Continue requires nonempty nextPrompt <= 4000
  assert.equal(
    parseAutoAdvanceDecision(
      JSON.stringify({ decision: "continue", reason: "r", requiresConfirmation: false }),
    ),
    null,
  );
  assert.equal(
    parseAutoAdvanceDecision(
      JSON.stringify({ decision: "continue", reason: "r", requiresConfirmation: false, nextPrompt: "" }),
    ),
    null,
  );
  assert.equal(
    parseAutoAdvanceDecision(
      JSON.stringify({ decision: "continue", reason: "r", requiresConfirmation: false, nextPrompt: "   " }),
    ),
    null,
  );
  assert.equal(
    parseAutoAdvanceDecision(
      JSON.stringify({ decision: "continue", reason: "r", requiresConfirmation: false, nextPrompt: "x".repeat(4001) }),
    ),
    null,
  );
});

test("start initializes revision 1 and each emitted state increments revision monotonically", async () => {
  const emittedRevisions = [];
  const emittedPhases = [];

  const controller = createController({
    isIdle: () => true,
    evaluate: async () => ({
      decision: { decision: "complete", reason: "Goal met", requiresConfirmation: false },
      tokens: 200,
    }),
    advance: async () => {},
    onState: (state) => {
      emittedRevisions.push(state.revision);
      emittedPhases.push(state.phase);
    },
  });

  const initialState = controller.start(sampleConfig());
  assert.equal(initialState.revision, 1);
  assert.equal(initialState.phase, "waiting");

  // Allow scheduled eval to complete
  await delay(20);

  assert.equal(controller.isActive(), false);
  const finalState = controller.getState();
  assert.equal(finalState.phase, "completed");
  assert.equal(finalState.reason, "goal_complete");

  // Revisions must start at 1 and strictly increase: 1 (waiting) -> 2 (evaluating) -> 3 (tokens) -> 4 (completed)
  assert.equal(emittedRevisions[0], 1);
  for (let i = 1; i < emittedRevisions.length; i++) {
    assert(
      emittedRevisions[i] > emittedRevisions[i - 1],
      `Revision ${emittedRevisions[i]} must be strictly greater than ${emittedRevisions[i - 1]}`,
    );
  }
});

test("start when busy stays in waiting phase until settled/idle", async () => {
  let isIdle = false;
  let evalCalled = false;

  const controller = createController({
    isIdle: () => isIdle,
    evaluate: async () => {
      evalCalled = true;
      return { decision: { decision: "complete", reason: "Done", requiresConfirmation: false }, tokens: 100 };
    },
    advance: async () => {},
    onState: () => {},
  });

  controller.start(sampleConfig());
  assert.equal(controller.getState()?.phase, "waiting");

  await delay(150); // Bounded retry expires
  assert.equal(evalCalled, false, "evaluate must not run while busy");
  assert.equal(controller.getState()?.phase, "waiting");

  // Now session becomes idle and fires onSettled
  isIdle = true;
  controller.onSettled();
  await delay(20);

  assert.equal(evalCalled, true, "evaluate runs after settling to idle");
  assert.equal(controller.getState()?.phase, "completed");
});

test("start throws if controller is already active", () => {
  const controller = createController({
    isIdle: () => false,
    evaluate: async () => ({ decision: null, tokens: 0 }),
    advance: async () => {},
    onState: () => {},
  });

  controller.start(sampleConfig());
  assert.equal(controller.isActive(), true);

  assert.throws(() => controller.start(sampleConfig()), /already active/);
});

test("advance counts round and sets running phase BEFORE advance port call; ownsRun is accurate", async () => {
  let roundObservedInAdvance = null;
  let phaseObservedInAdvance = null;
  let ownsRunObservedInAdvance = null;
  let advanceResolve;
  const advanceFinished = new Promise((resolve) => {
    advanceResolve = resolve;
  });

  const controller = createController({
    isIdle: () => true,
    evaluate: async () => ({
      decision: { decision: "continue", reason: "Next step", requiresConfirmation: false, nextPrompt: "Run build" },
      tokens: 150,
    }),
    advance: async () => {
      roundObservedInAdvance = controller.getState()?.round;
      phaseObservedInAdvance = controller.getState()?.phase;
      ownsRunObservedInAdvance = controller.ownsRun();
      advanceResolve();
    },
    onState: () => {},
  });

  controller.start(sampleConfig({ maxRounds: 1 }));
  assert.equal(controller.ownsRun(), false);

  await advanceFinished;
  await delay(20);

  assert.equal(roundObservedInAdvance, 1, "round must be incremented before advance is called");
  assert.equal(phaseObservedInAdvance, "running", "phase must be running before advance is called");
  assert.equal(ownsRunObservedInAdvance, true, "controller must own run during advance");
  assert.equal(controller.ownsRun(), false, "ownsRun resets when advance finishes");
});

test("onSettled while advance promise is pending defers eval until promise finishes AND isIdle", async () => {
  let advanceResolve;
  const advancePromise = new Promise((resolve) => {
    advanceResolve = resolve;
  });
  let evalCallCount = 0;
  let isIdle = false;

  const controller = createController({
    isIdle: () => isIdle,
    evaluate: async () => {
      evalCallCount += 1;
      return {
        decision: { decision: "continue", reason: "Step", requiresConfirmation: false, nextPrompt: "Step 1" },
        tokens: 100,
      };
    },
    advance: async () => {
      await advancePromise;
    },
    onState: () => {},
  });

  isIdle = true;
  controller.start(sampleConfig({ maxRounds: 3 }));
  await delay(10); // First eval completes and advance starts

  assert.equal(controller.ownsRun(), true);
  assert.equal(evalCallCount, 1);

  // During advance, wrapper is busy
  isIdle = false;
  // External settled event arrives while advance promise is pending
  controller.onSettled();
  await delay(10);

  assert.equal(evalCallCount, 1, "onSettled while advance is pending must not trigger eval prematurely");

  // Advance promise completes, but isIdle is still false
  advanceResolve();
  await delay(150); // Let bounded retries run
  assert.equal(evalCallCount, 1, "eval must still defer while isIdle is false");
  assert.equal(controller.getState()?.phase, "waiting");

  // Finally wrapper becomes idle
  isIdle = true;
  controller.onSettled();
  await delay(20);

  assert.equal(evalCallCount, 2, "eval runs once advance promise resolved and isIdle is true");
});

test("duplicate settled calls do not trigger concurrent evaluations", async () => {
  let evalConcurrent = false;
  let evalRunning = false;
  let evalTotal = 0;

  const controller = createController({
    isIdle: () => true,
    evaluate: async () => {
      if (evalRunning) evalConcurrent = true;
      evalRunning = true;
      evalTotal += 1;
      await delay(15);
      evalRunning = false;
      return {
        decision: { decision: "complete", reason: "Done", requiresConfirmation: false },
        tokens: 50,
      };
    },
    advance: async () => {},
    onState: () => {},
  });

  controller.start(sampleConfig());
  // Fire multiple settled events concurrently
  controller.onSettled();
  controller.onSettled();
  controller.onIdle();

  await delay(40);

  assert.equal(evalConcurrent, false, "evaluations must never run concurrently");
  assert.equal(evalTotal, 1);
});

test("repeated normalized nextPrompt terminates with no_progress", async () => {
  let terminalReason = null;

  const controller = createController({
    isIdle: () => true,
    evaluate: async () => ({
      // Next prompt with whitespace that normalizes to identical string
      decision: { decision: "continue", reason: "Try again", requiresConfirmation: false, nextPrompt: "   npm test \n" },
      tokens: 100,
    }),
    advance: async () => {},
    onState: () => {},
    onTerminal: (state) => {
      terminalReason = state.reason;
    },
  });

  controller.start(sampleConfig({ maxRounds: 3 }));

  // Round 1 advance runs
  await delay(20);
  // Round 2 eval runs and sees repeated prompt
  await delay(20);

  assert.equal(controller.getState()?.phase, "stopped");
  assert.equal(controller.getState()?.reason, "no_progress");
  assert.equal(terminalReason, "no_progress");
});

test("abortOwnedRun is called on stop ONLY when controller owns active running run", async () => {
  let abortCalled = false;

  const controller = createController({
    isIdle: () => true,
    evaluate: async () => ({
      decision: { decision: "continue", reason: "Cont", requiresConfirmation: false, nextPrompt: "Run" },
      tokens: 100,
    }),
    advance: async () => {
      await delay(50);
    },
    abortOwnedRun: () => {
      abortCalled = true;
    },
    onState: () => {},
  });

  controller.start(sampleConfig());
  await delay(10); // Enters running advance

  assert.equal(controller.ownsRun(), true);
  controller.stop("user_stop");

  assert.equal(abortCalled, true, "abortOwnedRun must be called when controller owns running run");
  assert.equal(controller.getState()?.phase, "stopped");
  assert.equal(controller.getState()?.reason, "user_stop");
});

test("abortOwnedRun is NOT called on stop when agent run is not owned by controller", () => {
  let abortCalled = false;

  const controller = createController({
    isIdle: () => false, // Agent is busy with external work
    evaluate: async () => ({ decision: null, tokens: 0 }),
    advance: async () => {},
    abortOwnedRun: () => {
      abortCalled = true;
    },
    onState: () => {},
  });

  controller.start(sampleConfig());
  assert.equal(controller.ownsRun(), false);

  controller.stop("manual_takeover");

  assert.equal(abortCalled, false, "abortOwnedRun must not be called when run is not owned");
  assert.equal(controller.getState()?.reason, "manual_takeover");
});

test("pause does NOT abort main for manual_takeover, configuration_changed, archived, or extension_ui", async () => {
  const pauseReasons = ["manual_takeover", "configuration_changed", "archived", "extension_ui"];

  for (const reason of pauseReasons) {
    let abortCalled = false;
    let advanceSignalAborted = false;

    const controller = createController({
      isIdle: () => true,
      evaluate: async () => ({
        decision: { decision: "continue", reason: "Next", requiresConfirmation: false, nextPrompt: "Step" },
        tokens: 100,
      }),
      advance: async (_config, _inst, signal) => {
        signal.addEventListener("abort", () => {
          advanceSignalAborted = true;
        });
        await delay(50);
      },
      abortOwnedRun: () => {
        abortCalled = true;
      },
      onState: () => {},
    });

    controller.start(sampleConfig());
    await delay(10); // Running advance

    assert.equal(controller.ownsRun(), true);
    controller.pause(reason);

    assert.equal(abortCalled, false, `pause ${reason} must NOT call abortOwnedRun (preserves main run)`);
    assert.equal(advanceSignalAborted, true, "in-flight request signal must be aborted");
    assert.equal(controller.getState()?.phase, "paused");
    assert.equal(controller.getState()?.reason, reason);
  }
});

test("pause with run_error DOES abort owned run if controller owns running advance", async () => {
  let abortCalled = false;

  const controller = createController({
    isIdle: () => true,
    evaluate: async () => ({
      decision: { decision: "continue", reason: "Next", requiresConfirmation: false, nextPrompt: "Step" },
      tokens: 100,
    }),
    advance: async () => {
      await delay(50);
    },
    abortOwnedRun: () => {
      abortCalled = true;
    },
    onState: () => {},
  });

  controller.start(sampleConfig());
  await delay(10); // Running advance

  assert.equal(controller.ownsRun(), true);
  controller.pause("run_error", "Fatal error");

  assert.equal(abortCalled, true, "pause run_error must abort owned run");
  assert.equal(controller.getState()?.phase, "paused");
  assert.equal(controller.getState()?.reason, "run_error");
});

test("abortOwnedRun returning a rejecting Promise is handled safely without unhandled rejection", async () => {
  const controller = createController({
    isIdle: () => true,
    evaluate: async () => ({
      decision: { decision: "continue", reason: "Next", requiresConfirmation: false, nextPrompt: "Step" },
      tokens: 100,
    }),
    advance: async () => {
      await delay(50);
    },
    abortOwnedRun: async () => {
      throw new Error("SDK abort failed asynchronously");
    },
    onState: () => {},
  });

  controller.start(sampleConfig());
  await delay(10);

  // Must not throw or leave unhandled rejection
  assert.doesNotThrow(() => {
    controller.stop("user_stop");
  });
  await delay(10);

  assert.equal(controller.getState()?.phase, "stopped");
});

test("stale async evaluate and advance results are discarded after stop/pause/restart", async () => {
  let evalResolve;
  const evalPromise = new Promise((resolve) => {
    evalResolve = resolve;
  });

  const controller = createController({
    isIdle: () => true,
    evaluate: async () => {
      await evalPromise;
      return {
        decision: { decision: "complete", reason: "Late result", requiresConfirmation: false },
        tokens: 100,
      };
    },
    advance: async () => {},
    onState: () => {},
  });

  controller.start(sampleConfig());
  await delay(10); // In evaluate phase

  // Manually stop before evaluate completes
  controller.stop("user_stop");
  assert.equal(controller.getState()?.phase, "stopped");
  assert.equal(controller.getState()?.reason, "user_stop");

  // Late evaluate resolves
  evalResolve();
  await delay(15);

  assert.equal(controller.getState()?.phase, "stopped", "stale evaluate must not transition stopped state");
  assert.equal(controller.getState()?.reason, "user_stop");

  // Now restart
  controller.start(sampleConfig());
  assert.equal(controller.getState()?.phase, "waiting");
  assert.equal(controller.getState()?.round, 0);
});

test("caps enforcement: round limit stops with round_limit and prevents proxy eval beyond cap", async () => {
  let proxyEvalRounds = 0;
  let terminalReason = null;

  const controller = createController({
    isIdle: () => true,
    evaluate: async () => {
      proxyEvalRounds += 1;
      return {
        decision: { decision: "continue", reason: "More work", requiresConfirmation: false, nextPrompt: `Round ${proxyEvalRounds}` },
        tokens: 100,
      };
    },
    advance: async () => {},
    onState: () => {},
    onTerminal: (state) => {
      terminalReason = state.reason;
    },
  });

  // Set maxRounds: 2
  controller.start(sampleConfig({ maxRounds: 2 }));

  await delay(50);

  assert.equal(controller.getState()?.round, 2);
  assert.equal(controller.getState()?.phase, "stopped");
  assert.equal(controller.getState()?.reason, "round_limit");
  assert.equal(terminalReason, "round_limit");
  assert.equal(proxyEvalRounds, 2, "no proxy eval beyond round cap");
});

test("99 rounds can use tens of millions of Tokens and stop only at the round cap", async () => {
  let evaluations = 0;
  let advances = 0;
  let finish;
  const terminal = new Promise(resolve => { finish = resolve; });
  const controller = createController({
    isIdle: () => true,
    evaluate: async () => ({
      decision: { decision: "continue", reason: "Next verified step", requiresConfirmation: false, nextPrompt: `Unique step ${++evaluations}` },
      tokens: 120000,
    }),
    advance: async () => { advances++; controller.addTokens(240000); },
    onState: () => {},
    onTerminal: finish,
  });
  controller.start(sampleConfig({ maxRounds: 99, maxMinutes: 1, tokenBudget: 1000 }));
  const state = await terminal;
  assert.equal(state.round, 99);
  assert.equal(state.tokensUsed, 99 * 360000);
  assert.equal(state.phase, "stopped");
  assert.equal(state.reason, "round_limit");
  assert.equal(evaluations, 99);
  assert.equal(advances, 99);
  assert.equal(Object.hasOwn(state.config, "tokenBudget"), false);
});

test("requiresConfirmation=true must precede even decision complete", async () => {
  let terminalReason = null;

  const controller = createController({
    isIdle: () => true,
    evaluate: async () => ({
      decision: {
        decision: "complete", // Claims complete, but requires confirmation!
        reason: "Please confirm deleting the old branches",
        requiresConfirmation: true,
      },
      tokens: 100,
    }),
    advance: async () => {},
    onState: () => {},
    onTerminal: (state) => {
      terminalReason = state.reason;
    },
  });

  controller.start(sampleConfig());
  await delay(20);

  assert.equal(controller.getState()?.phase, "stopped");
  assert.equal(controller.getState()?.reason, "needs_user");
  assert.equal(terminalReason, "needs_user");
});

test("decision missing boolean requiresConfirmation fails closed as run_error", async () => {
  const controller = createController({
    isIdle: () => true,
    evaluate: async () => ({
      decision: {
        decision: "complete",
        reason: "Done",
        // requiresConfirmation missing!
      },
      tokens: 100,
    }),
    advance: async () => {},
    onState: () => {},
  });

  controller.start(sampleConfig());
  await delay(20);

  assert.equal(controller.getState()?.phase, "paused");
  assert.equal(controller.getState()?.reason, "run_error");
});

test("an eight-hour main run has no deadline; explicit Stop still aborts it", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  let aborts = 0;
  let terminalState;
  let resolveAdvance;
  let runSignal;
  const controller = createController({
    isIdle: () => true,
    evaluate: async () => ({ decision: { decision: "continue", reason: "Next", requiresConfirmation: false, nextPrompt: "Long local verification" }, tokens: 100 }),
    advance: async (_config, _instruction, signal) => { runSignal = signal; await new Promise(resolve => { resolveAdvance = resolve; }); },
    abortOwnedRun: () => { aborts++; },
    onState: () => {},
    onTerminal: state => { terminalState = state; },
  });
  controller.start(sampleConfig({ maxMinutes: 1, tokenBudget: 1000 }));
  t.mock.timers.tick(0);
  await flush();
  assert.equal(controller.ownsRun(), true);
  t.mock.timers.tick(8 * 60 * 60 * 1000);
  await flush();
  controller.addTokens(30000000);
  assert.equal(controller.getState().phase, "running");
  assert.equal(controller.getState().tokensUsed, 30000100);
  assert.equal(runSignal.aborted, false);
  assert.equal(aborts, 0);
  assert.equal(terminalState, undefined);
  controller.stop();
  assert.equal(runSignal.aborted, true);
  assert.equal(aborts, 1);
  assert.equal(terminalState.reason, "user_stop");
  resolveAdvance();
  await flush();
  assert.equal(controller.getState().reason, "user_stop");
});

test("error handling: evaluate error pauses with run_error and bounded detail", async () => {
  let terminalState = null;

  const controller = createController({
    isIdle: () => true,
    evaluate: async () => {
      throw new Error("API rate limit exceeded");
    },
    advance: async () => {},
    onState: () => {},
    onTerminal: (state) => {
      terminalState = state;
    },
  });

  controller.start(sampleConfig());
  await delay(15);

  assert.equal(controller.getState()?.phase, "paused");
  assert.equal(controller.getState()?.reason, "run_error");
  assert.equal(controller.getState()?.detail, "API rate limit exceeded");
  assert.equal(terminalState?.reason, "run_error");
});

test("error handling: advance error pauses with run_error and bounded detail", async () => {
  const controller = createController({
    isIdle: () => true,
    evaluate: async () => ({
      decision: { decision: "continue", reason: "Step", requiresConfirmation: false, nextPrompt: "Step" },
      tokens: 100,
    }),
    advance: async () => {
      throw new Error("Command execution failed");
    },
    onState: () => {},
  });

  controller.start(sampleConfig());
  await delay(20);

  assert.equal(controller.getState()?.phase, "paused");
  assert.equal(controller.getState()?.reason, "run_error");
  assert.equal(controller.getState()?.detail, "Command execution failed");
});

test("missing/invalid usage affects statistics only, not a valid surrogate decision", async () => {
  for (const tokens of [undefined, null, -50, NaN, Infinity, "100"]) {
    let finish;
    const terminal = new Promise(resolve => { finish = resolve; });
    const controller = createController({
      isIdle: () => true,
      evaluate: async () => ({ decision: { decision: "complete", reason: "Verified", requiresConfirmation: false }, tokens }),
      advance: async () => assert.fail("complete must not advance"),
      onState: () => {},
      onTerminal: finish,
    });
    controller.start(sampleConfig());
    controller.addTokens(12);
    controller.addTokens(NaN);
    const state = await terminal;
    assert.equal(state.phase, "completed");
    assert.equal(state.reason, "goal_complete");
    assert.equal(state.tokensUsed, 12);
    assert.equal(state.usageIncomplete, true);
    controller.start(sampleConfig());
    assert.equal(controller.getState().usageIncomplete, undefined, "restart resets partial-usage metadata");
    controller.stop();
  }
});

test("invalid or overflowed metric totals stay finite without stopping an active run", () => {
  const controller = createController({ isIdle: () => false, evaluate: async () => ({ decision: null }), advance: async () => {}, onState: () => {} });
  controller.start(sampleConfig());
  controller.addTokens(Number.MAX_VALUE);
  controller.addTokens(Number.MAX_VALUE);
  assert.equal(controller.isActive(), true);
  assert.equal(controller.getState().tokensUsed, Number.MAX_VALUE);
  assert.equal(controller.getState().usageIncomplete, true);
});

test("onSettled with aborted or error stops/pauses controller", () => {
  const controller = createController({
    isIdle: () => false,
    evaluate: async () => ({ decision: null, tokens: 0 }),
    advance: async () => {},
    onState: () => {},
  });

  controller.start(sampleConfig());
  controller.onSettled({ aborted: true });
  assert.equal(controller.getState()?.phase, "stopped");
  assert.equal(controller.getState()?.reason, "aborted");

  controller.start(sampleConfig());
  controller.onSettled({ error: new Error("Subprocess failed") });
  assert.equal(controller.getState()?.phase, "paused");
  assert.equal(controller.getState()?.reason, "run_error");
  assert.equal(controller.getState()?.detail, "Subprocess failed");
});

test("onState exceptions and onTerminal exceptions do not cause unhandled failures", async () => {
  const controller = createController({
    isIdle: () => true,
    evaluate: async () => ({
      decision: { decision: "complete", reason: "Done", requiresConfirmation: false },
      tokens: 100,
    }),
    advance: async () => {},
    onState: () => {
      throw new Error("Broken listener");
    },
    onTerminal: () => {
      throw new Error("Broken terminal listener");
    },
  });

  assert.doesNotThrow(() => {
    controller.start(sampleConfig());
  });
  await delay(20);

  assert.equal(controller.getState()?.phase, "completed");
});

test("destroy stops active controller with destroyed reason but does NOT notify onTerminal", () => {
  let terminalNotified = false;

  const controller = createController({
    isIdle: () => false,
    evaluate: async () => ({ decision: null, tokens: 0 }),
    advance: async () => {},
    onState: () => {},
    onTerminal: () => {
      terminalNotified = true;
    },
  });

  controller.start(sampleConfig());
  assert.equal(controller.isActive(), true);

  controller.destroy();

  assert.equal(controller.isActive(), false);
  assert.equal(controller.getState()?.phase, "stopped");
  assert.equal(controller.getState()?.reason, "destroyed");
  assert.equal(terminalNotified, false, "no active terminal state notification on destroy");

  // Subsequent destroy on inactive controller is safe
  assert.doesNotThrow(() => controller.destroy());
});

test("all terminal reasons are accounted for in TERMINAL_REASONS constant", () => {
  const expected = [
    "goal_complete",
    "needs_user",
    "round_limit",
    "no_progress",
    "run_error",
    "aborted",
    "user_stop",
    "manual_takeover",
    "configuration_changed",
    "extension_ui",
    "archived",
    "destroyed",
  ];
  assert.deepEqual([...TERMINAL_REASONS].sort(), [...expected].sort());
});

import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  beginSessionDeletion,
  isSessionDeletionGuardError,
  withSessionMutationGuard,
} = await jiti.import("./session-deletion-guard.ts");

test("deletion barrier blocks new mutations and is released after an operation error", async () => {
  const barrier = beginSessionDeletion(["delete-guard-target"]);
  try {
    await assert.rejects(
      withSessionMutationGuard("delete-guard-target", () => assert.fail("mutation must not run")),
      (error) => isSessionDeletionGuardError(error) && /permanently deleted/.test(error.message),
    );
  } finally {
    barrier.release();
  }

  await assert.rejects(
    (async () => {
      const failed = beginSessionDeletion(["delete-guard-target"]);
      try {
        throw new Error("simulated unlink failure");
      } finally {
        failed.release();
      }
    })(),
    /simulated unlink failure/,
  );
  assert.equal(await withSessionMutationGuard("delete-guard-target", () => "unblocked"), "unblocked");
});

test("barrier acquisition fails closed when startup or mutation is already in flight", async () => {
  let finishMutation;
  const mutation = withSessionMutationGuard(
    "delete-guard-startup",
    () => new Promise((resolve) => { finishMutation = resolve; }),
  );

  assert.throws(
    () => beginSessionDeletion(["delete-guard-startup"]),
    (error) => isSessionDeletionGuardError(error) && /starting or being modified/.test(error.message),
  );
  finishMutation();
  await mutation;

  const barrier = beginSessionDeletion(["delete-guard-startup"]);
  barrier.release();
  assert.equal(await withSessionMutationGuard("delete-guard-startup", () => "recovered"), "recovered");
});

test("adding direct dependents is atomic and blocks every protected id", async () => {
  const busy = withSessionMutationGuard("delete-guard-dependent-busy", async () => {});
  let finishBusy;
  // Hold a separate operation so extending the barrier cannot partially mark
  // the other dependent before it discovers the busy id.
  const held = withSessionMutationGuard(
    "delete-guard-dependent-busy-2",
    () => new Promise((resolve) => { finishBusy = resolve; }),
  );
  await busy;

  const barrier = beginSessionDeletion(["delete-guard-root"]);
  try {
    assert.throws(
      () => barrier.add(["delete-guard-dependent-free", "delete-guard-dependent-busy-2"]),
      (error) => isSessionDeletionGuardError(error),
    );
    await withSessionMutationGuard("delete-guard-dependent-free", () => "not-marked");
    await assert.rejects(withSessionMutationGuard("delete-guard-root", () => "blocked"), isSessionDeletionGuardError);
  } finally {
    barrier.release();
    finishBusy();
    await held;
  }
});

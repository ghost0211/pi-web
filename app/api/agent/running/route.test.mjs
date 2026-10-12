import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET } = await jiti.import("./route.ts");

test("GET returns runningSessionStartedAt along with ids and phases", async () => {
  const response = await GET();
  assert.equal(response.status, 200);
  const data = await response.json();

  assert.ok(Array.isArray(data.runningSessionIds));
  assert.ok(typeof data.runningSessionPhases === "object" && data.runningSessionPhases !== null);
  assert.ok(typeof data.runningSessionStartedAt === "object" && data.runningSessionStartedAt !== null);
  assert.ok(Array.isArray(data.completionNotificationSuppressedSessionIds));
});

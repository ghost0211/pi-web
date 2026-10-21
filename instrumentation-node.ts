import { configureHttpDispatcher } from "./lib/http-dispatcher";
import { closeAllAgentEventStreams } from "./lib/agent-event-stream";
import { applyUtf8ChildProcessDefaults } from "./lib/child-process-utf8";

export function registerNodeInstrumentation(): void {
  // Every process this server spawns inherits these, so a GBK-emitting JVM or
  // Python cannot corrupt a command's transcript (see the module comment).
  applyUtf8ChildProcessDefaults();
  configureHttpDispatcher();

  // Next 16 waits for connections to finish on shutdown. Close live SSE
  // responses so its drain cannot keep a retired sidecar/server alive.
  const shutdownStreams = () => closeAllAgentEventStreams();
  process.on("SIGINT", shutdownStreams);
  process.on("SIGTERM", shutdownStreams);
}

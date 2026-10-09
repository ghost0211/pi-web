import { configureHttpDispatcher } from "./lib/http-dispatcher";
import { closeAllAgentEventStreams } from "./lib/agent-event-stream";

export function registerNodeInstrumentation(): void {
  configureHttpDispatcher();

  // Next 16 waits for connections to finish on shutdown. Close live SSE
  // responses so its drain cannot keep a retired sidecar/server alive.
  const shutdownStreams = () => closeAllAgentEventStreams();
  process.on("SIGINT", shutdownStreams);
  process.on("SIGTERM", shutdownStreams);
}

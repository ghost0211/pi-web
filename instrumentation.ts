export async function register(): Promise<void> {
  // Next compiles this entry for Node and Edge. A positive runtime branch
  // removes the Node-only imports and signal hooks from the Edge graph.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNodeInstrumentation } = await import("./instrumentation-node");
    registerNodeInstrumentation();
  }
}

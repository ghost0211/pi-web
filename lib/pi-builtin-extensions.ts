import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";

/**
 * SDK sessions do not install the CLI's builtins automatically. Use the same
 * names and replacement policy as Pi so -builtin: exclusions and existing MCP
 * adapters keep working. Factories only register behavior; MCP connections
 * start in session_start and stop in session_shutdown.
 *
 * Only normal parent sessions use these: Chat-only loads no services, and
 * subagents retain their explicit profile allowlists/resource policy.
 */
export function createPiBuiltinExtensions(): InlineExtension[] {
  return [
    { name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true },
    { name: "tool-search", factory: createToolSearchExtension(), replaceable: true, builtin: true },
    { name: "mcp", factory: createMcpExtension(), replaceable: true, builtin: true },
  ];
}

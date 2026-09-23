import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { SessionSystemPromptCustomization } from "./session-system-prompt";

export const SYSTEM_PROMPT_EXTENSION_NAME = "pi-web-system-prompt";

/**
 * Live system-prompt sources shared by an `AgentSessionWrapper` and its
 * extension. `exact` is filled in once the session (and its resource loader)
 * exists; `custom` is mutated by `setCustomSystemPrompt`.
 */
export interface SystemPromptState {
  /** Chat-only mode: the complete prompt that replaces Pi's base prompt. */
  exact?: () => string;
  /** Per-session user customization, read on every turn. */
  custom: SessionSystemPromptCustomization | null;
}

export interface SystemPromptPrompts {
  /** What Pi would send for this turn without a customization. */
  natural: string;
  /** What the request actually uses. */
  effective: string;
}

/**
 * Effective system prompt precedence: exactSystemPrompt (chat-only mode)
 * > custom replace > custom append > natural.
 *
 * Pi 0.86+ keeps the system prompt in the transcript (`AgentState.systemPrompt`
 * is read-only), so this is the text to force for the next request:
 * `before_agent_start` projects it as the request's leading system message
 * without recording it, which keeps the transcript's structured sections and
 * cached prefixes intact.
 */
export function computeEffectiveSystemPrompt(
  natural: string | undefined,
  state: SystemPromptState,
): string | undefined {
  if (state.exact) return state.exact();
  const custom = state.custom;
  if (!custom) return natural;
  if (custom.mode === "replace") return custom.text;
  if (natural === undefined) return undefined;
  return natural ? `${natural}\n\n${custom.text}` : custom.text;
}

/**
 * Forces the session's effective system prompt through the supported
 * `before_agent_start` boundary. Registered as an inline extension so it also
 * applies to chat-only and subagent sessions, which load no other extensions.
 */
export function createSystemPromptExtension(
  state: SystemPromptState,
  options: { onPrompts?: (prompts: SystemPromptPrompts) => void } = {},
): InlineExtension {
  return {
    name: SYSTEM_PROMPT_EXTENSION_NAME,
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      pi.on("before_agent_start", (event) => {
        const natural = event.systemPrompt;
        const effective = computeEffectiveSystemPrompt(natural, state);
        options.onPrompts?.({ natural, effective: effective ?? natural });
        if (effective === undefined || effective === natural) return undefined;
        return { systemPrompt: effective };
      });
    },
  };
}

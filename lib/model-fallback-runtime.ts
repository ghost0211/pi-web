import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
  estimateTokens,
  type AgentBeforeSettleEvent,
  type ExtensionContext,
  type InlineExtension,
  type MessageEndEvent,
} from "@earendil-works/pi-coding-agent";
import { classifyQuotaExhaustion, type QuotaExhaustion } from "./quota-errors";
import {
  sameFallbackModel,
  type FallbackModelRef,
  type ModelFallbackNotice,
} from "./model-fallback";
import { MODEL_FALLBACK_EVENT_TYPE } from "./session-model-fallback";
import { resolveModelThinkingLevel } from "./model-thinking-level";

export interface ModelFallbackRuntimeState {
  selection: FallbackModelRef | null;
  /** True after an explicit configure/clear; legacy sessions without an entry stay unwritten. */
  configured?: boolean;
  notice: ModelFallbackNotice | null;
  cancelled: boolean;
  resolveModel: (ref: FallbackModelRef) => Promise<Model<Api> | undefined>;
  /** Model-specific settings/scope pin only; never the primary session's level. */
  resolveDefaultThinkingLevel?: (ref: FallbackModelRef) => Promise<string | undefined>;
  onSwitch?: (notice: ModelFallbackNotice, thinkingLevel?: string) => void;
}

type ProviderEvidence = {
  status?: number;
  body?: unknown;
};

type ObservedRequest = {
  id: number;
  provider: string;
  api: string;
  modelId: string;
  providerError?: ProviderEvidence;
  bodyReady?: Promise<void>;
};

type FailedAssistant = {
  provider: string;
  api: string;
  modelId: string;
  errorMessage?: string;
};

type RuntimeInternal = {
  requestSequence: number;
  observed?: ObservedRequest;
  failed?: FailedAssistant;
  attempted: boolean;
};

const internals = new WeakMap<ModelFallbackRuntimeState, RuntimeInternal>();
const MAX_ERROR_BODY_BYTES = 16 * 1024;
const ERROR_BODY_WAIT_MS = 1_000;
const FALLBACK_CONTEXT_RESERVE_TOKENS = 4_096;

function internalFor(state: ModelFallbackRuntimeState): RuntimeInternal {
  let internal = internals.get(state);
  if (!internal) {
    internal = { requestSequence: 0, attempted: false };
    internals.set(state, internal);
  }
  return internal;
}

function refFromModel(model: Pick<Model<Api>, "provider" | "id">): FallbackModelRef {
  return { provider: model.provider, modelId: model.id };
}

function errorMessage(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 8_192) : undefined;
}

function parseBoundedErrorBody(text: string): unknown {
  const bounded = text.slice(0, MAX_ERROR_BODY_BYTES);
  const trimmed = bounded.trim();
  if (!trimmed.startsWith("{")) return bounded;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object" ? parsed : bounded;
  } catch {
    return bounded;
  }
}

async function readBoundedErrorBody(response: Response): Promise<unknown> {
  const clone = response.clone();
  if (!clone.body) return parseBoundedErrorBody(await clone.text());
  const reader = clone.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = MAX_ERROR_BODY_BYTES - size;
      chunks.push(value.byteLength > remaining ? value.slice(0, remaining) : value);
      size += Math.min(value.byteLength, remaining);
      if (value.byteLength > remaining) break;
    }
  } finally {
    if (size >= MAX_ERROR_BODY_BYTES) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return parseBoundedErrorBody(new TextDecoder().decode(merged));
}

function shouldInjectFetch(api: unknown): boolean {
  // The Google adapters explicitly reject a custom fetch. Other built-in chat
  // adapters either accept it or simply never use it (for example WebSockets).
  return typeof api !== "string" || !/^google(?:-|$|_)/i.test(api);
}

function observeFetch(fetchImpl: typeof globalThis.fetch, state: ModelFallbackRuntimeState, request: ObservedRequest): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (response.status >= 400 && internalFor(state).observed?.id === request.id) {
      request.providerError = { status: response.status };
      const read = readBoundedErrorBody(response)
        .then((body) => {
          if (internalFor(state).observed?.id === request.id) {
            request.providerError = { status: response.status, body };
          }
        })
        .catch(() => {});
      request.bodyReady = Promise.race([
        read,
        new Promise<void>((resolve) => setTimeout(resolve, ERROR_BODY_WAIT_MS)),
      ]);
    }
    return response;
  };
}

/**
 * Preserve the SDK/provider callbacks while retaining bounded raw error evidence
 * for this wrapper's latest request. Success or a new request invalidates it.
 */
export function observeModelFallbackErrors(streamFn: StreamFn, state: ModelFallbackRuntimeState): StreamFn {
  return async (model, context, options) => {
    const internal = internalFor(state);
    const request: ObservedRequest = {
      id: ++internal.requestSequence,
      provider: model.provider,
      api: String(model.api ?? ""),
      modelId: model.id,
    };
    internal.observed = request;
    internal.failed = undefined;

    const originalOnResponse = options?.onResponse;
    const observedOptions: SimpleStreamOptions = {
      ...options,
      onResponse: async (response, responseModel) => {
        if (internalFor(state).observed?.id === request.id && response.status >= 400) {
          request.providerError = { ...request.providerError, status: response.status };
        }
        await originalOnResponse?.(response, responseModel);
      },
    };
    if (shouldInjectFetch(model.api)) {
      observedOptions.fetch = observeFetch(options?.fetch ?? globalThis.fetch, state, request);
    }

    try {
      return await streamFn(model, context, observedOptions);
    } catch (error) {
      if (internalFor(state).observed?.id === request.id) {
        internal.failed = {
          provider: request.provider,
          api: request.api,
          modelId: request.modelId,
          errorMessage: errorMessage(error instanceof Error ? error.message : String(error)),
        };
      }
      throw error;
    }
  };
}

function assistantFailure(message: unknown): FailedAssistant | undefined {
  if (!message || typeof message !== "object") return undefined;
  const candidate = message as Partial<AssistantMessage>;
  if (candidate.role !== "assistant" || candidate.stopReason !== "error") return undefined;
  return {
    provider: typeof candidate.provider === "string" ? candidate.provider : "",
    api: typeof candidate.api === "string" ? candidate.api : "",
    modelId: typeof candidate.model === "string" ? candidate.model : "",
    errorMessage: errorMessage(candidate.errorMessage),
  };
}

function hasImageContent(messages: readonly unknown[]): boolean {
  return messages.some((message) => {
    const content = (message as { content?: unknown }).content;
    return Array.isArray(content) && content.some((block) => (block as { type?: unknown }).type === "image");
  });
}

function fitsContext(target: Model<Api>, event: AgentBeforeSettleEvent, excludedEntryId: string): boolean {
  if (!Number.isFinite(target.contextWindow) || target.contextWindow <= 0) return true;
  const retained = event.context.contextMessages.filter((message) =>
    !event.context.contextEntries.some((entry) =>
      entry.sourceEntry.id === excludedEntryId && entry.messages.includes(message),
    ),
  );
  const estimated = retained.reduce((sum, message) => sum + estimateTokens(message), 0);
  const reserve = Math.min(
    FALLBACK_CONTEXT_RESERVE_TOKENS,
    Number.isFinite(target.maxTokens) && target.maxTokens > 0 ? target.maxTokens : FALLBACK_CONTEXT_RESERVE_TOKENS,
  );
  return estimated + reserve <= target.contextWindow;
}

function findFailedEntryId(event: AgentBeforeSettleEvent, failed: FailedAssistant): string | undefined {
  for (let i = event.context.contextEntries.length - 1; i >= 0; i--) {
    const entry = event.context.contextEntries[i];
    const message = entry.messages.at(-1);
    const failure = assistantFailure(message);
    if (!failure) continue;
    if (failure.provider === failed.provider && failure.modelId === failed.modelId) return entry.sourceEntry.id;
  }
  return undefined;
}

async function classificationFor(
  state: ModelFallbackRuntimeState,
  failed: FailedAssistant,
): Promise<QuotaExhaustion | null> {
  const observed = internalFor(state).observed;
  const observedFailure = observed && observed.provider === failed.provider && observed.modelId === failed.modelId
    ? observed
    : undefined;
  await observedFailure?.bodyReady;
  return classifyQuotaExhaustion({
    provider: failed.provider,
    api: failed.api,
    errorMessage: failed.errorMessage,
    providerError: observedFailure?.providerError,
  });
}

/** Quota-only fallback is server-side and continues the current SDK context once. */
export function createModelFallbackExtension(state: ModelFallbackRuntimeState): InlineExtension {
  return {
    name: "pi-web-model-fallback",
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", () => {
        const internal = internalFor(state);
        internal.failed = undefined;
        internal.observed = undefined;
        internal.attempted = false;
        state.cancelled = false;
      });

      pi.on("message_end", (event: MessageEndEvent) => {
        const failure = assistantFailure(event.message);
        const internal = internalFor(state);
        if (failure) internal.failed = failure;
        else if (event.message.role === "assistant") internal.failed = undefined;
      });

      pi.on("agent_before_settle", async (event: AgentBeforeSettleEvent, ctx: ExtensionContext) => {
        const internal = internalFor(state);
        if (state.cancelled || internal.attempted || event.outcome !== "error") return undefined;
        const selection = state.selection;
        const failed = internal.failed;
        const current = ctx.model;
        if (!selection || !failed || !current || sameFallbackModel(selection, refFromModel(current))) return undefined;
        if (current.provider !== failed.provider || current.id !== failed.modelId) return undefined;

        const quota = await classificationFor(state, failed);
        if (!quota || state.cancelled) return undefined;

        let target;
        try {
          target = await state.resolveModel(selection);
        } catch {
          return undefined;
        }
        if (!target || state.cancelled) return undefined;
        const failedEntryId = findFailedEntryId(event, failed);
        if (!failedEntryId) return undefined;
        if (hasImageContent(event.context.contextMessages) && !target.input.includes("image")) return undefined;
        if (!fitsContext(target, event, failedEntryId)) return undefined;

        let switched = false;
        try {
          const modelDefault = await state.resolveDefaultThinkingLevel?.(selection);
          const thinkingLevel = resolveModelThinkingLevel(target, selection.thinkingLevel, modelDefault);
          if (state.cancelled) return undefined;
          switched = await pi.setModel(target);
          if (!switched || state.cancelled) return undefined;
          // setModel has one active thinking state. Override its inherited/clamped
          // primary value with this backup's independent preference before continuing.
          pi.setThinkingLevel(thinkingLevel);
        } catch {
          return undefined;
        }

        const notice: ModelFallbackNotice = {
          from: refFromModel(current),
          to: refFromModel(target),
          ruleId: quota.ruleId,
          kind: quota.kind,
          timestamp: Date.now(),
        };
        internal.attempted = true;
        state.notice = notice;
        state.onSwitch?.(notice, pi.getThinkingLevel());
        return {
          continue: true,
          entries: [
            {
              type: "custom",
              customType: MODEL_FALLBACK_EVENT_TYPE,
              data: { version: 1, notice },
            },
            { type: "context_edit", targetId: failedEntryId, replacement: null },
          ],
        };
      });
    },
  };
}

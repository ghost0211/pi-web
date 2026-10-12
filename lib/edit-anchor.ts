/**
 * Resolve the entry id that "Edit from here" must navigate to.
 *
 * Editing a user message truncates the branch to just before that message, so
 * the navigation target is the message's **parent entry**. The chat only holds
 * the visible branch window, and some entries never render at all (transcript
 * system messages for the prompt/tool loadout) while others render as cards
 * (compaction summaries, sub-agent reports, bash executions). Anchoring on
 * "the previous message must be an assistant" therefore hid the action
 * whenever one of those sat in between.
 *
 * Walk back to the nearest slot that still carries an entry id and use it: that
 * entry is the parent in every case the client can address, including the
 * non-assistant ones. Slots without an id (messages this client appended before
 * the server assigned one) are skipped, and an earlier user prompt ends the
 * walk — truncating past it would delete a turn the user never asked to remove.
 */
export interface EditAnchorMessage {
  role?: string;
}

export interface EditAnchorOptions {
  /** True when older history exists above the loaded window. */
  hasEarlierMessages?: boolean;
  /** Parent of the window's first entry, used only for the very first message. */
  firstEntryParentId?: string | null;
}

export function resolveEditAnchorEntryId(
  messages: readonly EditAnchorMessage[],
  entryIds: readonly (string | undefined)[],
  index: number,
  options: EditAnchorOptions = {},
): string | undefined {
  if (messages[index]?.role !== "user") return undefined;
  for (let i = index - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return undefined;
    const entryId = entryIds[i];
    if (entryId) return entryId;
  }
  // The window's first message has no predecessor in `messages`; when nothing
  // older exists, its parent entry is the session's root (usually no parent).
  return index === 0 && !options.hasEarlierMessages
    ? options.firstEntryParentId ?? undefined
    : undefined;
}

# Mobile web layout and session-model synchronization

## Layout

The mobile breakpoint remains 640 CSS pixels. Desktop layout and action permissions are unchanged.

- The chat header prioritizes the current session title. A compact statistics button opens the existing detail panel and retains >70%/>90% context warnings.
- Header actions are a labelled grid rather than a single icon-only row: two columns through 360px, three on larger phones. Outside click and Escape close it; Escape restores focus to its trigger.
- Session rows keep their virtualized fixed height. A mobile “…” button opens the existing context menu instead of showing permanent pin/archive controls. Clicking it must not select the session. Existing rename, archive, delete and busy/permission guards remain authoritative.
- The drawer uses more of a phone's width, a stronger scrim and larger touch targets. Desktop hover actions remain available.
- The composer has a 44px more-controls trigger, a separate secondary controls row and bottom safe-area padding. Its outside-click handler excludes model and auto-advance portals, so interacting with them cannot unexpectedly collapse the composer.
- The circle beside the model is the context-usage ring, not a provider glyph.

## Three model identities

Historical assistant attribution is immutable: a DeepSeek answer remains a DeepSeek answer after a later explicit GPT selection. Do not infer a current model from the last answer.

The configured primary selection and execution model are also separate. A temporary quota fallback may change execution and the context ring, never the configured primary or its independent thinking preference.

`hooks/useAgentSession.ts` now observes authoritative model metadata on:

1. Visible idle polling (15 seconds, live-wrapper reads only).
2. `visibilitychange`, `online` and `pageshow`, including while idle after SSE's grace period expires.
3. Existing-session prompt dispatch (nonblocking observation, not a forced `set_model`).
4. Assistant/context-usage refreshes, which previously read usage without applying model metadata.

Wake-up and dispatch may read a dormant session using `tail=1&deferThinking=1&deferMedia=1`. They do not create a wrapper or replace the loaded history window. Idle polling deliberately avoids repeated dormant history/tree downloads. These observation reads have a five-second timeout and preserve the last confirmed choice on failure.

A model-only watermark complements the usage watermark. Late responses cannot replace newer model-only snapshots even when usage is absent. Session identity, run identity, mount state and pending manual switches are checked; explicit model and primary/backup thinking changes invalidate reads both before dispatch and after command acknowledgement. No prompt is resent, no tools are replayed, and fallback/startup policy is unchanged.

## Validation

- Actual hook callbacks exercised by `hooks/session-model-sync.test.mjs`: live/dormant reads, response ordering, manual-switch barriers, run/session/unmount protection, timeout recovery, idle wake-up/polling, usage-read calibration and quota-primary separation.
- Real React components with mocked HTTP/navigation: 320/360/390/412/640px in zh-CN/en/zh-TW, reduced-height viewport, labelled menus, explicit session menus, focus restoration, model portals, live/dormant cross-window model changes and unchanged desktop header.
- This is not installed-desktop or physical-phone keyboard/safe-area verification; those remain manual checks.

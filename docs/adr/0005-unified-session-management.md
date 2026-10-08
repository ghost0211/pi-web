# ADR 0005: Unified session management

Status: accepted

## Problem

Browser-local hidden sessions, archived sessions, hidden projects, and Settings' hidden-only manager represented overlapping states. Restoration could succeed in one store while another still filtered the session. Project visibility controls could also delete session files without confirmation or reliable failure handling.

## Decision

Use independent Pi Web metadata at `getAgentDir()/pi-web/session-management.json`:

- Session lifecycle: `active` (displayed as Normal / 普通 / 一般) or `archived`.
- Pin: an independent attribute of normal sessions; archiving clears it.
- Project entry: visible or removed from the sidebar, independently of session lifecycle.
- Monotonic revision and migration IDs for synchronized, idempotent updates.

The SDK's `settings.json` and session JSONL contents are not rewritten to pin, archive, restore, remove a project entry, or migrate preferences. Store writes are private, validated, locked with `proper-lockfile`, and atomically replaced. Unknown fields survive updates. A corrupt store fails closed rather than resetting preferences.

`GET /api/session-management` reads state, `PATCH` applies an explicit action, and `POST` imports legacy preferences. All return `{ state }` without caching. The shared client deduplicates bootstrap, serializes mutations, rejects failed responses, and prevents stale responses from superseding newer revisions. Windows/tabs refresh through browser lifecycle signals and bounded cross-tab notifications.

## UI semantics

- There is no Hide session action or mixed "show archives in the sidebar" toggle.
- The sidebar lists normal families, with pins first. Archived/project management entries open the full manager.
- Management includes all catalog sessions and removed projects, with lifecycle/project filters, search, and bulk archive/restore.
- Opening an archived session never implicitly restores it. Its history remains observable; an explicit Restore and continue action enables composition again. Pending metadata/migration also blocks composition.
- Archiving a running session neither aborts it nor suppresses its completion notifications, live reconciliation, stop control, or extension responses. Subagent panes remain observational, including when archived.
- Removing a project entry does not archive its sessions, delete data/code, or close an open chat. Archiving all project sessions is a separate action. Restoring a session explicitly makes its project entry visible.
- Sidebar family grouping remains unchanged: subagents are represented under their main session, while management lists individual persisted/runtime catalog records for inspection and explicit operations.

## Legacy migration and backups

Read the exact original values of:

- `pi-web:hidden-sessions`
- `pi-web:hidden-projects`
- `pi-web:archived-sessions`
- `pi-web:pinned-sessions`
- `pi-web:show-archived-sessions`

First save a browser-local immutable backup under `pi-web:session-management:legacy-backup:<migration-id>`. Then the server saves `pi-web/session-management-migration-<migration-id>.json` before committing imported state. Raw malformed strings are preserved too. A failed backup/import leaves migration incomplete and the UI unready; retry reuses the saved ID and exact backup. Legacy keys are not deleted or rewritten.

Hidden and archived session IDs become archives; archive takes precedence over pin. Hidden project entries become removed project entries. Historical absolute display-path keys are normalized using the catalog's platform-specific project identity (including Windows case/separator/trailing-slash variants); opaque keys remain unchanged, and original strings remain backed up. Import only records with no server decision: explicitly restoring or unpinning retains a normal-state record, so another old browser cannot overwrite that decision. Repeated migration IDs are no-ops. The old show-archived preference is backed up, but is not a second lifecycle/filter switch.

Migration only changes metadata, not session files. Backups preserve pre-upgrade browser preferences; they are not mirrors of subsequent operations or backups of deleted conversations.

## Permanent deletion

Permanent deletion lives in management's separate danger area. Confirmation lists the selected count and titles and explains that conversation content is unrecoverable, project files are untouched, and child sessions are retained/reparented. Confirmed batches execute sequentially, check every acknowledgement, retain failures, report partial success and warnings, and keep their containing settings panel open until results settle.

The API requires `{ "confirm": true }` before destructive work. Busy targets are rejected with 409, never automatically aborted. Direct dependent discovery includes raw in-memory headers/subagent metadata before their first JSONL flush, so background children are protected even without a file. Loaded dependent wrappers are also conservatively rejected, even when idle, because rewriting their on-disk headers while their SDK session remains cached could reintroduce stale relations. They must unload/expire before retry; stopping an idle wrapper is not sufficient.

DELETE uses a hot-reload-safe queue and a filesystem lock to serialize Pi Web deletion/reparenting. A per-session barrier protects target/dependent IDs against in-process runtime startup, mutating commands, and PATCH. Startup already in progress causes a safe refusal. Dependent file replacements are atomic; later failure attempts rollback and reports rollback failures rather than swallowing them. Session metadata is cleaned only after actual deletion. If cleanup then fails, the response still truthfully reports deletion and includes warnings.

Limits: this is not a general filesystem transaction and does not coordinate an external Pi CLI, old desktop server, or arbitrary program writing the same JSONL files. In-memory/ephemeral dependents in another Node process cannot be discovered by the local registry scan. Do not mutate those files externally during deletion. This change does not introduce recursive deletion of descendants or project-directory deletion.

## Validation

Tests use isolated temporary state/session directories and simulated clients, never user conversations or credentials. Coverage includes migration backups and retries, authoritative restored decisions, corruption/prototype/size validation, parallel metadata updates, stale response handling, sequential partial deletion, archive/view semantics, guarded runtime-start/write races, loaded-dependent refusal, and barrier/rollback cleanup. Full Web test execution remains the Ubuntu CI job; Windows uses focused regressions/typecheck/lint.

Local implementation validation: 233 focused tests passed; one symlink test was skipped under Windows permissions. Typecheck and repository-wide ESLint passed. A separate Next dev server used only a temporary `PI_CODING_AGENT_DIR`: migration/project removal preserved all fixture JSONL hashes; unconfirmed DELETE returned 400, confirmed DELETE removed only the target, retained child messages, and cleaned only target metadata. No original user sessions were migrated or deleted. Native browser verification could not complete because Windows refused to foreground the managed browser and its background animation frame was suspended; UI interaction tests used deterministic component harnesses instead.

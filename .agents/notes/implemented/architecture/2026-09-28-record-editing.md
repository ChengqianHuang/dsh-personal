# Agent Note: Exact-id edits with content revisions

Status: implemented

## Problem

Capture and retrieval alone cannot correct mistaken facts, remove duplicates on request, or reassign project links. Name-based mutation can select the wrong row when several records share a title. A read followed by an unconditional write can overwrite a newer update from another connection.

## Decision

Three tools read, update, and delete any of the eight record kinds. Capture and query renderers expose ids. Selection comes from conversation or query results; tool descriptions require clarification when multiple candidates fit, rather than treating relevance rank as identity. The read tool returns the complete camelCase row plus a SHA-256 revision derived from object kind and all durable fields. All model-facing updates, including task and blog convenience tools, require that revision.

The service checks the revision inside BEGIN IMMEDIATE before applying a partial patch or deleting. The parser owns per-kind editable field allowlists, null-clearing rules, date/rating/tag validation, and exact foreign-key reference checks. Record ids, creation times, and managed timestamps are immutable through the tools. Task completion dates persist while DONE and clear when reopened. Relative task deadlines use the same captured date as the completion timestamp.

Deletion blocks incoming foreign keys and exact task source references; it reports those records without cascading. Explicit relations to or from the target are removed with the target in one transaction. Updating, moving, or deleting project logs touches the affected projects. Existing TEMP search triggers participate in the transaction, so rejected edits and storage failures cannot leave partial records, relation cleanup, or index state.

## Alternatives considered

Per-kind update and delete tools multiply model choices for the same operation. A generic SQL or arbitrary-column editor bypasses domain rules. The selected generic tools keep object types and field sets closed while experience category/action remain open.

A durable revision counter or audit table requires a format change and coordination with external writers. Content fingerprints cover every existing field without schema changes, including writes made by SQLite clients. They do not detect a history in which identical content is restored; that is an accepted limitation of checking current contents rather than edit history.

Soft deletion or undo would require durable lifecycle rules for every query, review, reference, and search projection. The current operation is explicit permanent deletion, with no implicit duplicate cleanup and no undo promise.

## Consequences

v4 databases remain usable. The model spends one read call to obtain and inspect a revision before mutating. Reference reassignment is explicit and dangling project/website references fail. Source labels remain free-form; only exact canonical kind/id pairs can be recognized as incoming source references. Task and blog convenience Service methods delegate to the guarded method and require revisions too.

Real SQLite tests cover eight-kind editing, null versus omission, invalid fields, uniqueness rollback, stale revisions across connections, reference blocking and reassignment, relation rollback, search refresh, and cold reopening. Registered-tool snapshots pin complete rows and revisions. A keyless assembled Agent Loop transcript snapshot checks logged results and the identical facts supplied to the next model request. Real-provider turns exercise ambiguous target clarification, one of two matching experiences, task completion, idea reassignment, deletion, and cold-start verification.

The [derived-search-index note](2026-09-28-derived-search-index.md) remains active: it independently owns tokenization, relevance ranking and index synchronization. This note does not supersede that decision.

# pi-warm-prefix-compaction

A global Pi extension providing one shared deterministic context-management path for terminal Pi and host applications such as Peach, while preserving cache-friendly hard compaction.

## Context pipeline

`bounded tool production -> authoritative Pi JSONL -> deterministic provider projection -> discrete stale folds -> exact transcript recovery -> warm-prefix hard compaction`

The extension never creates a second transcript or raw-output store. Normal Pi session JSONL remains authoritative. Provider-only projections use literal deterministic head/tail previews, line and character guards, encoded-payload elision, a protected recent tail, and explicit fold epochs. `context_recover` retrieves exact targeted text from the original Pi session entry, including after resume.

Unbounded `read` calls receive a conservative default window. Explicit offsets and limits remain unrestricted. Errors receive a larger diagnostic preview budget. `/context-bypass-next` provides one observable first-visibility escape hatch, and `/context-status` exposes current policy and savings.

Stale folding is committed only at discrete pressure-triggered events and persisted as non-context custom session entries. Historical provider bytes remain stable between those events. Cache rewrite cost is reported as unknown when the provider does not expose it.

## Warm-prefix compaction

Hard compaction still extends the latest settled provider request with exactly one appended compaction instruction via `ctx.completeFromLatestSettledRequest()`. It does not replace Pi JSONL authority or use a separate summarization pipeline.

## Install

```sh
pi install git:github.com/pechhe/pi-warm-prefix-compaction@v0.2.0
```

This package is intentionally retaining its existing repository/install identity for migration compatibility while its scope expands beyond hard compaction.

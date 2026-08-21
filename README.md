# pi-warm-prefix-compaction

A global [pi](https://github.com/earendil-works/pi) extension that generates compaction summaries by extending the latest successful provider request with one appended instruction.

This preserves the warm provider prefix: model, system prompt, tools, conversation history, request options, and cache/session identity remain unchanged. The summary is then persisted through pi's normal append-only compaction entry.

## Requirement

This extension requires the `ctx.completeFromLatestSettledRequest()` API from [`pechhe/pi`](https://github.com/pechhe/pi), branch `warm-prefix-v0.84.2`, commit `e9aed82b3` or later.

It fails closed rather than allowing pi's standalone cold compaction request when the previous request cannot be reused safely.

## Install

Install the compatible pi fork, then install this package globally:

```sh
pi install git:github.com/pechhe/pi-warm-prefix-compaction@v0.1.0
```

The extension applies to terminal pi and applications such as Peach that load the same `~/.pi/agent` resources.

## Behaviour

- Uses pi's normal manual, threshold, and overflow compaction lifecycle.
- Appends exactly one user instruction to the settled provider context.
- Calls the provider directly outside the agent loop, so tools cannot execute.
- Preserves custom `/compact` instructions.
- Records summary usage and file-operation metadata in the compaction entry.
- Cancels compaction if model, thinking level, cache identity, system prompt, tools, or conversation prefix changed.

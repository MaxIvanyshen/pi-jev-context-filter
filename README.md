# pi-jev-context-filter

A [pi](https://pi.dev) extension that filters noisy `bash`/`grep`/`read` output through
[TypeSafe's Jev](https://docs.typesafe.ai) before it lands in context.

Large tool output (over ~80 lines or 4000 chars) is sent to Jev as a `choice` question:
how visible should this chunk be — `hide`, `short`, `long`, or `full` — given the task
goal, recent conversation, and which tool/command produced it. `short` and `long` keep
the first and last lines (10+5 or 40+20) with no extra model call, `full` passes through
untouched, and `hide` drops it.

The unfiltered original is always stashed to a temp file and recoverable via the
`expand_chunk` tool, so nothing is ever permanently lost — just deprioritized.

## Install

```bash
pi install git:github.com/MaxIvanyhen/pi-jev-context-filter
```

Or locally:

```bash
ln -s $(pwd)/extensions/context-filter.ts ~/.pi/agent/extensions/context-filter.ts
```

## Debug logging

Set `JEV_DEBUG=1` to log every visibility decision (`hide`/`short`/`long`/`full`) and every
`expand_chunk` call as JSONL to `~/.jev-context-filter-debug.jsonl` (override the path with
`JEV_DEBUG_LOG`). Off by default — no disk writes, no overhead.

Join the two event types on `chunkId` to measure jev's accuracy: a `hide` or `short` chunk
that later gets `expand`ed is a signal the model needed context jev filtered out, versus the
model just double-checking a `long`/`full` chunk out of habit.

```bash
jq -s '
  group_by(.chunkId) |
  map(select(length > 1 and (.[0].event == "decision"))) |
  group_by(.[0].visibility) |
  map({visibility: .[0][0].visibility, expanded: length})
' ~/.jev-context-filter-debug.jsonl
```

## Requirements

- `TYPESAFE_API_KEY` env var — get one at [console.typesafe.ai/keys](https://console.typesafe.ai/keys).
  Without it, large output always gets the `long` excerpt (no Jev call).

## Why

See [pi.dev](https://pi.dev) on extensions and [TypeSafe's Jev](https://docs.typesafe.ai)
docs. The idea follows the "visibility ladder" proposed in *Jev Engineering for Coding
Agents* (2026): context should be assembled per query, not accumulated blindly.

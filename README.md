# pi-jev-context-filter

A [pi](https://pi.dev) extension that filters noisy `bash`/`grep`/`read` output through
[TypeSafe's Jev](https://docs.typesafe.ai) before it lands in context.

Large tool output (over ~80 lines or 4000 chars) is sent to Jev as a `choice` question:
how visible should this chunk be — `hide`, `short`, `long`, or `full` — given the task
goal, recent conversation, and which tool/command produced it. Jev decides; a cheap
model (Haiku) only spends tokens writing the actual summary when Jev says `short` or
`long`. `full` passes through untouched, `hide` costs nothing beyond the Jev call.

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
  Without it, the extension falls back to always summarizing large output via Haiku
  (no hide/full shortcuts, no Jev call).
- Anthropic credentials configured in pi (used for the Haiku summarization pass).

## Why

See [pi.dev](https://pi.dev) on extensions and [TypeSafe's Jev](https://docs.typesafe.ai)
docs. The idea follows the "visibility ladder" proposed in *Jev Engineering for Coding
Agents* (2026): context should be assembled per query, not accumulated blindly.

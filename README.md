# opencode-image-context

Persistent vision context for OpenCode (V1 + V2): stop `read` image attachments
from re-accumulating as base64 in the main session, while keeping visual context
queryable through a persistent child "vision" session.

## Problem

OpenCode replays the whole conversation to the provider on every turn. When an
agent `read`s images, each result is embedded as a `data:image/...;base64,`
attachment and replayed forever — so request bodies grow without bound and can
trip provider gateways (e.g. Tencent TokenHub `413001 CodeRequestBodyTooLarge`).

## Design

Two layers:

- **Main session** — images that `read` produces are stripped from the main
  request and routed to a persistent **vision child session**. The main session
  only ever receives a short textual observation, plus a `vision.ask` interface
  to follow up.
- **Vision child** — keeps its own visual context so it can compare/answer about
  earlier images, bounded by a byte-budget with **hysteretic batch eviction**
  (evict oldest ~2/3 when the high watermark is crossed, keeping the newest ~1/3).

```
Main Session ── read image ─▶ Vision Child (persistent)
      ▲                              │
      └──── textual observation ─────┘
```

Isolation is enforced by session role: main requests get their image attachments
removed; vision requests keep theirs (and are only subject to retention).

This plugin **never** registers a compaction hook, and never touches OpenCode
core, `opencode-acp`, or Headroom.

## Layout

```
src/
  core/      pure, adapter-free domain logic (types, config, retention, ...)
  ports.ts   interfaces adapters implement
  v1/        OpenCode V1 adapter
  v2/        OpenCode V2 adapter
test/        unit / integration tests
```

## Status

| Milestone | State |
| --- | --- |
| 1. scaffold + core interfaces | done |
| 2. V1 image interception | pending |
| ... | |

See `docs/init.md` for the full specification.

## Develop

```bash
bun install
bun test          # unit tests
bunx tsc --noEmit # typecheck
bun run build     # emit dist/v1.js and dist/v2.js
```

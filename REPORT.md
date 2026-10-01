# Final report — opencode-image-context

## Architecture

Two-layer vision context:

1. **Main session — textual.** On `read`, the adapter captures image attachments,
   the core validates/hashes/persists them and routes them to a persistent vision
   child, and the adapter removes the raw image from the main session. The main
   session keeps only a textual placeholder/observation.
2. **Vision child — persistent session.** A real OpenCode session linked 1:1 to a
   main session. It receives each image once, analyzes it, returns text, and
   keeps its own visual history for follow-ups/comparisons. V1 exposes a
   `vision_ask` tool so the main session can query it (V2 degrades gracefully
   when `tool.register` is unavailable).
3. **Retention (child only).** Byte-budget hysteretic batch eviction: no
   eviction under `highWatermarkBytes`; above it, drop the oldest images in one
   batch down to `lowWatermarkBytes` (capped at `evictionRatio`, always keeping
   `keepRecentImages`). Avoids per-turn history rewrites that would break prefix
   caching.

The core (`src/core/*`, `src/ports.ts`) has no V1/V2 dependency. Adapters:
`src/v1/*` (hooks `tool.execute.after` + `experimental.chat.messages.transform`)
and `src/v2/*` (hooks `ctx.tool.hook("execute.after")` +
`ctx.session.hook("context")`). No compaction hook is registered in either.

## Files

See `README.md` for the full layout. Core: types/config/image/hash/logger/
retention/registry/imageStore/memoryStore/transform/manager/runtime. Ports and
adapters as above.

## Configuration

`enabled`, `model`, `dataDir`, `maxImageBytes` (100 MiB), `highWatermarkBytes`
(64 MiB), `lowWatermarkBytes` (32 MiB), `evictionRatio` (0.66),
`keepRecentImages` (20), `analysisQuestion`, `debug`, `logFile`; env overrides
`OCIMAGE_*`. See `README.md` for the table.

## How to install

- V1: `~/.config/opencode/plugins/opencode-image-context.ts` re-exporting
  `dist/v1.js`.
- V2: `~/.config/opencode/plugin/opencode-image-context.js` (`dist/v2.js`).

Restart OpenCode afterwards.

## How to run

`bun run build`, then `bun test`; real end-to-end: `RUN_V1_E2E=1 bun test
test/integration` (V1 `opencode`) and `RUN_V2_E2E=1 bun test
test/integration/v2-e2e.test.ts` (V2 `opencode2`).

## V1 test result

**PASSED (real `opencode` 1.18.32).** `RUN_V1_E2E=1 bun test
test/integration/v1-e2e.test.ts` → 43.5 s. The first attempt in a session can
fail if the model uses `shell`/does not call `read`; the harness asserts the
tool call, and re-running passed. Evidence from a controlled run:

- plugin log: `ingested image sha256:ee32dc7a8b88 mime=image/png bytes=64482`,
  `stripped 1 attachment(s) from main session`, `created vision session=…`.
- transform, per-session wire bytes (instrumented):
  - main turn 1: `610 B`, 0 images;
  - **main turn 2: `4,908 B`, 0 images** (image removed, observation text added);
  - **vision child: `86,822 B`, 1 image**.
- final assistant answer `Yellow` (correct) — proves the child's observation
  reached the main session.

## V2 test result

**PASSED (real `opencode2` 2.0.21).** `RUN_V2_E2E=1 bun test
test/integration/v2-e2e.test.ts` → 35.2 s (drives the V2 host over SSH). Asserts
`v2 adapter active`, `created vision session=`, `stripped N image part`,
`imagesInContext=0`, `vision session retained image=`, a registry link, on-disk
image + memory, and no `data:image` in logs. Final answer `Red (#FF0000)`.

## ACP test result

**PARTIAL — startup smoke test only.** `opencode acp --port 4099` bootstrapped
with the vision plugin loaded, initialised LSP/config and reached
“setup connection” with **no plugin-load or hook errors**. A full ACP client
round-trip was **NOT TESTED** (no ACP client available). By design the plugin
registers no compaction hook, so it does not contend with `opencode-acp` for
main-session compaction.

## Headroom test result

**PASSED — Headroom was not modified.** All model traffic went through the
existing Headroom instance (`127.0.0.1:8788`, provider `headroom-tencent-fork`).

- With the plugin, one image turn produced two requests: main `content_length`
  **2,616 B** / outbound **12,401 B**, and the vision child
  **97,692 B** / **105,788 B** (the only request carrying the image).
- Without the plugin (same prompt), the main session’s requests were
  **2,616 B → 97,273 B → 184,474 B** as the image was replayed and accumulated.
- So the main request that would otherwise carry ~86 KB of base64 dropped to
  ~4.9 KB of text; the image appears exactly once, on the child.

## Cache observations

From Headroom `PERF` lines (`cache_read` / `cache_write` / `cache_hit_pct`):

- Vision child, first image request (cold): `cache_read=1664`,
  `cache_write=24403`, hit **6%**.
- Vision child, later request: `cache_read=26112`, `cache_write=653`, hit **98%**
  — the child reuses its own visual context.
- Main session (small request): `cache_read=2816`, `cache_write=166`, hit **94%**;
  because images are stripped once at ingest and the main history then stays
  stable, the main prefix cache is not repeatedly invalidated. Child eviction is
  batched (hysteretic), so divergence points move rarely.

## Known limitations

- `vision_ask` requires a runtime with `tool.register` (present in V1; absent in
  the tested V2 build, where the adapter degrades gracefully).
- The vision child model must accept image input.
- V1 stripping depends on mutating live message objects; an array-replacing
  runtime would need another adapter.
- V1 e2e is model-dependent (the agent must actually call `read`).
- ACP was smoke-tested only.

## Git commits (milestone order, not squashed)

```
d500965 feat: scaffold and core interfaces
67699fd feat(v1): intercept read image attachments
f41135a feat: persistent vision child session
a9c3cdf feat: strip historical main images + vision_ask tool
45f5574 feat: vision-child image retention via watermark eviction
b35e8e7 feat: textual vision memory + image dedup
6162a24 feat: vision child failure recovery
95271be test: real V1 end-to-end integration test
abd2480 feat(v2): native V2 adapter (execute.after + session context hook)
935f405 test(v2): real V2 end-to-end test
```

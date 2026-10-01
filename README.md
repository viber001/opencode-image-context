# opencode-image-context

Persistent vision context for OpenCode. Keeps large image attachments out of the
main session's request while still letting the agent reason over them.

## Problem

When an agent uses the `read` tool on images, OpenCode embeds the image as a
`data:image/...;base64,...` attachment in the session. Every subsequent model
request replays the whole conversation, so the base64 payload is re-sent and
accumulates: one 64 KB PNG becomes ~86 KB of base64 on every later turn, and a
few dozen images push the request body past the provider gateway limit
(e.g. Tencent TokenHub `413001 CodeRequestBodyTooLarge`).

## Design — two layers of vision context

- **Main session** stays textual. On `read`, image attachments are ingested
  (validated, hashed, written to disk) and removed from the main session; only a
  short textual placeholder/observation may remain.
- **Vision child** is a real, persistent OpenCode session linked to the main one.
  Images are routed there once; the child analyzes them and returns text. The
  child keeps its own visual context so it can answer follow-up and compare
  earlier images. The main session can ask it more questions (V1 `vision_ask`).
- **Retention on the child** uses a byte budget with hysteretic batch eviction:
  nothing is removed until `highWatermarkBytes` is exceeded, then the oldest
  images are dropped in one batch down to `lowWatermarkBytes` (keeping the
  newest `keepRecentImages`). Evicted images become a textual omission note, or
  a 1×1 PNG placeholder where an image part is structurally required.

The core is transport- and runtime-agnostic; V1/V2 only provide adapters.

## Files

```
src/ports.ts            VisionTransport port (createChild/sendImage/ask/isAlive)
src/core/types.ts       config + domain types, MINIMAL_PNG_DATA_URL, DEFAULT_CONFIG
src/core/config.ts      options resolution (flat or {vision:{...}})
src/core/image.ts       data-URL parsing/validation
src/core/hash.ts        sha256 helpers
src/core/logger.ts      base64-masking logger
src/core/retention.ts   planRetention() — pure hysteretic eviction planner
src/core/registry.ts    main<->vision session registry (registry.json)
src/core/imageStore.ts  images/<sha256>.<ext>
src/core/memoryStore.ts vision-memory/<mainId>.{json,md} (textual only)
src/core/transform.ts   wire-format image stripping / collection / eviction
src/core/manager.ts     ingest / route / ask / dedup / child recovery
src/core/runtime.ts     builds {cfg,logger,registry,images,memory,manager}
src/v1/transport.ts     V1 client -> VisionTransport
src/v1/plugin.ts        V1 adapter (tool.execute.after + messages.transform)
src/v2/transport.ts     V2 ctx.session -> VisionTransport
src/v2/plugin.ts        V2 adapter (tool.hook + session.hook)
src/v2/transform.ts     V2 message/part transform helpers
src/index.ts            single dual-compatible entry (default { id, server, setup })
src/v1.ts / src/v2.ts   per-runtime bundle entry points (subpath exports)
```

## Configuration

Options may be passed flat or under `vision`; env vars override.

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Enable the plugin |
| `model` | (main model) | Provider/model id for the vision child |
| `dataDir` | `~/.local/share/opencode/opencode-image-context` | State/registry/images/memory |
| `maxImageBytes` | `104857600` | Reject attachments larger than this |
| `highWatermarkBytes` | `67108864` | Child image budget before eviction |
| `lowWatermarkBytes` | `33554432` | Evict down to this |
| `evictionRatio` | `0.66` | At most this fraction removed per batch |
| `keepRecentImages` | `20` | Always keep the newest N |
| `analysisQuestion` | (built-in) | Question sent to the child on ingest |
| `debug` | `false` | Verbose (base64-masked) logs |
| `logFile` | — | Append logs to a file |

Env overrides: `OCIMAGE_ENABLED`, `OCIMAGE_MODEL`, `OCIMAGE_DATA_DIR`,
`OCIMAGE_MAX`, `OCIMAGE_HIGH`, `OCIMAGE_LOW`, `OCIMAGE_KEEP`, `OCIMAGE_DEBUG`,
`OCIMAGE_LOG`, `OCIMAGE_ANALYSIS_QUESTION`.

The plugin never registers a compaction hook (main-session compaction is owned
by `opencode-acp`) and never modifies Headroom.

## Install

```sh
bun install
./install.sh            # writes one self-contained file into the config dir
```

OpenCode 1 and OpenCode 2 both discover local plugins from `<config>/plugin/`
**and** `<config>/plugins/`, and neither location nor the config contents reveal
which version is installed (the config dir is shared; the credential table and
`migration.v1-v2` marker exist on both). So instead of guessing the runtime,
this package ships **one** bundle whose default export carries both entry
shapes:

```ts
export default {
  id: "opencode-image-context",
  server: VisionPluginV1, // read by the OpenCode 1 loader
  setup: VisionPluginV2,  // read by the OpenCode 2 loader
};
```

The V1 loader reads `default.server` and ignores `setup`; the V2 loader decodes
`default` as `{ id, setup }` and ignores `server`. (On a V1 host the embedded
V2 core also calls `setup` in a registration-only pass — `VisionPluginV2`
detects the missing `tool`/`session` domains and no-ops.)

`install.sh` copies the self-contained bundle (`dist/index.js`, zod and
`@opencode-ai/plugin` inlined) to:

| Writes |
| --- |
| `<config>/plugins/opencode-image-context.js` (one file, both runtimes) |

Detected binaries are reported for information only; version detection no
longer selects the target. Options: `--config DIR`, `--source DIR`, `--build`,
`--check`, `--uninstall`, `--no-exec`, `--dry-run`, `--help`. `--v1`/`--v2`/
`--all` are accepted for backwards compatibility but all install the same file.
Build is skipped when `dist/index.js` already exists; `--build` forces it.

Equivalent `make` targets: `make install`, `make build`, `make test`,
`make typecheck`, `make uninstall` (`make install-v1`/`install-v2` alias
`install`).

Manual install (if you prefer):

```sh
bun run build        # emits dist/index.js (+ dist/v1.js, dist/v2.js)
mkdir -p ~/.config/opencode/plugins
cp dist/index.js ~/.config/opencode/plugins/opencode-image-context.js
```

Restart OpenCode after installing.

## Tests

```sh
bun test                 # unit tests
bun run typecheck
RUN_V1_E2E=1 bun test test/integration          # real opencode (V1)
RUN_V2_E2E=1 bun test test/integration/v2-e2e.test.ts   # real opencode2 (V2)
```

The V2 e2e defaults to driving a remote V2 host over SSH
(`E2E_V2_SSH=xshu@localhost`); set `E2E_V2_SSH=""` to run `opencode2` locally.

## Known limitations

- `vision_ask` is registered only when the runtime exposes `tool.register`
  (V1; V2 builds without it degrade gracefully — the main session still receives
  the child's observation text).
- The child model must support image input.
- V1 stripping relies on mutating the live message objects; a runtime that
  replaces the messages array instead of mutating in place would need a new
  adapter. See `agents/` notes in the parent config repo.

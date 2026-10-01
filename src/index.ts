import { VisionPluginV1 } from "./v1/plugin.js";
import { VisionPluginV2 } from "./v2/plugin.js";

/**
 * Single dual-compatible plugin entrypoint.
 *
 * OpenCode 1 and OpenCode 2 discover local plugins from the same directories
 * (`plugin/` and `plugins/`) and cannot be told apart by location, so the
 * package ships one module that satisfies both loaders:
 * - the V1 loader reads `default.server` (a `PluginInput => Promise<Hooks>`
 *   function) and ignores `default.setup`;
 * - the V2 loader decodes `default` as `{ id, setup }` and ignores `server`.
 *
 * On a V1 host the embedded V2 core also calls `setup` in a registration-only
 * pass; `VisionPluginV2` detects the missing tool/session domains and no-ops.
 */
export default {
  id: "opencode-image-context",
  server: VisionPluginV1,
  setup: VisionPluginV2,
};

export { VisionPluginV1, VisionPluginV2 };

import { appendFileSync } from "node:fs";
import mod from "../../dist/v1.js";

try {
  appendFileSync(process.env.OCIMAGE_LOG ?? "/tmp/vic-load.log", "[e2e] plugin module imported\n");
} catch {
  /* ignore */
}

/**
 * Integration wrapper for the real V1 runtime. Configured through environment
 * variables so the harness can point it at a throwaway dataDir and shrink the
 * watermarks:
 *
 *   OCIMAGE_DATA_DIR     where registry/images/memory are written (required)
 *   OCIMAGE_LOG          append debug log lines here (recommended)
 *   OCIMAGE_DEBUG        "0" disables debug logging (enabled by default)
 *   OCIMAGE_HIGH/LOW/KEEP  watermark overrides
 *   OCIMAGE_MODEL        JSON {providerID,modelID} applied to the vision child
 *
 * Build first: `bun run build`.
 */
export const server = async (input) =>
  mod.server(input, {
    enabled: true,
    debug: process.env.OCIMAGE_DEBUG !== "0",
    dataDir: process.env.OCIMAGE_DATA_DIR,
    logFile: process.env.OCIMAGE_LOG,
    highWatermarkBytes: Number(process.env.OCIMAGE_HIGH ?? 67108864),
    lowWatermarkBytes: Number(process.env.OCIMAGE_LOW ?? 33554432),
    keepRecentImages: Number(process.env.OCIMAGE_KEEP ?? 20),
    model: process.env.OCIMAGE_MODEL ? JSON.parse(process.env.OCIMAGE_MODEL) : undefined,
  });

export default { id: "opencode-image-context-e2e", server };

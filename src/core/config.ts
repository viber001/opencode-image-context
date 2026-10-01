import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type VisionConfig } from "./types.js";

export function defaultDataDir(): string {
  return join(homedir(), ".local", "share", "opencode", "opencode-image-context");
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Merge user-provided plugin options onto the defaults. Accepts either a flat
 * object or a `{ vision: {...} }` wrapper so both V1 and V2 calling conventions
 * work. Unknown/negative numeric values fall back to the default.
 */
export function resolveConfig(raw: unknown): VisionConfig {
  const source: Record<string, unknown> =
    raw && typeof raw === "object"
      ? ((raw as Record<string, unknown>).vision as Record<string, unknown>) ??
        (raw as Record<string, unknown>)
      : {};
  const base = DEFAULT_CONFIG;
  const high = num(source.highWatermarkBytes, base.highWatermarkBytes);
  let low = num(source.lowWatermarkBytes, base.lowWatermarkBytes);
  // A low watermark at or above the high watermark would defeat hysteresis.
  if (low >= high) low = Math.floor(high / 2);
  return {
    enabled: source.enabled === undefined ? base.enabled : Boolean(source.enabled),
    model: typeof source.model === "string" && source.model ? source.model : undefined,
    dataDir: typeof source.dataDir === "string" && source.dataDir ? source.dataDir : defaultDataDir(),
    maxImageBytes: num(source.maxImageBytes, base.maxImageBytes),
    highWatermarkBytes: high,
    lowWatermarkBytes: low,
    evictionRatio: Math.min(1, num(source.evictionRatio, base.evictionRatio)),
    keepRecentImages: Math.floor(num(source.keepRecentImages, base.keepRecentImages)),
    analysisQuestion:
      typeof source.analysisQuestion === "string" && source.analysisQuestion
        ? source.analysisQuestion
        : base.analysisQuestion,
    debug: Boolean(source.debug),
    logFile:
      typeof source.logFile === "string" && source.logFile ? source.logFile : undefined,
  };
}

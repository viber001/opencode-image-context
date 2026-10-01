/**
 * Core domain types for the persistent vision-context plugin.
 *
 * Nothing in `src/core` may import from `src/v1` or `src/v2`; adapters depend
 * on core, never the other way around.
 */

export type SessionRole = "main" | "vision";

/** A read-tool attachment as surfaced by OpenCode V1's `tool.execute.after`. */
export interface Attachment {
  type: "file";
  mime: string;
  /** A `data:<mime>;base64,...` URL. */
  url: string;
  filename?: string;
}

/** Parsed view of a data URL image. */
export interface ParsedImage {
  mime: string;
  /** Raw base64 (no `data:` prefix). */
  base64: string;
  /** Decoded byte length. */
  bytes: number;
  dataUrl: string;
}

/** Book-keeping for one image seen by a main session. */
export interface ImageRecord {
  sha256: string;
  mime: string;
  bytes: number;
  filename?: string;
  firstSeen: number;
  lastSeen: number;
  mainSessionID: string;
  visionSessionID: string;
  /** Latest textual observation produced by the vision child, if any. */
  analysis?: string;
}

/** mainSession -> visionSession association. */
export interface VisionLink {
  mainSessionID: string;
  visionSessionID: string;
  createdAt: number;
  /** Bumped whenever the vision child is replaced after a failure. */
  generation: number;
}

/** Persisted registry of links and known vision sessions. */
export interface RegistryFile {
  version: 1;
  links: Record<string, VisionLink>;
  /** All vision session ids ever created (used to classify requests). */
  visionSessions: Record<string, { mainSessionID: string; createdAt: number; generation: number }>;
}

export interface VisionConfig {
  enabled: boolean;
  /** Optional independent model for the vision child (`provider/model` form). */
  model?: string;
  /** Root directory for images/ registry/ memory/. */
  dataDir: string;
  /** Hard cap for a single accepted image (bytes). Larger images are rejected. */
  maxImageBytes: number;
  /** Above this, the vision child evicts a batch of its oldest images. */
  highWatermarkBytes: number;
  /** Batch eviction drains the vision child down to (at most) this. */
  lowWatermarkBytes: number;
  /** Upper bound on the fraction of images evicted in a single batch. */
  evictionRatio: number;
  /** Never evict the newest N images. */
  keepRecentImages: number;
  /** Default analysis question sent to the vision child. */
  analysisQuestion: string;
  /** Enable debug logging. */
  debug: boolean;
  /** Append log lines to this file instead of stderr (used by integration tests). */
  logFile?: string;
}

export const DEFAULT_CONFIG: VisionConfig = {
  enabled: true,
  dataDir: "",
  maxImageBytes: 104_857_600,
  highWatermarkBytes: 67_108_864,
  lowWatermarkBytes: 33_554_432,
  evictionRatio: 0.66,
  keepRecentImages: 20,
  analysisQuestion:
    "Describe this image concisely but completely: contents, layout, any text/OCR, " +
    "geometry/coordinates, colors, and anything a coding task would need later. " +
    "Reply with plain text only.",
  debug: false,
};

/** A 1x1 transparent PNG, used when an image part must stay schema-valid. */
export const MINIMAL_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

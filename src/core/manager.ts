import { isImageAttachment, parseImageDataUrl } from "./image.js";
import { sha256Base64, shortHash } from "./hash.js";
import type { Logger } from "./logger.js";
import type { ImageStore } from "./imageStore.js";
import type { MemoryStore } from "./memoryStore.js";
import type { Registry } from "./registry.js";
import type { VisionTransport } from "../ports.js";
import type { Attachment, ImageRecord, ParsedImage, SessionRole, VisionConfig } from "./types.js";

export interface IngestedImage {
  attachment: Attachment;
  parsed: ParsedImage;
  sha256: string;
  storedPath: string | null;
  record: ImageRecord;
}

export interface SkippedImage {
  mime: string;
  bytes: number;
  reason: "too-large" | "unparseable";
}

export interface IngestResult {
  images: IngestedImage[];
  skipped: SkippedImage[];
  /** Text that replaces the raw attachment in the main session. */
  placeholder: string;
}

export interface ManagerDeps {
  cfg: VisionConfig;
  registry: Registry;
  images: ImageStore;
  logger: Logger;
  memory?: MemoryStore;
  transport?: VisionTransport;
  now?: () => number;
}

export interface Observation {
  sha256: string;
  mime: string;
  bytes: number;
  text: string;
}

export interface RouteResult {
  visionSessionID: string | null;
  observations: Observation[];
  /** Text that should appear in the main session in place of the images. */
  text: string;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export function formatObservations(observations: Observation[], visionSessionID: string | null): string {
  if (observations.length === 0) return "";
  const lines = [
    `[vision] analysis of ${observations.length} image(s) from persistent vision session ${visionSessionID ?? "?"}:`,
  ];
  for (const o of observations) {
    lines.push(`- sha256:${shortHash(o.sha256)} (${o.mime} ${humanBytes(o.bytes)}): ${o.text}`);
  }
  lines.push("Use the vision.ask tool to ask further questions about these or earlier images.");
  return lines.join("\n");
}

export function buildSkippedNote(skipped: SkippedImage[]): string {
  return skipped.map((s) => `[vision] skipped ${s.mime} (${humanBytes(s.bytes)}): ${s.reason}`).join("\n");
}

export function buildPlaceholder(images: IngestedImage[], skipped: SkippedImage[]): string {
  const lines: string[] = [];
  if (images.length > 0) {
    lines.push(
      `[vision] ${images.length} image(s) routed to the persistent vision session (kept out of this session's context):`,
    );
    for (const img of images) {
      lines.push(`  - ${img.parsed.mime} sha256:${shortHash(img.sha256)} ${humanBytes(img.parsed.bytes)}`);
    }
    lines.push("Use the vision.ask tool to query the vision session about these images.");
  }
  const note = buildSkippedNote(skipped);
  if (note) lines.push(note);
  return lines.join("\n");
}

/**
 * Core entry point for the main-session path. `ingest` validates, hashes and
 * persists read image attachments, and returns the placeholder text that should
 * take their place in the main session. Adapters perform the actual mutation.
 */
export class VisionManager {
  private readonly deps: ManagerDeps;
  private readonly now: () => number;

  constructor(deps: ManagerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Attach (or replace) the adapter transport after construction. */
  setTransport(transport: VisionTransport): void {
    this.deps.transport = transport;
  }

  ingest(mainSessionID: string, attachments: readonly unknown[]): IngestResult {
    const { cfg, images, logger } = this.deps;
    const ingested: IngestedImage[] = [];
    const skipped: SkippedImage[] = [];
    const seen = new Set<string>();
    const now = this.now();

    for (const att of attachments) {
      if (!isImageAttachment(att)) continue;
      const parsed = parseImageDataUrl(att.url);
      if (!parsed) {
        skipped.push({ mime: att.mime || "?", bytes: 0, reason: "unparseable" });
        continue;
      }
      if (parsed.bytes > cfg.maxImageBytes) {
        logger.warn(
          `skipped image ${parsed.mime} ${humanBytes(parsed.bytes)} > maxImageBytes ${humanBytes(cfg.maxImageBytes)}`,
        );
        skipped.push({ mime: parsed.mime, bytes: parsed.bytes, reason: "too-large" });
        continue;
      }
      const sha256 = sha256Base64(parsed.base64);
      if (seen.has(sha256)) continue;
      seen.add(sha256);
      const storedPath = images.save(sha256, att);
      const record: ImageRecord = {
        sha256,
        mime: parsed.mime,
        bytes: parsed.bytes,
        filename: att.filename,
        firstSeen: now,
        lastSeen: now,
        mainSessionID,
        visionSessionID: "",
      };
      ingested.push({ attachment: att, parsed, sha256, storedPath, record });
      this.deps.memory?.upsertImage(mainSessionID, {
        sha256,
        mime: parsed.mime,
        bytes: parsed.bytes,
        filename: att.filename,
        storedPath: storedPath ?? undefined,
        visionSessionID: record.visionSessionID || undefined,
      });
      logger.debug(
        `ingested image sha256:${shortHash(sha256)} mime=${parsed.mime} bytes=${parsed.bytes} main=${mainSessionID}`,
      );
    }

    return { images: ingested, skipped, placeholder: buildPlaceholder(ingested, skipped) };
  }

  /** Classify a request by session id through the persistent registry. */
  classify(sessionID: string): SessionRole {
    return this.deps.registry.isVisionSession(sessionID) ? "vision" : "main";
  }

  /**
   * Return the persistent vision child for a main session, creating it on first
   * use. A stored child that the transport reports as dead is replaced.
   */
  async ensureVisionChild(mainSessionID: string): Promise<string> {
    const { transport, registry, logger, cfg } = this.deps;
    if (!transport) throw new Error("vision transport not configured");
    const link = registry.getLink(mainSessionID);
    if (link) {
      const alive = await transport.isAlive(link.visionSessionID).catch(() => false);
      if (alive) return link.visionSessionID;
      logger.warn(
        `vision session=${link.visionSessionID} failed; creating replacement for main=${mainSessionID}`,
      );
      if (cfg.model && transport.setChildModel) {
        // model is applied at prompt time; nothing to do here
      }
    }
    const child = await transport.createChild(mainSessionID, `vision for ${mainSessionID.slice(0, 12)}`);
    if (cfg.model && transport.setChildModel) {
      await transport.setChildModel(child, cfg.model).catch(() => undefined);
    }
    if (link) registry.replaceVision(mainSessionID, child, this.now());
    else registry.setLink({ mainSessionID, visionSessionID: child, createdAt: this.now(), generation: 0 });
    logger.info(`created vision session=${child} for main=${mainSessionID}`);
    return child;
  }

  /** Route ingested images to the vision child and return its textual analysis. */
  async routeImages(mainSessionID: string, images: IngestedImage[]): Promise<RouteResult> {
    const { transport, logger, cfg } = this.deps;
    if (images.length === 0) return { visionSessionID: null, observations: [], text: "" };
    if (!transport) {
      return { visionSessionID: null, observations: [], text: buildPlaceholder(images, []) };
    }
    let child: string;
    try {
      child = await this.ensureVisionChild(mainSessionID);
    } catch (err) {
      logger.error(`failed to obtain vision child for main=${mainSessionID}: ${String((err as Error)?.message ?? err)}`);
      return { visionSessionID: null, observations: [], text: buildPlaceholder(images, []) };
    }

    const observations: Observation[] = [];
    for (const img of images) {
      img.record.visionSessionID = child;
      const cached = this.deps.memory?.get(mainSessionID, img.sha256);
      if (cached?.analysis) {
        img.record.analysis = cached.analysis;
        observations.push({
          sha256: img.sha256,
          mime: img.parsed.mime,
          bytes: img.parsed.bytes,
          text: `${cached.analysis}\n(recalled from memory; ask via vision_ask to re-analyze)`,
        });
        logger.debug(`reused memory for sha256:${shortHash(img.sha256)} main=${mainSessionID}`);
        continue;
      }
      try {
        const text = await transport.sendImage(child, img.attachment, cfg.analysisQuestion);
        img.record.analysis = text;
        this.deps.memory?.upsertImage(mainSessionID, {
          sha256: img.sha256,
          mime: img.parsed.mime,
          bytes: img.parsed.bytes,
          filename: img.attachment.filename,
          storedPath: img.storedPath ?? undefined,
          visionSessionID: child,
        });
        this.deps.memory?.setAnalysis(mainSessionID, img.sha256, text);
        observations.push({ sha256: img.sha256, mime: img.parsed.mime, bytes: img.parsed.bytes, text });
        logger.debug(`vision session retained image=sha256:${shortHash(img.sha256)} vision=${child}`);
      } catch (err) {
        logger.warn(
          `vision analysis failed for sha256:${shortHash(img.sha256)} vision=${child}: ${String((err as Error)?.message ?? err)}`,
        );
        observations.push({
          sha256: img.sha256,
          mime: img.parsed.mime,
          bytes: img.parsed.bytes,
          text: "[vision error: analysis unavailable]",
        });
      }
    }
    return { visionSessionID: child, observations, text: formatObservations(observations, child) };
  }

  /** Ask the main session's vision child a follow-up question. */
  async ask(mainSessionID: string, question: string): Promise<string> {
    const { transport, registry } = this.deps;
    if (!transport) throw new Error("vision transport not configured");
    const link = registry.getLink(mainSessionID);
    if (!link) return "[vision] no vision session is associated with this session yet; read an image first.";
    const alive = await transport.isAlive(link.visionSessionID).catch(() => false);
    if (!alive) throw new Error("vision session is unavailable");
    const answer = await transport.ask(link.visionSessionID, question);
    this.deps.memory?.addQA(mainSessionID, question, answer);
    return answer;
  }
}

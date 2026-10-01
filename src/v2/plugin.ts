import { createRuntime } from "../core/runtime.js";
import { planRetention } from "../core/retention.js";
import { MINIMAL_PNG_DATA_URL, type Attachment } from "../core/types.js";
import { createV2Transport, type V2SessionApi } from "./transport.js";
import {
  applyV2Retention,
  countV2Images,
  injectObservations,
  stripV2Images,
  type V2Message,
} from "./transform.js";

/** Structural view of the V2 plugin context (avoid a hard package import). */
export interface V2ToolAfter {
  tool: string;
  sessionID: string;
  messageID?: string;
  id?: string;
  input?: unknown;
  status?: string;
  result?: { output?: unknown; content?: unknown; metadata?: unknown };
}

export interface V2ContextHook {
  sessionID: string;
  messages?: V2Message[];
  [key: string]: unknown;
}

export interface V2ToolApi {
  hook(name: "execute.before" | "execute.after", cb: (input: V2ToolAfter) => unknown): unknown;
  register?: (name: string, tool: unknown) => unknown;
}

export interface V2PluginContext {
  options?: unknown;
  tool?: V2ToolApi;
  session: V2SessionApi & {
    hook(name: "context" | "compaction" | "generate" | "title" | "retry", cb: (input: V2ContextHook) => unknown): unknown;
  };
  [key: string]: unknown;
}

function envOverride(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const map: Record<string, string> = {
    OCIMAGE_DATA_DIR: "dataDir",
    OCIMAGE_LOG: "logFile",
    OCIMAGE_MODEL: "model",
    OCIMAGE_ANALYSIS_QUESTION: "analysisQuestion",
  };
  for (const [env, key] of Object.entries(map)) {
    const v = process.env[env];
    if (typeof v === "string" && v) out[key] = v;
  }
  for (const [env, key] of Object.entries({
    OCIMAGE_HIGH: "highWatermarkBytes",
    OCIMAGE_LOW: "lowWatermarkBytes",
    OCIMAGE_KEEP: "keepRecentImages",
    OCIMAGE_MAX: "maxImageBytes",
  })) {
    const v = process.env[env];
    if (typeof v === "string" && v && Number.isFinite(Number(v))) out[key] = Number(v);
  }
  if (process.env.OCIMAGE_DEBUG) out.debug = process.env.OCIMAGE_DEBUG !== "0";
  if (process.env.OCIMAGE_ENABLED) out.enabled = process.env.OCIMAGE_ENABLED !== "0";
  return out;
}

function resolveOptions(options: unknown): Record<string, unknown> {
  const base = options && typeof options === "object" ? (options as Record<string, unknown>) : {};
  return { ...base, ...envOverride() };
}

/** Extract read-tool image attachments from a V2 `execute.after` result. */
function readAttachments(result: V2ToolAfter["result"]): Attachment[] {
  const out: Attachment[] = [];
  const content = result?.content;
  if (Array.isArray(content)) {
    for (const raw of content) {
      const p = raw as { type?: string; uri?: unknown; url?: unknown; mime?: unknown; mediaType?: unknown; name?: unknown; data?: unknown };
      if (!p || p.type !== "file") continue;
      const mime = typeof p.mime === "string" ? p.mime : typeof p.mediaType === "string" ? p.mediaType : "";
      const uri = typeof p.uri === "string" ? p.uri : typeof p.url === "string" ? p.url : "";
      const url = uri || (mime.startsWith("image/") && typeof p.data === "string" ? `data:${mime};base64,${p.data}` : "");
      if (url && mime.startsWith("image/")) {
        out.push({ type: "file", mime, url, filename: typeof p.name === "string" ? p.name : undefined });
      }
    }
  }
  const o = result?.output as { type?: string; content?: unknown; mime?: unknown; name?: unknown; uri?: unknown } | undefined;
  if (out.length === 0 && o && o.type === "file" && typeof o.mime === "string" && o.mime.startsWith("image/")) {
    const url =
      typeof o.uri === "string" && o.uri
        ? o.uri
        : typeof o.content === "string"
          ? `data:${o.mime};base64,${o.content}`
          : "";
    if (url) out.push({ type: "file", mime: o.mime, url, filename: typeof o.name === "string" ? o.name : undefined });
  }
  return out;
}

/**
 * OpenCode V2 adapter.
 *
 * `setup(ctx)` registers native V2 hooks:
 * - `tool.execute.after` captures `read` image attachments, persists/hashes them
 *   and routes them to the persistent vision child.
 * - `session.hook("context")` strips every image from main-session model messages
 *   and applies hysteretic batch eviction to the vision child's own images.
 *
 * No compaction hook is registered: OpenCode ACP owns main-session compaction.
 */
export async function VisionPluginV2(ctx: V2PluginContext): Promise<void> {
  // OpenCode 1 hosts also boot an embedded V2 core in a registration-only pass
  // (no tool/session domains). This adapter only has work to do on a real V2
  // host, so skip the embedded pass to avoid duplicate work and side effects.
  if (typeof ctx?.tool?.hook !== "function" || typeof ctx?.session?.hook !== "function") {
    return;
  }

  const runtime = createRuntime(resolveOptions(ctx.options));
  if (!runtime.cfg.enabled) {
    runtime.logger.info("disabled by configuration");
    return;
  }
  runtime.manager.setTransport(createV2Transport(ctx, runtime.cfg.model, runtime.logger));
  runtime.logger.info(`v2 adapter active dataDir=${runtime.cfg.dataDir}`);

  /** Observations awaiting delivery to the main session's next model request. */
  const pending = new Map<string, string[]>();

  const visionAsk = {
    description:
      "Ask the persistent vision session about images previously read in this session " +
      "(or ask it to compare earlier images). Returns a textual answer only.",
    args: { question: "string" },
    execute: async (args: Record<string, unknown>, context: { sessionID: string }) => {
      const question = String(args?.question ?? "").trim();
      if (!question) return "[vision] empty question";
      try {
        return (await runtime.manager.ask(context.sessionID, question)) || "[vision] no answer";
      } catch (err) {
        return `[vision] error: ${String((err as Error)?.message ?? err)}`;
      }
    },
  };

  ctx.tool?.hook("execute.after", async (input: V2ToolAfter) => {
    try {
      if (input?.tool !== "read") return;
      const attachments = readAttachments(input.result);
      if (attachments.length === 0) return;
      const main = input.sessionID;

      const { images } = runtime.manager.ingest(main, attachments);
      if (images.length === 0) return;
      runtime.logger.debug(`stripped ${images.length} attachment(s) from main session main=${main}`);

      const route = await runtime.manager.routeImages(main, images);
      if (route.text) {
        const list = pending.get(main) ?? [];
        list.push(route.text);
        pending.set(main, list);
      }
    } catch (err) {
      runtime.logger.error(`tool.execute.after failed: ${String((err as Error)?.message ?? err)}`);
    }
  });

  ctx.session.hook("context", (c: V2ContextHook) => {
    try {
      const isVision = runtime.manager.classify(c.sessionID) === "vision";
      const messages = c.messages ?? [];

      if (isVision) {
        const outcome = applyV2Retention(
          messages,
          (items) => planRetention(items, runtime.cfg),
          MINIMAL_PNG_DATA_URL,
        );
        if (outcome.evicted > 0) {
          runtime.logger.info(`image budget ${outcome.totalBytes}B > high watermark ${runtime.cfg.highWatermarkBytes}B`);
          runtime.logger.info(`evicting oldest ${outcome.evicted}/${outcome.total} images`);
          runtime.logger.info(`retained newest ${outcome.kept} images`);
        }
      } else {
        const removed = stripV2Images(messages);
        if (removed > 0) {
          runtime.logger.debug(`stripped ${removed} image part(s) from a main request`);
        }
        const notes = pending.get(c.sessionID);
        if (notes && notes.length > 0) {
          injectObservations(messages, notes);
          pending.delete(c.sessionID);
        }
        if (runtime.cfg.debug) {
          runtime.logger.debug(`transform removed=${removed} imagesInContext=${countV2Images(messages)}`);
        }
      }
    } catch (err) {
      runtime.logger.error(`session.context hook failed: ${String((err as Error)?.message ?? err)}`);
    }
  });

  if (typeof ctx.tool?.register === "function") {
    ctx.tool.register("vision_ask", visionAsk);
    runtime.logger.debug("registered vision_ask tool");
  } else {
    runtime.logger.info("vision_ask tool unavailable in this V2 build (no ctx.tool.register)");
  }
}

/** V2 plugin-module shape: a default definition with an id and a setup function. */
export default { id: "opencode-image-context", setup: VisionPluginV2 };

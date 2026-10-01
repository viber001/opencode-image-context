import { z } from "zod";
import { createRuntime } from "../core/runtime.js";
import { isImageAttachment } from "../core/image.js";
import { buildSkippedNote, type VisionManager } from "../core/manager.js";
import { stripMainImages, countImages, applyVisionRetention, type WireMessage } from "../core/transform.js";
import { planRetention } from "../core/retention.js";
import { MINIMAL_PNG_DATA_URL } from "../core/types.js";
import { createV1Transport, type V1Client } from "./transport.js";

export interface V1PluginInput {
  client: V1Client;
  directory?: string;
  worktree?: string;
}

/** Structural V1 hook shapes (avoid a hard dependency on the plugin package). */
export interface V1ToolAfterInput {
  tool: string;
  sessionID: string;
  callID: string;
  args?: unknown;
}

export interface V1ToolAfterOutput {
  title?: string;
  output: string;
  metadata?: unknown;
  attachments?: unknown[];
}

export interface V1ToolContext {
  sessionID: string;
  messageID?: string;
  agent?: string;
}

export type V1Hooks = {
  "tool.execute.after"?: (input: V1ToolAfterInput, output: V1ToolAfterOutput) => Promise<void>;
  "experimental.chat.messages.transform"?: (input: unknown, output: { messages: WireMessage[] }) => Promise<void>;
  tool?: Record<string, V1ToolDefinition>;
};

export interface V1ToolDefinition {
  description: string;
  args: Record<string, unknown>;
  execute: (args: Record<string, unknown>, context: V1ToolContext) => Promise<unknown>;
}

function makeVisionAskTool(manager: VisionManager): V1ToolDefinition {
  return {
    description:
      "Ask the persistent vision session about images previously read in this session " +
      "(or ask it to compare earlier images). Returns a textual answer only.",
    args: {
      question: z.string().describe("The question to ask about previously read images."),
    },
    execute: async (args, context) => {
      const question = String(args.question ?? "").trim();
      if (!question) return "[vision] empty question";
      try {
        const answer = await manager.ask(context.sessionID, question);
        return answer || "[vision] no answer";
      } catch (err) {
        return `[vision] error: ${String((err as Error)?.message ?? err)}`;
      }
    },
  };
}

/**
 * OpenCode V1 adapter.
 *
 * Stage (commit 2): intercept `read` image attachments, persist + hash them,
 * and replace the raw base64 attachment in the main session with a textual
 * placeholder. Routing to a persistent vision child is added in a later
 * milestone; the core manager already owns validation/hashing/storage.
 */
export const VisionPluginV1 = async (input?: V1PluginInput, options?: unknown): Promise<V1Hooks> => {
  const runtime = createRuntime(options);
  if (!runtime.cfg.enabled) {
    runtime.logger.info("disabled by configuration");
    return {};
  }
  if (input?.client) {
    runtime.manager.setTransport(createV1Transport(input.client, runtime.cfg.model, runtime.logger));
  } else {
    runtime.logger.error("v1 adapter received no client; routing disabled");
  }
  const manager = runtime.manager;
  runtime.logger.info(`v1 adapter active dataDir=${runtime.cfg.dataDir}`);

  return {
    "tool.execute.after": async (toolInput, output) => {
      try {
        if (toolInput?.tool !== "read") return;
        const attachments = output?.attachments;
        if (!Array.isArray(attachments) || attachments.length === 0) return;

        const { images, skipped } = manager.ingest(toolInput.sessionID, attachments);

        // Strip every image attachment from the main session immediately.
        output.attachments = attachments.filter((a) => !isImageAttachment(a));
        const skippedNote = buildSkippedNote(skipped);
        if (skippedNote) output.output = `${output.output ?? ""}\n${skippedNote}`.trim();
        if (images.length === 0) return;

        runtime.logger.debug(`stripped ${images.length} attachment(s) from main session main=${toolInput.sessionID}`);

        // Route to the persistent vision child; append its textual observation.
        const route = await manager.routeImages(toolInput.sessionID, images);
        if (route.text) output.output = `${output.output ?? ""}\n${route.text}`.trim();
      } catch (err) {
        runtime.logger.error(`tool.execute.after failed: ${String((err as Error)?.message ?? err)}`);
      }
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      try {
        const isVision = (sid: string) => manager.classify(sid) === "vision";
        const removed = stripMainImages(output.messages, isVision);
        if (removed > 0) {
          runtime.logger.debug(`stripped ${removed} historical image attachment(s) from a main request`);
        }

        // Vision child: hysteretic batch eviction over its own image history.
        const outcome = applyVisionRetention(
          output.messages,
          isVision,
          (items) => planRetention(items, runtime.cfg),
          MINIMAL_PNG_DATA_URL,
        );
        if (outcome.evicted > 0) {
          runtime.logger.info(
            `image budget ${outcome.totalBytes}B > high watermark ${runtime.cfg.highWatermarkBytes}B`,
          );
          runtime.logger.info(`evicting oldest ${outcome.evicted}/${outcome.total} images`);
          runtime.logger.info(`retained newest ${outcome.kept} images`);
        }
        if (runtime.cfg.debug) {
          runtime.logger.debug(
            `transform removed=${removed} evicted=${outcome.evicted} imagesBySession=${JSON.stringify(countImages(output.messages))}`,
          );
        }
      } catch (err) {
        runtime.logger.error(`messages.transform failed: ${String((err as Error)?.message ?? err)}`);
      }
    },

    tool: {
      vision_ask: makeVisionAskTool(manager),
    },
  };
};

/** V1 plugin-module shape: `default` must expose `server`. */
export default { id: "opencode-image-context", server: VisionPluginV1 };

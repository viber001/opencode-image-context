import { createRuntime } from "../core/runtime.js";
import { isImageAttachment } from "../core/image.js";

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

export type V1Hooks = {
  "tool.execute.after"?: (input: V1ToolAfterInput, output: V1ToolAfterOutput) => Promise<void>;
};

/**
 * OpenCode V1 adapter.
 *
 * Stage (commit 2): intercept `read` image attachments, persist + hash them,
 * and replace the raw base64 attachment in the main session with a textual
 * placeholder. Routing to a persistent vision child is added in a later
 * milestone; the core manager already owns validation/hashing/storage.
 */
export const VisionPluginV1 = async (_input: unknown, options?: unknown): Promise<V1Hooks> => {
  const runtime = createRuntime(options);
  if (!runtime.cfg.enabled) {
    runtime.logger.info("disabled by configuration");
    return {};
  }
  runtime.logger.info(`v1 adapter active dataDir=${runtime.cfg.dataDir}`);

  return {
    "tool.execute.after": async (input, output) => {
      try {
        if (input?.tool !== "read") return;
        const attachments = output?.attachments;
        if (!Array.isArray(attachments) || attachments.length === 0) return;

        const { images, placeholder } = runtime.manager.ingest(input.sessionID, attachments);

        // Strip every image attachment from the main session immediately.
        output.attachments = attachments.filter((a) => !isImageAttachment(a));
        if (placeholder) {
          output.output = `${output.output ?? ""}\n${placeholder}`.trim();
        }
        if (images.length > 0) {
          runtime.logger.debug(`stripped ${images.length} attachment(s) from main session main=${input.sessionID}`);
        }
      } catch (err) {
        runtime.logger.error(`tool.execute.after failed: ${String((err as Error)?.message ?? err)}`);
      }
    },
  };
};

/** V1 plugin-module shape: `default` must expose `server`. */
export default { id: "opencode-image-context", server: VisionPluginV1 };

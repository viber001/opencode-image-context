import type { VisionTransport } from "../ports.js";
import type { Logger } from "../core/logger.js";
import type { Attachment } from "../core/types.js";

/** Structural view of the V2 session API we depend on (no hard package import). */
export interface V2SessionApi {
  create(input: { title?: string }): Promise<{ id?: string }>;
  get(input: { sessionID: string }): Promise<unknown>;
  prompt(input: {
    sessionID: string;
    text: string;
    files?: Array<{ uri: string; mime?: string; name?: string }>;
    delivery?: string;
  }): Promise<unknown>;
  wait(input: { sessionID: string }): Promise<unknown>;
  context(input: { sessionID: string }): Promise<unknown>;
  switchModel?(input: { sessionID: string; model: { id: string; providerID: string } }): Promise<unknown>;
}

export interface V2SessionContext {
  session: V2SessionApi;
}

const WAIT_POLL_ATTEMPTS = 20;
const WAIT_POLL_INTERVAL_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseModel(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const i = model.indexOf("/");
  if (i <= 0 || i === model.length - 1) return undefined;
  return { providerID: model.slice(0, i), modelID: model.slice(i + 1) };
}

/** The V2 session context reports a model as `{ id, providerID }`; `id` may carry the provider prefix. */
function modelRefOf(info: unknown): { providerID: string; modelID: string } | undefined {
  const model = (info as { model?: { id?: unknown; providerID?: unknown } } | undefined)?.model;
  if (!model || typeof model.providerID !== "string") return undefined;
  const raw = typeof model.id === "string" ? model.id : "";
  const prefix = `${model.providerID}/`;
  const modelID = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  if (!modelID) return undefined;
  return { providerID: model.providerID, modelID };
}

/** Extract the assistant's textual content from the V2 `session.context` transcript. */
function assistantText(transcript: unknown): string {
  if (!Array.isArray(transcript)) return "";
  for (let i = transcript.length - 1; i >= 0; i--) {
    const msg = transcript[i] as { type?: string; content?: unknown; parts?: unknown };
    if (msg?.type !== "assistant") continue;
    const parts = (Array.isArray(msg.content) ? msg.content : Array.isArray(msg.parts) ? msg.parts : []) as Array<{
      type?: string;
      text?: unknown;
    }>;
    const text = parts
      .filter((p) => p?.type === "text")
      .map((p) => String(p.text ?? ""))
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

/**
 * V2 implementation of `VisionTransport` over `ctx.session`.
 *
 * V2 `prompt` is durable/asynchronous (it admits one session input), so after
 * sending an image we wait for the session to go idle and read the assistant
 * text back from `session.context`.
 */
export function createV2Transport(
  ctx: V2SessionContext,
  model: string | undefined,
  logger: Logger,
): VisionTransport {
  const modelRef = parseModel(model);

  async function readReply(childSessionID: string): Promise<string> {
    await ctx.session.wait({ sessionID: childSessionID }).catch(() => undefined);
    for (let attempt = 0; attempt < WAIT_POLL_ATTEMPTS; attempt++) {
      try {
        const transcript = await ctx.session.context({ sessionID: childSessionID });
        const text = assistantText(transcript);
        if (text) return text;
      } catch (err) {
        logger.debug(`session.context failed for ${childSessionID}: ${String((err as Error)?.message ?? err)}`);
      }
      await sleep(WAIT_POLL_INTERVAL_MS);
    }
    throw new Error("vision child returned no text");
  }

  const applyModel = async (childSessionID: string, ref: { providerID: string; modelID: string }): Promise<void> => {
    if (!ctx.session.switchModel) return;
    // V2 switchModel model shape is `{ id, providerID }` where `id` is the bare model id.
    await ctx.session.switchModel({ sessionID: childSessionID, model: { id: ref.modelID, providerID: ref.providerID } });
  };

  return {
    async createChild(mainSessionID: string, title: string): Promise<string> {
      const created = await ctx.session.create({ title });
      const id = created?.id;
      if (!id) throw new Error("session.create returned no id");
      // V2 children do not inherit a model, so select one explicitly: the
      // configured vision model, else the main session's current model.
      let ref = modelRef;
      if (!ref) {
        try {
          ref = modelRefOf(await ctx.session.get({ sessionID: mainSessionID }));
        } catch (err) {
          logger.debug(`session.get failed for ${mainSessionID}: ${String((err as Error)?.message ?? err)}`);
        }
      }
      if (ref) await applyModel(id, ref).catch((err) => logger.warn(`switchModel failed: ${String((err as Error)?.message ?? err)}`));
      return id;
    },

    async sendImage(childSessionID: string, image: Attachment, question: string): Promise<string> {
      await ctx.session.prompt({
        sessionID: childSessionID,
        text: question,
        files: [{ uri: image.url, mime: image.mime, name: image.filename ?? "image" }],
      });
      return readReply(childSessionID);
    },

    async ask(childSessionID: string, question: string): Promise<string> {
      await ctx.session.prompt({ sessionID: childSessionID, text: question });
      return readReply(childSessionID);
    },

    async isAlive(childSessionID: string): Promise<boolean> {
      try {
        const info = await ctx.session.get({ sessionID: childSessionID });
        return Boolean((info as { id?: string } | undefined)?.id);
      } catch (err) {
        logger.debug(`session.get failed for ${childSessionID}: ${String((err as Error)?.message ?? err)}`);
        return false;
      }
    },

    async setChildModel(childSessionID: string, model: string): Promise<void> {
      const ref = parseModel(model);
      if (ref) await applyModel(childSessionID, ref);
    },
  };
}

import type { VisionTransport } from "../ports.js";
import type { Logger } from "../core/logger.js";
import type { Attachment } from "../core/types.js";

/** Minimal structural shape of the V1 client we need. */
export interface V1Client {
  session: {
    create(input: { body: { parentID?: string; title?: string } }): Promise<unknown>;
    get(input: { path: { id: string } }): Promise<unknown>;
    prompt(input: {
      path: { id: string };
      body: {
        model?: { providerID: string; modelID: string };
        parts: Array<Record<string, unknown>>;
      };
    }): Promise<unknown>;
  };
}

function unwrap<T = any>(res: unknown): T {
  const r = res as { data?: T } | T;
  return ((r as { data?: T })?.data ?? r) as T;
}

function assistantText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => (p as { type?: string })?.type === "text")
    .map((p) => String((p as { text?: unknown }).text ?? ""))
    .join("\n")
    .trim();
}

function parseModel(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const i = model.indexOf("/");
  if (i <= 0 || i === model.length - 1) return undefined;
  return { providerID: model.slice(0, i), modelID: model.slice(i + 1) };
}

/** V1 implementation of VisionTransport over the SDK client. */
export function createV1Transport(client: V1Client, model: string | undefined, logger: Logger): VisionTransport {
  const modelRef = parseModel(model);
  return {
    async createChild(mainSessionID: string, title: string): Promise<string> {
      const created = unwrap<{ id?: string }>(await client.session.create({ body: { parentID: mainSessionID, title } }));
      const id = created?.id;
      if (!id) throw new Error("session.create returned no id");
      return id;
    },

    async sendImage(childSessionID: string, image: Attachment, question: string): Promise<string> {
      const res = unwrap<{ parts?: unknown[] }>(
        await client.session.prompt({
          path: { id: childSessionID },
          body: {
            ...(modelRef ? { model: modelRef } : {}),
            parts: [
              { type: "file", mime: image.mime, url: image.url, filename: image.filename ?? "image" },
              { type: "text", text: question },
            ],
          },
        }),
      );
      const text = assistantText(res?.parts);
      if (!text) throw new Error("vision child returned no text");
      return text;
    },

    async ask(childSessionID: string, question: string): Promise<string> {
      const res = unwrap<{ parts?: unknown[] }>(
        await client.session.prompt({
          path: { id: childSessionID },
          body: {
            ...(modelRef ? { model: modelRef } : {}),
            parts: [{ type: "text", text: question }],
          },
        }),
      );
      return assistantText(res?.parts);
    },

    async isAlive(childSessionID: string): Promise<boolean> {
      try {
        const s = unwrap<{ id?: string }>(await client.session.get({ path: { id: childSessionID } }));
        return Boolean(s?.id);
      } catch (err) {
        logger.debug(`session.get failed for ${childSessionID}: ${String((err as Error)?.message ?? err)}`);
        return false;
      }
    },
  };
}

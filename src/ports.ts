import type { Attachment } from "./core/types.js";

/**
 * Adapter-provided bridge to OpenCode sessions. V1 and V2 each implement this
 * over their own API; core never imports V1/V2 code.
 */
export interface VisionTransport {
  /** Create a persistent child session associated with a main session. */
  createChild(mainSessionID: string, title: string): Promise<string>;
  /** Send an image plus a question to a vision child; resolve to assistant text. */
  sendImage(childSessionID: string, image: Attachment, question: string): Promise<string>;
  /** Ask an existing vision child a text-only question; resolve to assistant text. */
  ask(childSessionID: string, question: string): Promise<string>;
  /** Whether the child session still exists and can be prompted. */
  isAlive(childSessionID: string): Promise<boolean>;
  /** Optional independent model selector applied to the child, if supported. */
  setChildModel?(childSessionID: string, model: string): Promise<void>;
}

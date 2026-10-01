import { appendFileSync } from "node:fs";
import { resolveConfig } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { ImageStore } from "./imageStore.js";
import { MemoryStore } from "./memoryStore.js";
import { Registry } from "./registry.js";
import { VisionManager } from "./manager.js";
import type { VisionTransport } from "../ports.js";
import type { VisionConfig } from "./types.js";

export interface Runtime {
  cfg: VisionConfig;
  logger: Logger;
  registry: Registry;
  images: ImageStore;
  memory: MemoryStore;
  manager: VisionManager;
}

/** Build the shared core runtime from raw plugin options. */
export function createRuntime(rawOptions: unknown, transport?: VisionTransport): Runtime {
  const cfg = resolveConfig(rawOptions);
  const logger = createLogger(
    cfg.debug,
    cfg.logFile ? (line) => appendFileSync(cfg.logFile!, line + "\n") : undefined,
  );
  const registry = new Registry(cfg.dataDir);
  const images = new ImageStore(cfg.dataDir);
  const memory = new MemoryStore(cfg.dataDir);
  const manager = new VisionManager({ cfg, registry, images, memory, logger, transport });
  return { cfg, logger, registry, images, memory, manager };
}

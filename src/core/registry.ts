import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RegistryFile, VisionLink } from "./types.js";

const EMPTY: RegistryFile = { version: 1, links: {}, visionSessions: {} };

/**
 * Persistent mainSession -> visionSession registry backed by a JSON file.
 * Writes are atomic (temp file + rename) so a crash cannot corrupt the map.
 */
export class Registry {
  private readonly file: string;
  private data: RegistryFile;

  constructor(dataDir: string) {
    this.file = join(dataDir, "registry.json");
    mkdirSync(dirname(this.file), { recursive: true });
    this.data = this.load();
  }

  private load(): RegistryFile {
    try {
      if (!existsSync(this.file)) return structuredClone(EMPTY);
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<RegistryFile>;
      return {
        version: 1,
        links: parsed.links ?? {},
        visionSessions: parsed.visionSessions ?? {},
      };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }

  getLink(mainSessionID: string): VisionLink | undefined {
    return this.data.links[mainSessionID];
  }

  isVisionSession(sessionID: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.data.visionSessions, sessionID);
  }

  visionSessionOwner(sessionID: string): string | undefined {
    return this.data.visionSessions[sessionID]?.mainSessionID;
  }

  setLink(link: VisionLink): void {
    this.data.links[link.mainSessionID] = link;
    this.data.visionSessions[link.visionSessionID] = {
      mainSessionID: link.mainSessionID,
      createdAt: link.createdAt,
      generation: link.generation,
    };
    this.persist();
  }

  /** Replace a failed vision child, preserving and bumping the generation. */
  replaceVision(mainSessionID: string, newVisionSessionID: string, now = Date.now()): VisionLink {
    const prev = this.data.links[mainSessionID];
    const generation = (prev?.generation ?? 0) + 1;
    const link: VisionLink = {
      mainSessionID,
      visionSessionID: newVisionSessionID,
      createdAt: now,
      generation,
    };
    this.setLink(link);
    return link;
  }

  allLinks(): VisionLink[] {
    return Object.values(this.data.links);
  }
}

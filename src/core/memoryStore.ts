import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface MemoryImage {
  sha256: string;
  mime: string;
  bytes: number;
  filename?: string;
  storedPath?: string;
  firstSeen: number;
  lastSeen: number;
  visionSessionID?: string;
  /** Latest textual observation. Never contains base64. */
  analysis?: string;
}

export interface MemoryQA {
  question: string;
  answer: string;
  at: number;
}

export interface MemoryDoc {
  mainSessionID: string;
  updatedAt: number;
  images: Record<string, MemoryImage>;
  qa: MemoryQA[];
}

function emptyDoc(mainSessionID: string): MemoryDoc {
  return { mainSessionID, updatedAt: 0, images: {}, qa: [] };
}

/**
 * Human- and machine-readable textual memory of what the vision child has seen,
 * per main session. Used for dedup and to restore context if a vision child is
 * lost. Only text is stored here — original images live in the ImageStore.
 */
export class MemoryStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "vision-memory");
  }

  private jsonPath(mainSessionID: string): string {
    return join(this.dir, `${mainSessionID}.json`);
  }

  private mdPath(mainSessionID: string): string {
    return join(this.dir, `${mainSessionID}.md`);
  }

  load(mainSessionID: string): MemoryDoc {
    const file = this.jsonPath(mainSessionID);
    try {
      if (!existsSync(file)) return emptyDoc(mainSessionID);
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<MemoryDoc>;
      return { ...emptyDoc(mainSessionID), ...parsed, mainSessionID };
    } catch {
      return emptyDoc(mainSessionID);
    }
  }

  get(mainSessionID: string, sha256: string): MemoryImage | undefined {
    return this.load(mainSessionID).images[sha256];
  }

  private persist(doc: MemoryDoc): void {
    mkdirSync(this.dir, { recursive: true });
    doc.updatedAt = Date.now();
    const tmp = `${this.jsonPath(doc.mainSessionID)}.tmp`;
    writeFileSync(tmp, JSON.stringify(doc, null, 2));
    renameSync(tmp, this.jsonPath(doc.mainSessionID));
    writeFileSync(this.mdPath(doc.mainSessionID), toMarkdown(doc));
  }

  upsertImage(mainSessionID: string, image: Omit<MemoryImage, "firstSeen" | "lastSeen"> & Partial<Pick<MemoryImage, "firstSeen" | "lastSeen">>): MemoryImage {
    const doc = this.load(mainSessionID);
    const now = Date.now();
    const prev = doc.images[image.sha256];
    const merged: MemoryImage = {
      ...prev,
      ...image,
      firstSeen: prev?.firstSeen ?? image.firstSeen ?? now,
      lastSeen: now,
    };
    doc.images[image.sha256] = merged;
    this.persist(doc);
    return merged;
  }

  setAnalysis(mainSessionID: string, sha256: string, analysis: string): void {
    const doc = this.load(mainSessionID);
    const prev = doc.images[sha256];
    if (!prev) return;
    prev.analysis = analysis;
    this.persist(doc);
  }

  addQA(mainSessionID: string, question: string, answer: string): void {
    const doc = this.load(mainSessionID);
    doc.qa.push({ question, answer, at: Date.now() });
    this.persist(doc);
  }
}

export function toMarkdown(doc: MemoryDoc): string {
  const lines: string[] = [`# Vision memory — ${doc.mainSessionID}`, ""];
  lines.push(`Updated: ${new Date(doc.updatedAt).toISOString()}`, "");
  lines.push("## Images", "");
  const images = Object.values(doc.images).sort((a, b) => a.firstSeen - b.firstSeen);
  if (images.length === 0) lines.push("_none_");
  for (const img of images) {
    lines.push(`### sha256:${img.sha256.slice(0, 16)} (${img.mime}, ${img.bytes}B)`);
    if (img.filename) lines.push(`- file: ${img.filename}`);
    if (img.storedPath) lines.push(`- stored: ${img.storedPath}`);
    if (img.visionSessionID) lines.push(`- vision session: ${img.visionSessionID}`);
    lines.push("");
    lines.push(img.analysis ? img.analysis : "_no observation_");
    lines.push("");
  }
  if (doc.qa.length > 0) {
    lines.push("## Q&A", "");
    for (const qa of doc.qa) {
      lines.push(`- Q: ${qa.question}`);
      lines.push(`  A: ${qa.answer}`);
    }
  }
  return lines.join("\n");
}

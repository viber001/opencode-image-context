import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Real end-to-end test against a V2 runtime (opencode2).
 *
 * Gated behind RUN_V2_E2E=1: it needs a working model/provider and either a
 * local `opencode2` binary or an SSH target that has one. Example:
 *
 *   RUN_V2_E2E=1 E2E_V2_SSH=xshu@localhost bun test test/integration/v2-e2e.test.ts
 *
 * Set E2E_V2_SSH="" to run locally (when `opencode2` is on PATH).
 *
 * V2 auto-discovers plugins in `<configdir>/plugin/*.js`, so the harness copies
 * the bundled `dist/v2.js` there for the duration of the run and removes it
 * afterwards. No compaction hook is registered; `vision_ask` may be unavailable
 * in this V2 build, so the prompt only exercises the read path.
 */
const ENABLED = process.env.RUN_V2_E2E === "1";
const PROJECT = join(import.meta.dir, "..", "..");
const SSH = process.env.E2E_V2_SSH ?? "xshu@localhost";
const OPENCODE2 = process.env.E2E_V2_BIN ?? (SSH ? "/usr/local/bin/opencode2" : "opencode2");
const MODEL = process.env.E2E_V2_MODEL ?? "headroom-tencent-fork/deepseek/deepseek-flash";
const REMOTE_PLUGIN = ".config/opencode/plugin/ocimage-e2e-v2.js";

/** Run a shell command locally or over ssh, returning its exit code and output. */
function shell(command: string, opts: { input?: Buffer; timeoutMs?: number } = {}): { code: number; out: string } {
  const cmd = SSH ? "ssh" : "sh";
  const args = SSH ? [SSH, command] : ["-c", command];
  const res = spawnSync(cmd, args, {
    input: opts.input,
    encoding: "buffer",
    timeout: opts.timeoutMs ?? 240_000,
  });
  return { code: res.status ?? -1, out: Buffer.concat([res.stdout ?? Buffer.alloc(0), res.stderr ?? Buffer.alloc(0)]).toString() };
}

describe.skipIf(!ENABLED)("V2 end-to-end", () => {
  beforeAll(() => {
    const built = spawnSync("bun", ["run", "build"], { cwd: PROJECT, stdio: "inherit" });
    if (built.status !== 0) throw new Error("build failed");
    const dist = readFileSync(join(PROJECT, "dist", "v2.js"));
    const write = shell(`mkdir -p ~/.config/opencode/plugin && cat > ${REMOTE_PLUGIN}`, { input: dist });
    if (write.code !== 0) throw new Error(`failed to install V2 plugin: ${write.out}`);
  });

  test(
    "main loses image parts, vision child gains the image, logs carry no base64",
    () => {
      const work = shell("mktemp -d /tmp/vic-e2e-v2-XXXXXX").out.trim();
      const dataDir = `${work}/data`;
      const logFile = `${work}/debug.log`;
      const probe = readFileSync(join(PROJECT, "test", "fixtures", "probe.png"));
      shell(`cat > ${work}/probe.png`, { input: probe });

      const prompt =
        "Use ONLY the read tool (never shell) to open the file probe.png in the current directory. " +
        "Then state the dominant color in one word.";
      const env = `OCIMAGE_DATA_DIR=${dataDir} OCIMAGE_LOG=${logFile} OCIMAGE_DEBUG=1`;
      const run = shell(
        `cd ${work} && ${env} ${OPENCODE2} run --standalone --auto -m ${MODEL} ${JSON.stringify(prompt)} </dev/null`,
        { timeoutMs: 240_000 },
      );

      try {
        const log = shell(`cat ${logFile} 2>/dev/null`).out;
        const registryRaw = shell(`cat ${dataDir}/registry.json 2>/dev/null`).out;
        const images = shell(`ls ${dataDir}/images 2>/dev/null`).out.trim();

        if (!registryRaw) throw new Error(`no registry written (exit=${run.code})\n--- output ---\n${run.out}\n--- log ---\n${log}`);
        const registry = JSON.parse(registryRaw) as { links?: Record<string, { visionSessionID: string }> };

        expect(log).toContain("v2 adapter active");
        expect(log).toContain("created vision session=");
        expect(log).toMatch(/stripped \d+ image part/);
        expect(log).toContain("imagesInContext=0");
        expect(log).toContain("vision session retained image=");
        // No raw base64 may ever reach the log.
        expect(log).not.toContain("data:image");

        const links = Object.values(registry.links ?? {});
        expect(links.length).toBeGreaterThan(0);
        expect(links[0]!.visionSessionID).toBeTruthy();
        expect(images.length).toBeGreaterThan(0);

        const memList = shell(`ls ${dataDir}/vision-memory 2>/dev/null`).out.trim().split("\n");
        const memJson = memList.find((f) => f.endsWith(".json"));
        expect(memJson).toBeTruthy();
        const doc = JSON.parse(shell(`cat ${dataDir}/vision-memory/${memJson}`).out);
        expect(Object.keys(doc.images ?? {}).length).toBeGreaterThan(0);
        expect(JSON.stringify(doc)).not.toContain("base64");
      } finally {
        shell(`rm -rf ${work}`);
        shell(`rm -f ~/${REMOTE_PLUGIN}`);
      }
    },
    260_000,
  );
});

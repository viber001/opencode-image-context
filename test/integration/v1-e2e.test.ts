import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Real end-to-end test against the V1 runtime (opencode 1.x).
 *
 * Gated behind RUN_V1_E2E=1 because it needs a working model/provider and is
 * slow. Run with:  RUN_V1_E2E=1 bun test test/integration
 *
 * V1 only auto-discovers plugins in the global `~/.config/opencode/plugins`
 * directory (project-local `.opencode/plugin` is not scanned, and a `plugin`
 * entry pointing at a file is not loaded). The harness therefore installs a
 * tiny wrapper there for the duration of the run and removes it afterwards.
 *
 *   E2E_MODEL   provider/model to use (default headroom-tencent-fork/deepseek/deepseek-flash)
 *   E2E_BIN     opencode binary (default /opt/homebrew/bin/opencode)
 */
const ENABLED = process.env.RUN_V1_E2E === "1";
const PROJECT = join(import.meta.dir, "..", "..");
const OPENCODE = process.env.E2E_BIN ?? "/opt/homebrew/bin/opencode";
const MODEL = process.env.E2E_MODEL ?? "headroom-tencent-fork/deepseek/deepseek-flash";
const GLOBAL_PLUGINS = join(homedir(), ".config", "opencode", "plugins");
const WRAPPER = join(GLOBAL_PLUGINS, `ocimage-e2e-${process.pid}.ts`);
// The normally-installed plugin shares this directory; a second copy would also
// load and interfere, so it is moved aside for the duration of the run.
const INSTALLED_PLUGIN = join(GLOBAL_PLUGINS, "opencode-image-context.js");
const INSTALLED_ASIDE = join(GLOBAL_PLUGINS, "opencode-image-context.js.e2e-aside");

function run(cmd: string, args: string[], opts: { cwd: string; env: Record<string, string> }, timeoutMs: number) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    // Spawn through a shell rather than as a direct child of bun: launching the
    // opencode binary directly from `bun test` intermittently exits with
    // "Error: Session not found", while an intermediate shell execs it cleanly.
    // stdin must be closed, otherwise `opencode run` waits on it forever.
    const child = spawn("/bin/sh", ["-c", 'exec "$@"', "sh", cmd, ...args], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null, out });
    });
  });
}

describe.skipIf(!ENABLED)("V1 end-to-end", () => {
  beforeAll(() => {
    const built = spawnSync("bun", ["run", "build"], { cwd: PROJECT, stdio: "inherit" });
    if (built.status !== 0) throw new Error("build failed");
    if (existsSync(INSTALLED_PLUGIN)) renameSync(INSTALLED_PLUGIN, INSTALLED_ASIDE);
    writeFileSync(WRAPPER, `import m from "${PROJECT}/integration/v1/plugin.mjs";\nexport default m;\n`);
  });

  afterAll(() => {
    rmSync(WRAPPER, { force: true });
    if (existsSync(INSTALLED_ASIDE)) renameSync(INSTALLED_ASIDE, INSTALLED_PLUGIN);
  });

  test(
    "main loses images, vision child gains them, logs carry no base64",
    async () => {
      try {
        const work = mkdtempSync(join(tmpdir(), "vic-e2e-v1-"));
        copyFileSync(join(PROJECT, "test", "fixtures", "probe.png"), join(work, "probe.png"));
        const dataDir = join(work, "data");
        const logFile = join(work, "debug.log");

        const prompt =
          "Use the read tool to open the file probe.png in the current directory. " +
          "Then call the vision_ask tool once with the question 'what colors dominate?'. " +
          "Finally state the dominant color in one word.";

        const { code, out } = await run(
          OPENCODE,
          ["run", "-m", MODEL, prompt],
          {
            cwd: work,
            env: {
              ...process.env,
              OCIMAGE_DATA_DIR: dataDir,
              OCIMAGE_LOG: logFile,
              OCIMAGE_DEBUG: "1",
            } as Record<string, string>,
          },
          240_000,
        );

        const log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
        const registry = existsSync(join(dataDir, "registry.json"))
          ? JSON.parse(readFileSync(join(dataDir, "registry.json"), "utf8"))
          : null;

        if (!registry) throw new Error(`no registry written (exit=${code})\n--- output ---\n${out}\n--- log ---\n${log}`);

        const links = Object.values(registry.links ?? {}) as Array<{ visionSessionID: string }>;
        expect(links.length).toBeGreaterThan(0);
        expect(links[0]!.visionSessionID).toBeTruthy();

        expect(log).toContain("v1 adapter active");
        expect(log).toContain("created vision session=");
        expect(log).toMatch(/stripped \d+ attachment/);
        // No raw base64 may ever reach the log.
        expect(log).not.toContain("data:image");

        // The image was persisted (by hash) and a textual memory file was written.
        expect(readdirSync(join(dataDir, "images")).length).toBeGreaterThan(0);
        const mem = readdirSync(join(dataDir, "vision-memory"));
        const memJson = mem.find((f) => f.endsWith(".json"));
        expect(memJson).toBeTruthy();
        const doc = JSON.parse(readFileSync(join(dataDir, "vision-memory", memJson!), "utf8"));
        expect(Object.keys(doc.images ?? {}).length).toBeGreaterThan(0);
        expect(JSON.stringify(doc)).not.toContain("base64");
      } finally {
        rmSync(WRAPPER, { force: true });
      }
    },
    250_000,
  );
});

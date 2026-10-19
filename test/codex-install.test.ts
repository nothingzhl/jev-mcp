import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { parse } from "smol-toml";
import { codexConfigPath, installCodex } from "../src/codex-install.js";
import { forwardedEnvironment } from "../src/mcp-config.js";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "jev-install-"));
  const projectRoot = join(directory, 'checkout "with spaces"');
  await mkdir(join(projectRoot, "dist"), { recursive: true });
  await writeFile(join(projectRoot, "dist/mcp.js"), "// Synthetic build fixture\n");
  return { directory, projectRoot, nodeCommand: process.execPath, configPath: join(directory, "codex", "config.toml") };
}

test("explicit Codex registration plans without writes, installs without a key and repeats without rewriting", async () => {
  const f = await fixture();
  try {
    const preview = await installCodex({ ...f, dryRun: true });
    assert.equal(preview.status, "planned");
    assert.equal(existsSync(join(f.directory, "codex")), false);
    assert.equal((await installCodex(f)).status, "installed");
    const before = await readFile(f.configPath);
    const info = await stat(f.configPath);
    const config = parse(before.toString()) as { mcp_servers: { jev: { command: string; args: string[]; cwd: string; env_vars: string[]; env?: unknown } } };
    assert.equal(config.mcp_servers.jev.command, process.execPath);
    assert.deepEqual(config.mcp_servers.jev.args, [join(f.projectRoot, "dist/mcp.js")]);
    assert.equal(config.mcp_servers.jev.cwd, join(f.directory, "codex"));
    assert.deepEqual(config.mcp_servers.jev.env_vars, forwardedEnvironment);
    assert.equal(config.mcp_servers.jev.env, undefined);
    if (process.platform !== "win32") assert.equal(info.mode & 0o777, 0o600);
    const again = await installCodex(f);
    assert.equal(again.status, "already-installed");
    assert.equal(again.networkCallMade, false);
    assert.equal(again.credentialValuesAdded, false);
    assert.deepEqual(await readFile(f.configPath), before);
    assert.equal((await stat(f.configPath)).mtimeMs, info.mtimeMs);
    assert.deepEqual(await readdir(join(f.directory, "codex")), ["config.toml"]);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("registration preserves comments, private existing values, multiline text and other MCP servers byte for byte", async () => {
  const f = await fixture();
  const original = '# keep this comment\r\nmodel = "synthetic-model"\r\nnote = """\n[mcp_servers.jev]\nThis is only text.\n"""\n[mcp_servers.other]\ncommand = "other-server"\n[mcp_servers.other.env]\nOLD_TOKEN = "synthetic-private-existing-value"';
  try {
    await mkdir(join(f.directory, "codex"));
    await writeFile(f.configPath, original, { mode: 0o640 });
    const originalMode = (await stat(f.configPath)).mode & 0o777;
    await installCodex(f);
    const after = await readFile(f.configPath, "utf8");
    assert.ok(after.startsWith(original));
    const parsed = parse(after) as { model: string; mcp_servers: { other: unknown; jev: unknown } };
    assert.equal(parsed.model, "synthetic-model");
    assert.deepEqual(parsed.mcp_servers.other, (parse(original).mcp_servers as Record<string, unknown>).other);
    assert.ok(parsed.mcp_servers.jev);
    if (process.platform !== "win32") assert.equal((await stat(f.configPath)).mode & 0o777, originalMode);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("registration preserves conflicting or malformed files and never exposes their contents in errors", async () => {
  const f = await fixture();
  const secret = "synthetic-private-install-marker";
  try {
    await mkdir(join(f.directory, "codex"));
    const invalid = [
      Buffer.from(`[mcp_servers.jev]\ncommand = "${secret}"\n`),
      Buffer.from(`value = "${secret}\n`),
      Buffer.from([0xff]), Buffer.alloc(1024 * 1024 + 1, 32),
      Buffer.from("#" + " ".repeat(1024 * 1024 - 2) + "\n"), // Valid input, but the addition would exceed the limit.
      Buffer.from("mcp_servers = {}\n"),
    ];
    for (const bytes of invalid) {
      await writeFile(f.configPath, bytes);
      await assert.rejects(installCodex(f), (error: unknown) => {
        assert.equal((error as { code: string }).code, "CONFIGURATION");
        assert.equal(String(error).includes(secret), false);
        return true;
      });
      assert.deepEqual(await readFile(f.configPath), bytes);
      assert.deepEqual(await readdir(join(f.directory, "codex")), [basename(f.configPath)]);
    }
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("registration rejects symlinks, missing builds and held locks without changing their targets", async () => {
  const f = await fixture();
  try {
    const missing = join(f.directory, "missing-build");
    await assert.rejects(installCodex({ ...f, projectRoot: missing }), { code: "CONFIGURATION" });
    assert.equal(existsSync(join(f.directory, "codex")), false);
    await mkdir(join(f.directory, "codex"));
    const target = join(f.directory, "original.toml");
    await writeFile(target, "# preserved\n");
    await symlink(target, f.configPath);
    await assert.rejects(installCodex(f), { code: "CONFIGURATION" });
    assert.equal(await readFile(target, "utf8"), "# preserved\n");
    await rm(f.configPath);
    await writeFile(f.configPath + ".jev.lock", "held by another installer");
    await assert.rejects(installCodex(f), { code: "CONFIGURATION" });
    assert.equal(await readFile(f.configPath + ".jev.lock", "utf8"), "held by another installer");
    assert.equal(existsSync(f.configPath), false);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("six concurrent installers create one complete Jev table and preserve unrelated settings", { timeout: 20_000 }, async () => {
  const f = await fixture();
  const children: ReturnType<typeof fork>[] = [];
  try {
    await mkdir(join(f.directory, "codex"));
    const original = '# concurrency sentinel\nmodel = "synthetic"\n';
    await writeFile(f.configPath, original);
    const ready: Promise<void>[] = [];
    const done: Promise<{ status: string; code?: string }>[] = [];
    for (let i = 0; i < 6; i++) {
      const child = fork(new URL("./fixtures/codex-install-worker.ts", import.meta.url), [], {
        execArgv: ["--import", import.meta.resolve("tsx")], stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: { PATH: process.env.PATH ?? "", TYPESAFE_API_KEY: "" },
      });
      children.push(child);
      ready.push(new Promise((resolve, reject) => { child.once("message", () => resolve()); child.once("error", reject); }));
      done.push(new Promise((resolve, reject) => {
        child.on("message", message => { if (typeof message === "object" && message && "status" in message) resolve(message as { status: string; code?: string }); });
        child.once("error", reject);
        child.once("exit", code => { if (code !== 0) reject(new Error("Installer worker failed")); });
      }));
    }
    await Promise.all(ready);
    for (const child of children) child.send(f);
    const results = await Promise.all(done);
    assert.equal(results.filter(r => r.status === "installed").length, 1);
    assert.ok(results.every(r => r.status === "installed" || r.status === "already-installed" || r.code === "CONFIGURATION"));
    const after = await readFile(f.configPath, "utf8");
    assert.ok(after.startsWith(original));
    assert.equal(after.split("[mcp_servers.jev]").length, 2);
    assert.ok((parse(after).mcp_servers as Record<string, unknown>).jev);
    assert.deepEqual(await readdir(join(f.directory, "codex")), ["config.toml"]);
  } finally {
    for (const child of children) child.kill();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("setup wrapper previews offline and rejects invalid arguments without disclosing values or creating config", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-setup-cli-"));
  const config = join(directory, "config.toml");
  const secret = "synthetic-private-setup-marker";
  const run = (args: string[]) => execute(process.execPath, [join(root, "scripts/setup-codex.mjs"), ...args], {
    cwd: directory, env: { PATH: process.env.PATH ?? "", TYPESAFE_API_KEY: secret }, timeout: 10_000,
  });
  try {
    const plan = JSON.parse((await run(["--dry-run", "--config", config])).stdout);
    assert.equal(plan.mode, "plan");
    assert.equal(plan.configPath, config);
    assert.equal(plan.modelCalls, 0);
    assert.equal(JSON.stringify(plan).includes(secret), false);
    assert.equal(existsSync(config), false);
    for (const args of [["--unknown", secret], ["--config", ""], ["unexpected"], ["--config", config]]) {
      await assert.rejects(run(args), (error: unknown) => {
        assert.equal((error as { code: number }).code, 1);
        assert.equal((error as { stderr: string }).stderr.includes(secret), false);
        return true;
      });
    }
    assert.equal(existsSync(config), false);
    assert.equal(codexConfigPath(config), config);
    assert.throws(() => codexConfigPath(" "), { code: "INVALID_INPUT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

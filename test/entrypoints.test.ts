import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const rankInput = { task: "find validation", candidates: [{ id: "a", title: "a", content: "validate" }] };

test("CLI dry run works without key/database and rejects unsafe arguments", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-cli-"));
  const env = { PATH: process.env.PATH ?? "", TYPESAFE_API_KEY: "", JEV_DB_PATH: join(directory, "meta.sqlite") };
  const cli = (args: string[]) => execute(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: root, env, timeout: 15_000 });
  try {
    const dry = await cli(["run", "rank-candidates", "--input", "examples/rank-candidates.json", "--dry-run"]);
    assert.equal(JSON.parse(dry.stdout).dryRun, true);
    assert.equal(existsSync(env.JEV_DB_PATH), false);
    const linkedCli = join(directory, "jev");
    await symlink(join(root, "src/cli.ts"), linkedCli);
    const linkedResult = await execute(process.execPath, ["--import", "tsx", linkedCli, "doctor"], { cwd: root, env, timeout: 15_000 });
    assert.equal(JSON.parse(linkedResult.stdout).networkCallMade, false);
    const doctor = JSON.parse((await cli(["doctor"])).stdout);
    assert.equal(doctor.apiKeyPresent, false);
    assert.equal(doctor.networkCallMade, false);
    assert.equal(existsSync(env.JEV_DB_PATH), false);
    await assert.rejects(cli(["history", "--limit", "-1"]), (error: unknown) => {
      const result = error as { stderr: string; code: number };
      assert.equal(result.code, 1);
      assert.equal(JSON.parse(result.stderr.trim().split("\n").at(-1)!).error.code, "INVALID_INPUT");
      return true;
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("stdio MCP exercises SDK success/error, active and queued cancellation, then remains usable", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-mcp-boundary-"));
  const database = join(directory, "metadata.sqlite");
  const client = new Client({ name: "synthetic-boundary-test", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "test/fixtures/mcp-server.ts"], cwd: root,
    env: { PATH: process.env.PATH ?? "", TYPESAFE_API_KEY: "", JEV_DB_PATH: database }, stderr: "pipe" });
  const protocolErrors: Error[] = [];
  client.onerror = error => protocolErrors.push(error);
  let stderr = "";
  const watchers = new Map<string, () => void>();
  const waitFor = (marker: string) => stderr.includes(marker) ? Promise.resolve() : new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { watchers.delete(marker); reject(new Error(`Missing synthetic event: ${marker}`)); }, 5_000);
    watchers.set(marker, () => { clearTimeout(timer); watchers.delete(marker); resolve(); });
  });
  transport.stderr?.on("data", chunk => {
    stderr += String(chunk);
    for (const [marker, done] of watchers) if (stderr.includes(marker)) done();
  });
  try {
    await client.connect(transport);
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const calls = controllers.map(controller => client.callTool({ name: "jev_rank_candidates",
      arguments: { ...rankInput, task: "SYNTHETIC_DELAY" } }, undefined, { signal: controller.signal }));
    const settled = Promise.allSettled(calls);
    await waitFor("FETCH_STARTED:4");
    const queued = new AbortController();
    const waiting = client.callTool({ name: "jev_rank_candidates", arguments: { ...rankInput, task: "SYNTHETIC_DELAY" } }, undefined, { signal: queued.signal });
    const cancelled = assert.rejects(waiting);
    await client.ping(); // All preceding tool requests have reached their handlers.
    queued.abort();
    await cancelled;
    await client.ping();
    for (const controller of controllers) controller.abort();
    assert.equal((await settled).filter(r => r.status === "rejected").length, 4);
    await waitFor("FETCH_ABORTED:4");
    await client.ping();
    assert.equal(stderr.includes("FETCH_STARTED:5"), false); // Cancelled waiter never reaches fetch.
    const success = await client.callTool({ name: "jev_rank_candidates", arguments: rankInput });
    assert.notEqual(success.isError, true);
    const result = success.structuredContent as { run: { actualModel: string; requestId: string }; result: { candidates: unknown[] } };
    assert.equal(result.run.actualModel, "synthetic-mcp-fixed");
    assert.equal(result.run.requestId, "synthetic-mcp-request");
    assert.equal(result.result.candidates.length, 1);
    const failure = await client.callTool({ name: "jev_rank_candidates", arguments: { ...rankInput, task: "SYNTHETIC_ERROR" } });
    assert.equal(failure.isError, true);
    assert.match(JSON.stringify(failure.content), /AUTHENTICATION/);
    assert.equal(JSON.stringify(failure).includes("private synthetic"), false);
    assert.equal(stderr.includes("private synthetic"), false);
    const planned = await client.callTool({ name: "jev_run_recipe", arguments: { recipeId: "rank-candidates", input: rankInput, dryRun: true } });
    assert.equal((planned.structuredContent as { dryRun: boolean }).dryRun, true);
    assert.deepEqual(protocolErrors, []);
  } finally {
    await client.close();
    await transport.close();
    for (const done of watchers.values()) done();
    if (existsSync(database)) assert.equal(readFileSync(database).includes(Buffer.from("private synthetic")), false);
    await rm(directory, { recursive: true, force: true });
  }
});

test("real stdio MCP lists tools, plans offline and reports missing credentials", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-mcp-"));
  const database = join(directory, "meta.sqlite");
  const linkedMcp = join(directory, "jev-mcp");
  await symlink(join(root, "src/mcp.ts"), linkedMcp);
  const client = new Client({ name: "offline-test", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", linkedMcp], cwd: root,
    env: { PATH: process.env.PATH ?? "", TYPESAFE_API_KEY: "", TYPESAFE_LOG_LEVEL: "debug", JEV_DB_PATH: database }, stderr: "pipe" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["jev_rank_candidates", "jev_run_recipe", "jev_triage_failure", "jev_verify_claims"]);
    const dry = await client.callTool({ name: "jev_run_recipe", arguments: { recipeId: "rank-candidates", input: rankInput, dryRun: true } });
    assert.equal(dry.isError, undefined);
    assert.equal((dry.structuredContent as Record<string, unknown>).dryRun, true);
    assert.equal(existsSync(database), false);
    const live = await client.callTool({ name: "jev_rank_candidates", arguments: rankInput });
    assert.equal(live.isError, true);
    assert.match(JSON.stringify(live.content), /AUTHENTICATION/);
    const bad = await client.callTool({ name: "jev_rank_candidates", arguments: { task: "", candidates: [] } });
    assert.equal(bad.isError, true);
  } finally {
    await client.close();
    await transport.close();
    await rm(directory, { recursive: true, force: true });
  }
});

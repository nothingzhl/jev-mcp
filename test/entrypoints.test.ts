import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
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

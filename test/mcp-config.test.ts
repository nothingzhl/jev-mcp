import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { codexMcpConfig, forwardedEnvironment } from "../src/mcp-config.js";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

test("mcp-config prints absolute checkout paths from any cwd without keys, database or settings writes", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-config-"));
  const configFile = join(directory, ".codex-config-sentinel");
  const database = join(directory, "not-created.sqlite");
  const secret = "synthetic-private-config-value";
  const env = { PATH: process.env.PATH ?? "", TYPESAFE_API_KEY: "", JEV_DB_PATH: database,
    HTTPS_PROXY: secret, NODE_EXTRA_CA_CERTS: "", JEV_TIMEOUT_MS: secret };
  const cli = (args: string[], extraEnv = {}) => execute(process.execPath,
    ["--import", import.meta.resolve("tsx"), join(root, "src/cli.ts"), ...args],
    { cwd: directory, env: { ...env, ...extraEnv }, timeout: 10_000 });
  try {
    await writeFile(configFile, "keep existing configuration");
    const missingKey = await cli(["mcp-config"]);
    const withKey = await cli(["mcp-config"], { TYPESAFE_API_KEY: secret });
    assert.equal(missingKey.stdout, withKey.stdout);
    assert.equal(withKey.stdout.includes(secret), false);
    assert.equal(withKey.stderr.includes(secret), false);
    assert.equal(withKey.stdout, codexMcpConfig(root, process.execPath));
    assert.equal(existsSync(database), false);
    assert.equal(await readFile(configFile, "utf8"), "keep existing configuration");
    for (const args of [["mcp-config", "--save"], ["mcp-config", "--input", configFile], ["mcp-config", "extra"]]) {
      await assert.rejects(cli(args), (error: unknown) => {
        const result = error as { code: number; stderr: string };
        assert.equal(result.code, 1);
        assert.equal(JSON.parse(result.stderr.trim().split("\n").at(-1)!).error.code, "INVALID_INPUT");
        assert.equal(result.stderr.includes(secret), false);
        return true;
      });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("generated MCP fields escape spaces and quotes, forward proxy/trust names, and agree with the portable example", async () => {
  const checkout = join(tmpdir(), 'jev "quoted" checkout');
  const node = join(tmpdir(), 'node "runtime"');
  const config = codexMcpConfig(checkout, node);
  const field = (name: string) => JSON.parse(config.split("\n").find(line => line.startsWith(`${name} = `))!.split(" = ").slice(1).join(" = ")) as unknown;
  assert.equal(field("command"), node);
  assert.equal(field("cwd"), resolve(checkout));
  assert.deepEqual(field("args"), [join(checkout, "dist/mcp.js")]);
  assert.deepEqual(field("env_vars"), forwardedEnvironment);
  for (const name of ["TYPESAFE_API_KEY", "NODE_USE_ENV_PROXY", "HTTPS_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"]) {
    assert.ok(forwardedEnvironment.includes(name as typeof forwardedEnvironment[number]));
  }
  assert.equal(config.includes("[mcp_servers.jev.env]"), false);
  const example = await readFile(join(root, "examples/codex-config.toml"), "utf8");
  assert.deepEqual(JSON.parse(example.split("\n").find(line => line.startsWith("env_vars = "))!.slice("env_vars = ".length)),
    forwardedEnvironment);
});

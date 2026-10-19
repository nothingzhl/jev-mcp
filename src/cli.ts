#!/usr/bin/env node
import { parseArgs } from "node:util";
import { isMain } from "./entrypoint.js";
import { createApplication } from "./application.js";
import { JevError, safeError } from "./core/errors.js";

const help = `jev-mcp — local TypeSafe Jev tools

jev recipes
jev doctor
jev run <recipe-id> --input <file.json|-> [--dry-run]
jev history [--limit 20]
jev serve

run sends the supplied material to TypeSafe unless --dry-run is present.
Set TYPESAFE_API_KEY in the server environment; never pass it as an argument.
Available examples: examples/rank-candidates.json, verify-claims.json, triage-failure.json.
`;

export async function main(args = process.argv.slice(2)): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {
      input: { type: "string" }, "dry-run": { type: "boolean" }, limit: { type: "string" },
      help: { type: "boolean", short: "h" },
    } });
  } catch {
    throw new JevError("INVALID_INPUT", "Invalid command arguments; run jev --help.");
  }
  const { values, positionals } = parsed;
  if (values.help || positionals.length === 0) { process.stdout.write(help); return; }
  const [command, recipeId] = positionals;
  const commandOptions: Record<string, string[]> = { recipes: [], doctor: [], run: ["input", "dry-run"], history: ["limit"], serve: [] };
  if (!command || !Object.hasOwn(commandOptions, command) || positionals.length !== (command === "run" ? 2 : 1)
    || Object.keys(values).some((option) => !commandOptions[command]?.includes(option))) {
    throw new JevError("INVALID_INPUT", "Invalid command or options; run jev --help.");
  }
  if (command === "serve") {
    const { startMcp } = await import("./mcp.js");
    await startMcp();
    return;
  }
  const app = createApplication();
  const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  try {
    if (command === "recipes") { print(app.service.recipes()); return; }
    if (command === "doctor") {
      print({ node: process.versions.node, apiKeyPresent: Boolean(process.env.TYPESAFE_API_KEY?.trim()),
        model: app.config.model, persistence: "SQLite metadata only", networkCallMade: false });
      return;
    }
    if (command === "history") {
      const limit = values.limit === undefined ? 20 : Number(values.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new JevError("INVALID_INPUT", "History limit must be 1..1000.");
      print(app.getStore().listRuns(limit));
      return;
    }
    if (!recipeId || typeof values.input !== "string") throw new JevError("INVALID_INPUT", "run requires a recipe ID and --input JSON file (or - for stdin).");
    let input: unknown;
    try {
      // Bound reads before parsing; no implicit repo scanning or file discovery.
      const source = values.input === "-" ? process.stdin : (await import("node:fs")).createReadStream(values.input);
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 1024 * 1024) { source.destroy(); throw new Error("too large"); }
        chunks.push(buffer);
      }
      input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new JevError("INVALID_INPUT", "Cannot read input: use valid UTF-8 JSON smaller than 1 MiB.");
    }
    if (values["dry-run"]) { print({ dryRun: true, ...app.service.plan(recipeId, input) }); return; }
    print(await app.service.run(recipeId, input));
  } finally { app.close(); }
}

if (isMain(import.meta.url)) {
  main().catch((error: unknown) => { process.stderr.write(`${JSON.stringify({ error: safeError(error) })}\n`); process.exitCode = 1; });
}

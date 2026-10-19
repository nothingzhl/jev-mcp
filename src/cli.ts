#!/usr/bin/env node
import { parseArgs } from "node:util";
import { isMain } from "./entrypoint.js";
import { createApplication } from "./application.js";
import { readConfig } from "./config.js";
import { JevError, safeError } from "./core/errors.js";
import { readText, parseJson } from "./io.js";
import { parseSuiteText } from "./evaluation/suite.js";
import { compareReports } from "./evaluation/report.js";
import { evaluateLive, evaluatePredictions, parsePredictions, planEvaluation } from "./evaluation/runner.js";

const help = `jev-mcp — local TypeSafe Jev tools

jev recipes
jev doctor
jev run <recipe-id> --input <file.json|-> [--dry-run]
jev history [--limit 20]
jev evaluate --suite <file.json|file.jsonl|-> [--max-samples N] [--model NAME]
jev evaluate --suite <file> --predictions <file> [--max-samples N] [--save]
jev evaluate --suite <file> --live --max-samples N --max-requests N [--model NAME] [--save]
jev evaluations [--limit 20]
jev compare --left <report.json> --right <report.json>
jev serve

run sends the supplied material to TypeSafe unless --dry-run is present.
Set TYPESAFE_API_KEY in the server environment; never pass it as an argument.
Available examples: examples/rank-candidates.json, verify-claims.json, triage-failure.json.
evaluate defaults to validating samples and plans, without quality metrics or a database.
Prediction files explicitly distinguish synthetic fixtures from recorded responses.
live requires separate task authorization; max-requests includes worst-case SDK retries.
`;

function positive(value: string | undefined, name: string, max: number): number {
  if (value === undefined || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max) {
    throw new JevError("INVALID_INPUT", `${name} must be an integer between 1 and ${max}.`);
  }
  return Number(value);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const parse = () => parseArgs({ args, allowPositionals: true, strict: true, options: {
      input: { type: "string" }, "dry-run": { type: "boolean" }, limit: { type: "string" },
      help: { type: "boolean", short: "h" },
      suite: { type: "string" }, predictions: { type: "string" }, live: { type: "boolean" },
      "max-samples": { type: "string" }, "max-requests": { type: "string" },
      model: { type: "string" }, save: { type: "boolean" }, left: { type: "string" }, right: { type: "string" },
    } });
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse();
  } catch {
    throw new JevError("INVALID_INPUT", "Invalid command arguments; run jev --help.");
  }
  const { values, positionals } = parsed;
  if (values.help || positionals.length === 0) { process.stdout.write(help); return; }
  const [command, recipeId] = positionals;
  const commandOptions: Record<string, string[]> = { recipes: [], doctor: [], run: ["input", "dry-run"], history: ["limit"], serve: [],
    evaluate: ["suite", "predictions", "live", "max-samples", "max-requests", "model", "save"],
    evaluations: ["limit"], compare: ["left", "right"] };
  if (!command || !Object.hasOwn(commandOptions, command) || positionals.length !== (command === "run" ? 2 : 1)
    || Object.keys(values).some((option) => !commandOptions[command]?.includes(option))) {
    throw new JevError("INVALID_INPUT", "Invalid command or options; run jev --help.");
  }
  if (command === "serve") {
    const { startMcp } = await import("./mcp.js");
    await startMcp();
    return;
  }
  const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  if (command === "compare") {
    if (!values.left || !values.right || (values.left === "-" && values.right === "-")) {
      throw new JevError("INVALID_INPUT", "compare requires --left and --right reports; at most one may use stdin.");
    }
    const left = parseJson(await readText(values.left));
    const right = parseJson(await readText(values.right));
    print(compareReports(left, right));
    return;
  }
  if (command === "evaluate") {
    if (!values.suite || (values.live && values.predictions) || (!values.live && values["max-requests"] !== undefined)
      || (!values.live && !values.predictions && values.save) || (values.suite === "-" && values.predictions === "-")) {
      throw new JevError("INVALID_INPUT", "evaluate requires --suite and one mode: plan (default), --predictions, or --live with explicit limits. --save requires predictions or live; at most one input may use stdin.");
    }
    const maxSamples = values["max-samples"] === undefined && !values.live ? undefined
      : positive(values["max-samples"], "max-samples", 1_000);
    const maxRequests = values.live ? positive(values["max-requests"], "max-requests", 4_000) : undefined;
    const suite = parseSuiteText(await readText(values.suite, 10 * 1024 * 1024));
    const predictions = values.predictions ? parsePredictions(parseJson(await readText(values.predictions, 10 * 1024 * 1024))) : undefined;
    const model = values.model ?? predictions?.requestedModel;
    const config = readConfig({ ...process.env, ...(model === undefined ? {} : { JEV_MODEL: model }) });
    const app = createApplication(config);
    try {
      if (!values.live && !predictions) { print(planEvaluation(suite, app.service, maxSamples)); return; }
      if (values.live && !process.env.TYPESAFE_API_KEY?.trim()) {
        throw new JevError("AUTHENTICATION", "Set TYPESAFE_API_KEY in the service environment before live evaluation.");
      }
      const report = predictions ? evaluatePredictions(suite, predictions, app.service, maxSamples)
        : await evaluateLive(suite, app.service, { maxSamples: maxSamples!, maxRequests: maxRequests!, maxRetries: config.maxRetries });
      if (values.save) app.getStore().recordReport(report);
      print(report);
      if (report.failedSamples > 0) process.exitCode = 1;
      return;
    } finally { app.close(); }
  }
  const app = createApplication();
  try {
    if (command === "recipes") { print(app.service.recipes()); return; }
    if (command === "doctor") {
      print({ node: process.versions.node, apiKeyPresent: Boolean(process.env.TYPESAFE_API_KEY?.trim()),
        model: app.config.model, persistence: "SQLite metadata only", networkCallMade: false });
      return;
    }
    if (command === "history" || command === "evaluations") {
      const limit = values.limit === undefined ? 20 : positive(values.limit, "limit", 1_000);
      print(command === "history" ? app.getStore().listRuns(limit) : app.getStore().listReports(limit));
      return;
    }
    if (!recipeId || typeof values.input !== "string") throw new JevError("INVALID_INPUT", "run requires a recipe ID and --input JSON file (or - for stdin).");
    const input = parseJson(await readText(values.input));
    if (values["dry-run"]) { print({ dryRun: true, ...app.service.plan(recipeId, input) }); return; }
    print(await app.service.run(recipeId, input));
  } finally { app.close(); }
}

if (isMain(import.meta.url)) {
  main().catch((error: unknown) => { process.stderr.write(`${JSON.stringify({ error: safeError(error) })}\n`); process.exitCode = 1; });
}

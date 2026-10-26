#!/usr/bin/env node

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_COMMAND = 4_000;
const MAX_LOG = 100_000;
const MAX_SUMMARY = 10_000;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    process.stdin.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_INPUT_BYTES) {
        reject(new Error("hook input exceeds 1 MiB"));
        process.stdin.destroy();
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.once("error", reject);
  });
}

export function parseInput(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("hook input must be valid UTF-8 JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("hook input must be a JSON object");
  const command = value.command;
  const log = value.log;
  const changeSummary = value.changeSummary;
  if (typeof command !== "string" || command.trim() === "" || command.length > MAX_COMMAND) {
    throw new Error("command is required and must be at most 4,000 characters");
  }
  if (typeof log !== "string" || log.trim() === "" || log.length > MAX_LOG) {
    throw new Error("log is required and must be at most 100,000 characters");
  }
  if (changeSummary !== undefined && (typeof changeSummary !== "string" || changeSummary.length > MAX_SUMMARY)) {
    throw new Error("changeSummary must be a string of at most 10,000 characters");
  }
  return changeSummary === undefined ? { command, log } : { command, log, changeSummary };
}

export function dryRunResult() {
  return { category: "unknown", evidenceSufficient: false, requiresReview: true, reviewReason: "dry_run_requires_explicit_live_flag" };
}

function printReview(category = "unknown", evidenceSufficient = false, reason = "manual_review_required") {
  process.stdout.write(`${JSON.stringify({ category, evidenceSufficient, requiresReview: true, reviewReason: reason })}\n`);
}

async function runLive(input) {
  const cli = process.env.JEV_CLI ?? "jev";
  const child = spawn(cli, ["run", "triage-failure", "--input", "-"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.end(JSON.stringify(input));
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (exitCode !== 0) throw new Error(Buffer.concat(stderr).toString("utf8").trim() || `jev exited with code ${exitCode}`);
  let output;
  try { output = JSON.parse(Buffer.concat(stdout).toString("utf8")); } catch { throw new Error("jev returned invalid JSON"); }
  const result = output?.result;
  if (!result || typeof result !== "object") throw new Error("jev response did not contain a triage result");
  process.stdout.write(`${JSON.stringify({
    category: result.category,
    evidenceSufficient: result.evidenceSufficient,
    requiresReview: result.requiresReview,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = parseInput(await readStdin());
    if (process.argv.includes("--live")) await runLive(input);
    else printReview("unknown", false, "dry_run_requires_explicit_live_flag");
  } catch (error) {
    fail(error instanceof Error ? error.message : "invalid hook input");
  }
}


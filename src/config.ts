import { resolve } from "node:path";
import { JevError } from "./core/errors.js";

export interface Config {
  model: string;
  dbPath: string;
  timeoutMs: number;
  maxRetries: number;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const value = env[name];
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
    throw new JevError("CONFIGURATION", `${name} must be an integer between ${min} and ${max}.`);
  }
  return Number(value);
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const model = env.JEV_MODEL ?? "jev-latest";
  const dbPath = env.JEV_DB_PATH ?? ".data/jev.sqlite";
  if (!model.trim() || model.length > 200 || !dbPath.trim()) {
    throw new JevError("CONFIGURATION", "JEV_MODEL and JEV_DB_PATH must be non-empty.");
  }
  return {
    model,
    dbPath: dbPath === ":memory:" ? dbPath : resolve(dbPath),
    timeoutMs: integer(env, "JEV_TIMEOUT_MS", 30_000, 100, 120_000),
    maxRetries: integer(env, "JEV_MAX_RETRIES", 1, 0, 3),
  };
}

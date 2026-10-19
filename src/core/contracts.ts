import type { ZodType } from "zod";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type Content = string | JsonValue[] | { [key: string]: JsonValue };

export type Question =
  | { type: "choice"; instructions: Content; criteria: Record<string, Content | null> }
  | { type: "score"; instructions: Content; criteria: Content[] }
  | { type: "noul"; instructions: Content; criteria?: { true?: Content; false?: Content } };

export type Answer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; legend: Record<string, Content>; probabilities: Record<string, number>; confidence: number }
  | { type: "noul"; noul: number };

export interface EvaluationRequest {
  model: string;
  state: Content;
  questions: Record<string, Question>;
}

export interface EvaluationResponse {
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number | null; output_tokens: number | null };
  requestId: string | null;
}

export interface EvaluationProvider {
  evaluate(request: EvaluationRequest, signal?: AbortSignal): Promise<EvaluationResponse>;
}

// A recipe owns its input schema, questions, thresholds and local result mapping.
// Recipe implementations parse unknown values at their own boundary.
export interface Recipe {
  id: string;
  version: string;
  description: string;
  inputSchema: ZodType;
  prepare(input: unknown): { state: Content; questions: Record<string, Question> };
  interpret(input: unknown, response: EvaluationResponse): JsonValue;
}

export interface RunRecord {
  id: string;
  recipeId: string;
  recipeVersion: string;
  requestedModel: string;
  actualModel: string | null;
  startedAt: string;
  durationMs: number;
  status: "success" | "error";
  questionCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  requestId: string | null;
  errorCode: string | null;
}

export interface EvaluationRecord {
  id: string;
  suite: string;
  recipeId: string;
  recipeVersion: string;
  model: string;
  createdAt: string;
  total: number;
  passed: number;
}

// Deliberately cannot accept state, answers, code, logs or credentials.
export interface RunStore {
  recordRun(record: RunRecord): void;
  listRuns(limit?: number): RunRecord[];
  recordEvaluation(record: EvaluationRecord): void;
  listEvaluations(limit?: number): EvaluationRecord[];
  close(): void;
}

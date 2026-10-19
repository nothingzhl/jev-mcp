import type { EvaluationRequest } from "../../src/core/contracts.js";
import { readConfig } from "../../src/config.js";
import { JudgmentService } from "../../src/core/service.js";
import { createMcpServer } from "../../src/mcp.js";
import { TypeSafeProvider } from "../../src/providers/typesafe.js";
import { SqliteRunStore } from "../../src/storage/sqlite.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { zstdDecompressSync } from "node:zlib";

const config = { ...readConfig(), timeoutMs: 10_000, maxRetries: 0 };
let store: SqliteRunStore | undefined;
let starts = 0;
let aborts = 0;
const provider = new TypeSafeProvider(config, { apiKey: "synthetic-test-key", fetch: async (_, init) => {
  // SDK 0.7.0 compresses JSON >= 1024 bytes with zstd on supported Node versions.
  const body = new Headers(init?.headers).get("content-encoding") === "zstd"
    ? zstdDecompressSync(init!.body as Uint8Array).toString("utf8") : String(init?.body);
  const request = JSON.parse(body) as EvaluationRequest;
  const state = request.state as { task?: string };
  if (state.task === "SYNTHETIC_DELAY") {
    process.stderr.write(`FETCH_STARTED:${++starts}\n`);
    return new Promise<Response>((_, reject) => {
      const abort = () => {
        process.stderr.write(`FETCH_ABORTED:${++aborts}\n`);
        reject(new DOMException("private synthetic abort body", "AbortError"));
      };
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    });
  }
  if (state.task === "SYNTHETIC_ERROR") {
    return Response.json({ error: "private synthetic upstream body" }, { status: 401 });
  }
  return Response.json({ model: "synthetic-mcp-fixed", usage: { input_tokens: 10, output_tokens: 3 },
    answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
      if (question.type === "noul") return [id, { type: "noul", noul: .95 }];
      if (question.type === "choice") {
        const choice = Object.hasOwn(question.criteria, "supported") ? "supported" : "environment";
        return [id, { type: "choice", choice, confidence: .95,
          probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === choice)])) }];
      }
      const last = question.criteria.length - 1;
      return [id, { type: "score", score: last, confidence: .95,
        legend: Object.fromEntries(question.criteria.map((level, i) => [String(i), level])),
        probabilities: Object.fromEntries(question.criteria.map((_, i) => [String(i), Number(i === last)])) }];
    })) }, { headers: { "x-typesafe-request-id": "synthetic-mcp-request" } });
} });
const service = new JudgmentService({ config, provider: () => provider,
  store: () => store ??= new SqliteRunStore(config.dbPath) });
const server = createMcpServer(service);
server.server.onclose = () => store?.close();
await server.connect(new StdioServerTransport());

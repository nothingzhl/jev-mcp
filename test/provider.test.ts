import assert from "node:assert/strict";
import { test } from "node:test";
import type { Config } from "../src/config.js";
import type { EvaluationRequest } from "../src/core/contracts.js";
import { JevError } from "../src/core/errors.js";
import { TypeSafeProvider } from "../src/providers/typesafe.js";

const config: Config = { model: "jev-latest", dbPath: ":memory:", timeoutMs: 1_000, maxRetries: 0 };
const request: EvaluationRequest = {
  model: "jev-latest",
  state: { candidate: "Synthetic candidate" },
  questions: {
    fit: { type: "score", instructions: "How relevant?", criteria: ["Unrelated", "Relevant"] },
    route: { type: "choice", instructions: "Which route?", criteria: { review: null, skip: null } },
    ready: { type: "noul", instructions: "Is it ready?" },
  },
};

function validResponse() {
  return {
    model: "jev-1.13.0",
    answers: {
      fit: { type: "score", score: 0.75, legend: { "0": "Unrelated", "1": "Relevant" }, probabilities: { "0": 0.25, "1": 0.75 }, confidence: 0.4 },
      route: { type: "choice", choice: "review", probabilities: { review: 0.8, skip: 0.2 }, confidence: 0.5 },
      ready: { type: "noul", noul: 0.8 },
    },
    usage: { input_tokens: 20 as number | null, output_tokens: 5 as number | null },
  };
}

function jsonFetch(body: unknown, status = 200, headers: Record<string, string> = {}): typeof globalThis.fetch {
  return async () => Response.json(body, { status, headers });
}

test("provider sends only model/state/questions and retains actual model, request ID and nullable usage", async () => {
  const originalBaseURL = process.env.TYPESAFE_BASE_URL;
  process.env.TYPESAFE_BASE_URL = "https://untrusted.invalid";
  try {
    let calls = 0;
    const data = validResponse();
    data.usage.input_tokens = null;
    data.usage.output_tokens = null;
    const provider = new TypeSafeProvider(config, {
      apiKey: "synthetic-test-key",
      fetch: async (url, init) => {
        calls++;
        assert.equal(String(url), "https://api.typesafe.ai/v1/systemone");
        assert.equal(init?.method, "POST");
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-test-key");
        assert.deepEqual(JSON.parse(String(init?.body)), request);
        return Response.json(data, { headers: { "x-typesafe-request-id": "req-synthetic" } });
      },
    });
    const result = await provider.evaluate({ ...request, recipeId: "local-only", apiKey: "do-not-send" } as EvaluationRequest);
    assert.equal(calls, 1);
    assert.deepEqual(result, { ...data, requestId: "req-synthetic" });
  } finally {
    if (originalBaseURL === undefined) delete process.env.TYPESAFE_BASE_URL;
    else process.env.TYPESAFE_BASE_URL = originalBaseURL;
  }
});

test("provider maps a missing response request ID to null", async () => {
  const provider = new TypeSafeProvider(config, { apiKey: "test", fetch: jsonFetch(validResponse()) });
  assert.equal((await provider.evaluate(request)).requestId, null);
});

test("provider safely reports authentication errors without upstream bodies or credentials", async () => {
  const secret = "synthetic-sensitive-marker";
  const provider = new TypeSafeProvider(config, { apiKey: secret, fetch: jsonFetch({ error: secret }, 401) });
  await assert.rejects(provider.evaluate(request), (error: unknown) => {
    assert.ok(error instanceof JevError);
    assert.equal(error.code, "AUTHENTICATION");
    assert.ok(!JSON.stringify(error).includes(secret));
    assert.ok(!String(error).includes(secret));
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("provider safely reports connection failures", async () => {
  const secret = "synthetic-sensitive-marker";
  const provider = new TypeSafeProvider(config, { apiKey: "test", fetch: async () => { throw new Error(secret); } });
  await assert.rejects(provider.evaluate(request), (error: unknown) => {
    assert.ok(error instanceof JevError);
    assert.equal(error.code, "CONNECTION");
    assert.ok(!String(error).includes(secret));
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("overall timeout cancels an active fetch", async () => {
  let aborted = false;
  const provider = new TypeSafeProvider({ ...config, timeoutMs: 25 }, {
    apiKey: "test",
    fetch: async (_, init) => new Promise<Response>((_, reject) => {
      const signal = init!.signal!;
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("synthetic upstream detail", "AbortError"));
      }, { once: true });
    }),
  });
  await assert.rejects(provider.evaluate(request), (error: unknown) => error instanceof JevError && error.code === "TIMEOUT");
  assert.equal(aborted, true);
});

test("overall timeout bounds SDK retry backoff and prevents another attempt", async () => {
  let calls = 0;
  const provider = new TypeSafeProvider({ ...config, timeoutMs: 30, maxRetries: 3 }, {
    apiKey: "test",
    fetch: async () => {
      calls++;
      return Response.json({ error: "synthetic private detail" }, { status: 429, headers: { "retry-after": "30" } });
    },
  });
  const started = Date.now();
  await assert.rejects(provider.evaluate(request), (error: unknown) => error instanceof JevError && error.code === "TIMEOUT");
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 1_000);
});

test("SDK performs retries once with no outer retry loop", async () => {
  let calls = 0;
  const provider = new TypeSafeProvider({ ...config, maxRetries: 1 }, {
    apiKey: "test",
    fetch: async () => {
      calls++;
      return Response.json({ error: "synthetic private detail" }, { status: 429, headers: { "retry-after-ms": "1" } });
    },
  });
  await assert.rejects(provider.evaluate(request), (error: unknown) => error instanceof JevError && error.code === "RATE_LIMIT");
  assert.equal(calls, 2);
});

test("malformed response shapes and distributions become INVALID_RESPONSE", async (t) => {
  const cases: Record<string, (data: ReturnType<typeof validResponse>) => unknown> = {
    "non-object body": () => "synthetic-private-response",
    "missing answer": (data) => { const { ready: _, ...rest } = data.answers; return { ...data, answers: rest }; },
    "extra answer": (data) => ({ ...data, answers: { ...data.answers, extra: { type: "noul", noul: 0.2 } } }),
    "wrong primitive": (data) => ({ ...data, answers: { ...data.answers, ready: { type: "choice", noul: 0.8 } } }),
    "invalid noul": (data) => ({ ...data, answers: { ...data.answers, ready: { type: "noul", noul: 1.2 } } }),
    "unknown choice": (data) => ({ ...data, answers: { ...data.answers, route: { ...data.answers.route, choice: "unknown" } } }),
    "choice is not the most probable": (data) => ({ ...data, answers: { ...data.answers, route: { ...data.answers.route, choice: "skip" } } }),
    "incomplete distribution": (data) => ({ ...data, answers: { ...data.answers, route: { ...data.answers.route, probabilities: { review: 1 } } } }),
    "distribution does not sum to one": (data) => ({ ...data, answers: { ...data.answers, route: { ...data.answers.route, probabilities: { review: 0.2, skip: 0.2 } } } }),
    "out of range confidence": (data) => ({ ...data, answers: { ...data.answers, route: { ...data.answers.route, confidence: -0.1 } } }),
    "negative distribution value": (data) => ({ ...data, answers: { ...data.answers, fit: { ...data.answers.fit, probabilities: { "0": -0.2, "1": 1.2 } } } }),
    "out of range score": (data) => ({ ...data, answers: { ...data.answers, fit: { ...data.answers.fit, score: 2 } } }),
    "score contradicts distribution": (data) => ({ ...data, answers: { ...data.answers, fit: { ...data.answers.fit, score: 0 } } }),
    "mismatched legend": (data) => ({ ...data, answers: { ...data.answers, fit: { ...data.answers.fit, legend: { "0": "Wrong", "1": "Relevant" } } } }),
    "array instead of legend map": (data) => ({ ...data, answers: { ...data.answers, fit: { ...data.answers.fit, legend: ["Unrelated", "Relevant"] } } }),
    "invalid usage": (data) => ({ ...data, usage: { input_tokens: -1, output_tokens: 0 } }),
    "missing usage": (data) => { const { usage: _, ...rest } = data; return rest; },
    "missing actual model": (data) => ({ ...data, model: "" }),
  };
  for (const [name, modify] of Object.entries(cases)) {
    await t.test(name, async () => {
      const provider = new TypeSafeProvider(config, { apiKey: "test", fetch: jsonFetch(modify(validResponse())) });
      await assert.rejects(provider.evaluate(request), (error: unknown) => {
        assert.ok(error instanceof JevError);
        assert.equal(error.code, "INVALID_RESPONSE");
        assert.ok(!String(error).includes("synthetic-private-response"));
        return true;
      });
    });
  }
});

test("provider logging stays silent even if SDK debug logging is enabled in the environment", async () => {
  const original = process.env.TYPESAFE_LOG_LEVEL;
  process.env.TYPESAFE_LOG_LEVEL = "debug";
  const messages: unknown[][] = [];
  const methods = ["log", "debug", "info", "warn", "error"] as const;
  const saved = Object.fromEntries(methods.map((name) => [name, console[name]]));
  try {
    for (const name of methods) console[name] = (...args: unknown[]) => { messages.push(args); };
    const provider = new TypeSafeProvider(config, { apiKey: "test", fetch: jsonFetch(validResponse()) });
    await provider.evaluate(request);
    assert.deepEqual(messages, []);
  } finally {
    for (const name of methods) console[name] = saved[name] as typeof console.log;
    if (original === undefined) delete process.env.TYPESAFE_LOG_LEVEL;
    else process.env.TYPESAFE_LOG_LEVEL = original;
  }
});

import { SqliteRunStore } from "../../src/storage/sqlite.js";

// IPC barrier makes independent processes contend on the same uninitialized DB.
process.once("message", () => {
  try {
    const store = new SqliteRunStore(process.argv[2]!);
    store.recordRun({ id: `worker-${process.pid}`, recipeId: "rank-candidates", recipeVersion: "1.0.0",
      requestedModel: "synthetic", actualModel: null, startedAt: new Date().toISOString(), durationMs: 0,
      status: "error", questionCount: 1, inputTokens: null, outputTokens: null, requestId: null, errorCode: "TIMEOUT" });
    store.close();
    process.disconnect();
  } catch {
    process.exitCode = 1;
    process.stderr.write("Synthetic SQLite initialization failed.\n");
    process.disconnect();
  }
});
process.send?.("ready");

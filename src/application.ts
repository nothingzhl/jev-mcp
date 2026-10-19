import { readConfig, type Config } from "./config.js";
import { JudgmentService } from "./core/service.js";
import { TypeSafeProvider } from "./providers/typesafe.js";
import { SqliteRunStore } from "./storage/sqlite.js";

// Lazy dependencies: listing schemas and dry runs require neither a key nor a DB.
export function createApplication(config: Config = readConfig()) {
  let provider: TypeSafeProvider | undefined;
  let store: SqliteRunStore | undefined;
  const getStore = () => store ??= new SqliteRunStore(config.dbPath);
  const service = new JudgmentService({
    config,
    provider: () => provider ??= new TypeSafeProvider(config),
    store: getStore,
  });
  return { config, service, getStore, close: () => store?.close() };
}

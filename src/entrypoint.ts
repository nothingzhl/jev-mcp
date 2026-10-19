import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

// npm's bin links preserve the symlink in argv[1], while ESM resolves it in import.meta.url.
export function isMain(moduleUrl: string): boolean {
  try { return Boolean(process.argv[1]) && moduleUrl === pathToFileURL(realpathSync(process.argv[1]!)).href; }
  catch { return false; }
}

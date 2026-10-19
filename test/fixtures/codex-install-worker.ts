import { installCodex } from "../../src/codex-install.js";
import { safeError } from "../../src/core/errors.js";
process.send?.({ ready: true });
process.once("message", async (options: Parameters<typeof installCodex>[0]) => {
  try { process.send?.(await installCodex(options)); }
  catch (error) { process.send?.({ status: "error", code: safeError(error).code }); }
  finally { process.disconnect(); }
});

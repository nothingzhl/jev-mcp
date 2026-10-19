import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";
import { JevError } from "./core/errors.js";
import { codexMcpConfig } from "./mcp-config.js";

const maximumBytes = 1024 * 1024;
type Snapshot = { bytes: Buffer; mode: number; ino: number; dev: number };

export function codexConfigPath(explicit?: string): string {
  if (explicit !== undefined && !explicit.trim()) throw new JevError("INVALID_INPUT", "config must be a nonempty file path.");
  return resolve(explicit ?? resolve(process.env.CODEX_HOME || resolve(homedir(), ".codex"), "config.toml"));
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseConfig(bytes: Buffer) {
  try { return parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new JevError("CONFIGURATION", "Codex config is not valid UTF-8 TOML; the existing file was preserved."); }
}

async function snapshot(path: string): Promise<Snapshot | undefined> {
  try {
    const kind = await lstat(path);
    if (kind.isSymbolicLink()) throw new JevError("CONFIGURATION", "Codex config is a symbolic link; review its target manually.");
    if (!kind.isFile()) throw new JevError("CONFIGURATION", "Codex config must be a regular file.");
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > maximumBytes) throw new JevError("CONFIGURATION", "Codex config must be a regular file no larger than 1 MiB.");
      const bytes = await file.readFile();
      if (bytes.length > maximumBytes) throw new JevError("CONFIGURATION", "Codex config exceeds 1 MiB.");
      return { bytes, mode: info.mode & 0o777, ino: info.ino, dev: info.dev };
    } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function addition(before: Snapshot | undefined, generated: string): Buffer | undefined {
  const parsed = parseConfig(before?.bytes ?? Buffer.alloc(0));
  const servers = parsed.mcp_servers;
  if (servers !== undefined && !object(servers)) throw new JevError("CONFIGURATION", "Existing mcp_servers is not a table; the config was preserved.");
  if (servers && Object.hasOwn(servers, "jev")) {
    const desired = parse(generated).mcp_servers;
    if (object(desired) && isDeepStrictEqual(servers.jev, desired.jev)) return undefined;
    throw new JevError("CONFIGURATION", "A different jev configuration already exists; preserved it. Review that table before choosing a registration.");
  }
  const prefix = before?.bytes ?? Buffer.alloc(0);
  const separator = prefix.length ? (prefix.at(-1) === 10 ? "\n" : "\n\n") : "";
  const candidate = Buffer.concat([prefix, Buffer.from(separator + generated)]);
  if (candidate.length > maximumBytes) throw new JevError("CONFIGURATION", "Adding Jev would exceed the config size limit; the existing file was preserved.");
  // Inline/sealed tables or other unusual structures must never yield invalid output.
  parseConfig(candidate);
  return candidate;
}

export async function installCodex(options: { configPath: string; projectRoot: string; nodeCommand: string; dryRun?: boolean }) {
  const path = resolve(options.configPath);
  // Keep the default metadata DB writable even when the package itself is read-only.
  const generated = codexMcpConfig(options.projectRoot, options.nodeCommand, dirname(path));
  const result = (status: "installed" | "already-installed" | "planned") => ({ status, configPath: path,
    server: "jev", credentialValuesAdded: false, networkCallMade: false });
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  let temporary: string | undefined;
  try {
    if (!(await stat(resolve(options.projectRoot, "dist/mcp.js"))).isFile()) throw new Error("Missing build");
    if (options.dryRun) return result(addition(await snapshot(path), generated) ? "planned" : "already-installed");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try { lock = await open(path + ".jev.lock", "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new JevError("CONFIGURATION", "Another Jev installer holds the config lock; the config was preserved.");
      throw error;
    }
    const before = await snapshot(path);
    const candidate = addition(before, generated);
    if (!candidate) return result("already-installed");
    temporary = path + ".jev-" + randomUUID() + ".tmp";
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(candidate);
      await file.chmod(before?.mode ?? 0o600);
      await file.sync();
    } finally { await file.close(); }
    const current = await snapshot(path);
    if (before ? !current || before.ino !== current.ino || before.dev !== current.dev || !before.bytes.equals(current.bytes) : current) {
      throw new JevError("CONFIGURATION", "Codex config changed during installation; retry after the other editor finishes.");
    }
    if (before) await rename(temporary, path);
    else await link(temporary, path); // Atomic create, never replace a newly created config.
    return result("installed");
  } catch (error) {
    if (error instanceof JevError) throw error;
    throw new JevError("CONFIGURATION", "Could not register Jev. Check the built dist/mcp.js file and target config permissions.");
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
    if (lock) { await lock.close(); await unlink(path + ".jev.lock").catch(() => {}); }
  }
}

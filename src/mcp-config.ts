import { resolve } from "node:path";

// Names only: values remain in the Codex process environment and never enter TOML.
export const forwardedEnvironment = [
  "TYPESAFE_API_KEY", "JEV_MODEL", "JEV_DB_PATH", "JEV_TIMEOUT_MS", "JEV_MAX_RETRIES",
  "NODE_USE_ENV_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_USE_SYSTEM_CA",
] as const;

export function codexMcpConfig(projectRoot: string, nodeCommand: string, workingDirectory = projectRoot): string {
  // JSON basic strings/arrays use the same escaping needed by these TOML fields.
  const quote = (value: string) => JSON.stringify(value);
  return [
    "# Generated for this machine. The referenced compiled MCP entry must exist.",
    "# Merge this table into your Codex config; preserve other servers and existing jev settings.",
    "[mcp_servers.jev]",
    `command = ${quote(nodeCommand)}`,
    `args = ${JSON.stringify([resolve(projectRoot, "dist/mcp.js")])}`,
    `cwd = ${quote(resolve(workingDirectory))}`,
    `env_vars = ${JSON.stringify(forwardedEnvironment)}`,
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 150",
    "",
  ].join("\n");
}

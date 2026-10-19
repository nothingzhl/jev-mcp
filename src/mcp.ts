#!/usr/bin/env node
import { isMain } from "./entrypoint.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createApplication } from "./application.js";
import type { JudgmentService } from "./core/service.js";
import { safeError } from "./core/errors.js";
import { getRecipe } from "./recipes/index.js";

export function createMcpServer(service: JudgmentService): McpServer {
  const server = new McpServer({ name: "jev-mcp", version: "0.1.0" });
  const register = (name: string, recipeId: string) => {
    const recipe = getRecipe(recipeId);
    server.registerTool(name, {
      description: `${recipe.description} Sends supplied excerpts to TypeSafe. Does not read files or execute commands.`,
      inputSchema: recipe.inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, async (input, extra) => {
      try {
        const output = await service.run(recipeId, input, extra.signal);
        return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: { ...output } };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: safeError(error) }) }] };
      }
    });
  };
  register("jev_rank_candidates", "rank-candidates");
  register("jev_verify_claims", "verify-claims");
  register("jev_triage_failure", "triage-failure");
  server.registerTool("jev_run_recipe", {
    description: "Run a registered, versioned Jev recipe. dryRun=true returns a request plan without calling TypeSafe or recording a run. Live calls transmit provided material to TypeSafe.",
    inputSchema: { recipeId: z.enum(["rank-candidates", "verify-claims", "triage-failure"]), input: z.unknown(), dryRun: z.boolean().default(false) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ recipeId, input, dryRun }, extra) => {
    try {
      const output = dryRun ? { dryRun: true, ...service.plan(recipeId, input) } : await service.run(recipeId, input, extra.signal);
      return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: { ...output } };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: safeError(error) }) }] };
    }
  });
  return server;
}

export async function startMcp(): Promise<void> {
  const app = createApplication();
  const server = createMcpServer(app.service);
  const close = () => { app.close(); void server.close(); };
  server.server.onclose = () => app.close();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  try { await server.connect(new StdioServerTransport()); }
  catch (error) { app.close(); throw error; }
}

if (isMain(import.meta.url)) {
  startMcp().catch((error: unknown) => { process.stderr.write(`${JSON.stringify({ error: safeError(error) })}\n`); process.exitCode = 1; });
}

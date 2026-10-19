import { createReadStream } from "node:fs";
import { JevError } from "./core/errors.js";

export async function readText(path: string, maxBytes = 1024 * 1024): Promise<string> {
  try {
    const source = path === "-" ? process.stdin : createReadStream(path);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of source) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) { source.destroy(); throw new Error(); }
      chunks.push(buffer);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch { throw new JevError("INVALID_INPUT", "Cannot read input: use a readable UTF-8 file within the documented size limit."); }
}

export function parseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown; }
  catch { throw new JevError("INVALID_INPUT", "Cannot parse input: use valid JSON."); }
}

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

type Structured = Record<string, unknown>;

function build(text: string, structured: Structured | undefined, isError: boolean): CallToolResult {
  const result: CallToolResult = { content: [{ type: 'text', text }] };
  if (structured) {
    // Some hosts (Codex CLI, Claude Code) surface ONLY structuredContent when
    // present and drop the text content[]. Mirror the human-readable text into
    // structuredContent.message so prose (confirm previews, login/setup
    // guidance) reaches the model regardless of host. Host-agnostic + benign.
    result.structuredContent = { message: text, ...structured };
  }
  if (isError) result.isError = true;
  return result;
}

/** Successful tool result. */
export function ok(text: string, structured?: Structured): CallToolResult {
  return build(text, structured, false);
}

/** Error tool result (isError:true). We return errors, never throw, per §A.9. */
export function err(text: string, structured?: Structured): CallToolResult {
  return build(text, structured, true);
}

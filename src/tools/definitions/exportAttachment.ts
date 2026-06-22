import { z } from 'zod';
import { exportTaskAttachment } from '../primitives/attachments.js';
import { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';

export const schema = z.object({
  id: z.string().optional().describe("ID of the task whose attachment(s) to export (preferred over name)."),
  name: z.string().optional().describe("Name of the task (used if id is not provided)."),
  filename: z.string().describe('Filename of the embedded attachment to export, or "all" to export every embedded attachment on the task.'),
  destination: z.string().describe('Absolute destination path. For a single attachment: a full file path, or an existing directory. For "all": an existing, writable directory. Directories are NOT created automatically.')
});

export async function handler(args: z.infer<typeof schema>, extra: RequestHandlerExtra) {
  try {
    if (!args.id && !args.name) {
      return {
        content: [{ type: "text" as const, text: "Either id or name must be provided to export an attachment." }],
        isError: true
      };
    }

    const result = await exportTaskAttachment({
      id: args.id,
      name: args.name,
      filename: args.filename,
      destination: args.destination
    });

    if (result.success && result.savedPaths && result.savedPaths.length > 0) {
      const paths = result.savedPaths;
      const header = paths.length === 1
        ? `✅ Exported attachment to:`
        : `✅ Exported ${paths.length} attachments:`;
      return {
        content: [{ type: "text" as const, text: `${header}\n${paths.map(p => `  ${p}`).join('\n')}` }]
      };
    }

    // No bytes written, or a (partial) failure — surface per-op detail when present.
    let msg = result.error ? `Failed to export attachment: ${result.error}` : 'Failed to export attachment.';
    if (result.results && result.results.length > 0) {
      const failed = result.results.filter(r => !r.success);
      if (failed.length > 0) {
        msg = `Failed to export attachment: ${failed.map(r => r.error).join('; ')}`;
      } else if (!result.savedPaths || result.savedPaths.length === 0) {
        msg = `No attachments matched "${args.filename}" on this task.`;
      }
    }
    return {
      content: [{ type: "text" as const, text: msg }],
      isError: true
    };
  } catch (err: unknown) {
    const error = err as Error;
    console.error(`Error exporting attachment: ${error.message}`);
    return {
      content: [{ type: "text" as const, text: `Error exporting attachment: ${error.message}` }],
      isError: true
    };
  }
}

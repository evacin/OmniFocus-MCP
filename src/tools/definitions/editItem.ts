import { z } from 'zod';
import { editItem, EditItemParams } from '../primitives/editItem.js';
import { addTaskAttachments, removeTaskAttachments, AttachmentResult } from '../primitives/attachments.js';
import { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';

// Normal (AppleScript) editable fields — used to decide whether to run the
// AppleScript edit at all. Attachment fields are handled separately via OmniJS.
const EDIT_FIELD_KEYS = [
  'newName', 'newNote', 'newDueDate', 'newDeferDate', 'newPlannedDate', 'newFlagged',
  'newEstimatedMinutes', 'newStatus', 'addTags', 'removeTags', 'replaceTags',
  'newProjectName', 'newSequential', 'newFolderName', 'newProjectStatus', 'markReviewed'
] as const;

// Turn an attachment primitive result into a one-line summary + error flag.
function summarizeAttachments(verb: 'Added' | 'Removed', res: AttachmentResult): { line: string; error: boolean } {
  if (!res.success && res.error && !res.results) {
    return { line: `⚠️ Attachment ${verb.toLowerCase()} failed: ${res.error}`, error: true };
  }
  const results = res.results ?? [];
  const ok = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  const parts: string[] = [];
  if (ok.length) {
    parts.push(`${verb} ${ok.length} attachment${ok.length === 1 ? '' : 's'}: ${ok.map(r => r.filename || r.url).join(', ')}`);
  }
  if (failed.length) {
    parts.push(`${failed.length} failed: ${failed.map(r => r.error).join('; ')}`);
  }
  const icon = failed.length ? '⚠️' : '📎';
  return { line: `${icon} ${parts.join('; ') || 'no attachment changes'}`, error: failed.length > 0 };
}

export const schema = z.object({
  id: z.string().optional().describe("The ID of the task or project to edit"),
  name: z.string().optional().describe("The name of the task or project to edit (as fallback if ID not provided)"),
  itemType: z.enum(['task', 'project']).describe("Type of item to edit ('task' or 'project')"),
  
  // Common editable fields
  newName: z.string().optional().describe("New name for the item"),
  newNote: z.string().optional().describe("New note for the item"),
  newDueDate: z.string().optional().describe("New due date in ISO format (YYYY-MM-DD or full ISO date); set to empty string to clear"),
  newDeferDate: z.string().optional().describe("New defer date in ISO format (YYYY-MM-DD or full ISO date); set to empty string to clear"),
  newPlannedDate: z.string().optional().describe("New planned date in ISO format (YYYY-MM-DD or full ISO date); set to empty string to clear (tasks only)"),
  newFlagged: z.boolean().optional().describe("Set flagged status (set to false for no flag, true for flag)"),
  newEstimatedMinutes: z.number().optional().describe("New estimated minutes"),

  // Task-specific fields
  newStatus: z.enum(['incomplete', 'completed', 'dropped', 'skipped']).optional().describe("New status for tasks (incomplete, completed, dropped, skipped). 'skipped' only works on repeating tasks — it completes the current occurrence to trigger the next repeat, then drops the completed instance."),
  addTags: z.array(z.string()).optional().describe("Tags to add to the task"),
  removeTags: z.array(z.string()).optional().describe("Tags to remove from the task"),
  replaceTags: z.array(z.string()).optional().describe("Tags to replace all existing tags with"),
  newProjectName: z.string().optional().describe("Move this task to a different project by name or folder path (e.g. 'My Project' or 'Work/My Project' to disambiguate). Pass an empty string or 'inbox' to move the task to the inbox. (tasks only)"),

  // Project-specific fields
  newSequential: z.boolean().optional().describe("Whether the project should be sequential"),
  newFolderName: z.string().optional().describe("New folder to move the project to"),
  newProjectStatus: z.enum(['active', 'completed', 'dropped', 'onHold']).optional().describe("New status for projects"),
  markReviewed: z.boolean().optional().describe("Mark the project as reviewed (projects only). Sets the next review date to now + the project's review interval. Only works when set to true."),

  // Attachment fields (tasks only)
  addAttachmentPaths: z.array(z.string()).optional().describe("Absolute file paths to attach as EMBEDDED attachments (a copy of the file's bytes is stored in OmniFocus and syncs across devices). Tasks only; paths must be absolute and exist."),
  addLinkedFilePaths: z.array(z.string()).optional().describe("Absolute file paths to attach as LINKED references (OmniFocus stores a pointer to the file, not its bytes). Tasks only; paths must be absolute and exist."),
  removeAttachmentFilenames: z.array(z.string()).optional().describe("Filenames of embedded attachments to remove from the task. An ambiguous name (multiple attachments share it) is reported, not guessed. Tasks only."),
  removeLinkedFilePaths: z.array(z.string()).optional().describe("Paths or file:// URLs of linked file references to remove from the task. Tasks only.")
});

export async function handler(args: z.infer<typeof schema>, extra: RequestHandlerExtra) {
  try {
    // Validate that either id or name is provided
    if (!args.id && !args.name) {
      return {
        content: [{
          type: "text" as const,
          text: "Either id or name must be provided to edit an item."
        }],
        isError: true
      };
    }
    
    // Attachment ops are tasks-only.
    const hasAddAtt = !!(args.addAttachmentPaths?.length || args.addLinkedFilePaths?.length);
    const hasRemoveAtt = !!(args.removeAttachmentFilenames?.length || args.removeLinkedFilePaths?.length);
    const hasAttachmentOps = hasAddAtt || hasRemoveAtt;
    if (hasAttachmentOps && args.itemType !== 'task') {
      return {
        content: [{ type: "text" as const, text: "Attachment operations are supported on tasks only." }],
        isError: true
      };
    }

    const hasNormalEdit = EDIT_FIELD_KEYS.some(k => (args as Record<string, unknown>)[k] !== undefined);

    const messages: string[] = [];
    let anyError = false;
    let resolvedId = args.id;
    let resolvedName = args.name;

    // 1. Run the AppleScript edit, but only if there are non-attachment changes.
    if (hasNormalEdit) {
      const result = await editItem(args as EditItemParams);

      if (!result.success) {
        // Edit failed — surface the error and do NOT touch attachments.
        let errorMsg = `Failed to update ${args.itemType}`;
        if (result.error) {
          if (result.error.includes("Item not found")) {
            errorMsg = `${args.itemType.charAt(0).toUpperCase() + args.itemType.slice(1)} not found`;
            if (args.id) errorMsg += ` with ID "${args.id}"`;
            if (args.name) errorMsg += `${args.id ? ' or' : ' with'} name "${args.name}"`;
            errorMsg += '.';
          } else {
            errorMsg += `: ${result.error}`;
          }
        }
        return { content: [{ type: "text" as const, text: errorMsg }], isError: true };
      }

      resolvedId = result.id || resolvedId;
      resolvedName = result.name || resolvedName;
      const itemTypeLabel = args.itemType === 'task' ? 'Task' : 'Project';
      const changedText = result.changedProperties ? ` (${result.changedProperties})` : '';
      messages.push(`✅ ${itemTypeLabel} "${result.name}" updated successfully${changedText}.`);
    }

    // 2. Run attachment ops (tasks only; keyed by the resolved id when available).
    if (hasAddAtt) {
      const addRes = await addTaskAttachments({
        id: resolvedId,
        name: resolvedName,
        embeddedPaths: args.addAttachmentPaths,
        linkedPaths: args.addLinkedFilePaths
      });
      if (!resolvedId && addRes.taskId) resolvedId = addRes.taskId;
      const { line, error } = summarizeAttachments('Added', addRes);
      messages.push(line);
      anyError = anyError || error;
    }
    if (hasRemoveAtt) {
      const rmRes = await removeTaskAttachments({
        id: resolvedId,
        name: resolvedName,
        removeEmbeddedFilenames: args.removeAttachmentFilenames,
        removeLinkedFileUrls: args.removeLinkedFilePaths
      });
      const { line, error } = summarizeAttachments('Removed', rmRes);
      messages.push(line);
      anyError = anyError || error;
    }

    if (messages.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No changes specified." }],
        isError: true
      };
    }

    return {
      content: [{ type: "text" as const, text: messages.join('\n') }],
      ...(anyError ? { isError: true } : {})
    };
  } catch (err: unknown) {
    const error = err as Error;
    console.error(`Tool execution error: ${error.message}`);
    
    return {
      content: [{
        type: "text" as const,
        text: `Error updating ${args.itemType}: ${error.message}`
      }],
      isError: true
    };
  }
} 
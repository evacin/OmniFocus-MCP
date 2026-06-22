import { executeOmniFocusScript } from '../../utils/scriptExecution.js';
import {
  existsSync, mkdirSync, copyFileSync, rmSync, accessSync, statSync, readdirSync, realpathSync, constants
} from 'fs';
import { join, basename, dirname, extname, isAbsolute } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { pathToFileURL, fileURLToPath } from 'url';

// Attachment operations for OmniFocus tasks.
//
// Two facts shape this module (both verified against the live app):
//  1. The argv passed to manageAttachments.js is a SINGLE base64-encoded JSON
//     string. Base64 is required because executeOmniFocusScript wraps each arg
//     as "${escapeContent(arg)}" and escapeContent does not escape double
//     quotes — raw JSON would break the generated script. Do not "simplify"
//     encodePayload to pass raw JSON.
//  2. OmniFocus is sandboxed: OmniJS cannot read/write arbitrary user paths,
//     only files inside its own container. So all byte transfer goes through a
//     staging dir inside the container — Node (unsandboxed) copies the user's
//     file in / the exported file out. No base64 of file contents ever crosses
//     the bridge.

export interface AttachmentOpResult {
  op: string;
  success: boolean;
  filename?: string;
  url?: string;
  error?: string;
  written?: { filename: string; stagedPath: string }[];
  savedPaths?: string[];
}

export interface AttachmentResult {
  success: boolean;
  taskId?: string;
  taskName?: string;
  results?: AttachmentOpResult[];
  savedPaths?: string[];
  error?: string;
}

interface Operation {
  op: 'add-embedded' | 'add-linked' | 'remove-embedded' | 'remove-linked' | 'export';
  stagedPath?: string;
  url?: string;
  path?: string;
  filename?: string;
  stagedDir?: string;
}

interface TaskRef {
  id?: string;
  name?: string;
}

// Encode the script payload as base64 JSON. See note (1) above.
function encodePayload(payload: object): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

// Normalize a user-supplied path or file URL to a file:// URL string.
function toFileUrl(input: string): string {
  if (input.startsWith('file://')) return input;
  return pathToFileURL(input).href;
}

// Resolve a user-supplied path or file URL to its canonical decoded path and
// matching file:// URL. macOS canonicalizes symlinks (e.g. /tmp -> /private/tmp)
// when storing a linked attachment, so we must match on the canonical form.
function refForLinked(input: string): { path: string; url: string } {
  let p = input.startsWith('file://') ? fileURLToPath(input) : input;
  try { p = realpathSync(p); } catch { /* file may be gone; match on the given path */ }
  return { path: p, url: pathToFileURL(p).href };
}

// Locate a writable staging directory inside OmniFocus's sandbox container.
// See note (2) above. Prefers the highest installed major version.
function findContainerStagingDir(): string {
  const base = join(homedir(), 'Library', 'Containers');
  let candidates: string[] = [];
  try {
    candidates = readdirSync(base)
      .filter(n => /^com\.omnigroup\.OmniFocus\d+$/.test(n))
      .sort()
      .reverse()
      .map(n => join(base, n, 'Data', 'tmp'));
  } catch {
    /* fall through to the error below */
  }
  for (const tmp of candidates) {
    try {
      accessSync(tmp, constants.W_OK);
      const staging = join(tmp, 'omnifocus-mcp');
      mkdirSync(staging, { recursive: true });
      return staging;
    } catch {
      /* try next candidate */
    }
  }
  throw new Error(
    'Could not find a writable OmniFocus container staging directory ' +
    '(~/Library/Containers/com.omnigroup.OmniFocus*/Data/tmp). OmniFocus is ' +
    'sandboxed, so attachment file transfer requires staging inside its container.'
  );
}

// If `p` exists, return `p` with " (1)", " (2)", ... inserted before the
// extension until the name is free.
function uniquePath(p: string): string {
  if (!existsSync(p)) return p;
  const dir = dirname(p);
  const ext = extname(p);
  const stem = basename(p, ext);
  let i = 1;
  let candidate: string;
  do {
    candidate = join(dir, `${stem} (${i})${ext}`);
    i++;
  } while (existsSync(candidate));
  return candidate;
}

function validateTaskRef(ref: TaskRef): string | null {
  if (!ref.id && !ref.name) return 'Either a task id or name must be provided.';
  return null;
}

async function runScript(ref: TaskRef, operations: Operation[]): Promise<AttachmentResult> {
  const payload = { taskId: ref.id, taskName: ref.name, operations };
  const result = await executeOmniFocusScript('@manageAttachments.js', [encodePayload(payload)]);
  if (!result || typeof result !== 'object') {
    return { success: false, error: 'Unexpected script output: ' + String(result) };
  }
  return result as AttachmentResult;
}

export interface AddAttachmentsParams extends TaskRef {
  embeddedPaths?: string[];
  linkedPaths?: string[];
}

export async function addTaskAttachments(params: AddAttachmentsParams): Promise<AttachmentResult> {
  const refErr = validateTaskRef(params);
  if (refErr) return { success: false, error: refErr };

  const embedded = params.embeddedPaths ?? [];
  const linked = params.linkedPaths ?? [];
  if (embedded.length === 0 && linked.length === 0) {
    return { success: false, error: 'Provide at least one embeddedPaths or linkedPaths entry.' };
  }

  // Validate everything up front (fail fast, before staging or any OmniFocus call).
  for (const p of [...embedded, ...linked]) {
    if (!isAbsolute(p)) return { success: false, error: `Path must be absolute: ${p}` };
    if (!existsSync(p)) return { success: false, error: `File not found: ${p}` };
  }

  let callDir: string | null = null;
  try {
    const staging = findContainerStagingDir();
    callDir = join(staging, randomUUID());
    mkdirSync(callDir, { recursive: true });

    const operations: Operation[] = [];

    // Embedded: copy each file into the container under its original basename so
    // the attachment keeps that name; OmniJS reads it from there.
    embedded.forEach((p, i) => {
      const inDir = join(callDir as string, `in${i}`);
      mkdirSync(inDir, { recursive: true });
      const staged = join(inDir, basename(p));
      copyFileSync(p, staged);
      operations.push({ op: 'add-embedded', stagedPath: staged });
    });

    // Linked: just a stored reference, no bytes. Canonicalize so read/remove
    // later match what OmniFocus stores.
    linked.forEach((p) => operations.push({ op: 'add-linked', url: refForLinked(p).url }));

    return await runScript(params, operations);
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (callDir) { try { rmSync(callDir, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
}

export interface RemoveAttachmentsParams extends TaskRef {
  removeEmbeddedFilenames?: string[];
  removeLinkedFileUrls?: string[];
}

export async function removeTaskAttachments(params: RemoveAttachmentsParams): Promise<AttachmentResult> {
  const refErr = validateTaskRef(params);
  if (refErr) return { success: false, error: refErr };

  const emb = params.removeEmbeddedFilenames ?? [];
  const lnk = params.removeLinkedFileUrls ?? [];
  if (emb.length === 0 && lnk.length === 0) {
    return { success: false, error: 'Provide at least one removeEmbeddedFilenames or removeLinkedFileUrls entry.' };
  }

  const operations: Operation[] = [];
  emb.forEach(f => operations.push({ op: 'remove-embedded', filename: f }));
  lnk.forEach(u => {
    const ref = refForLinked(u);
    operations.push({ op: 'remove-linked', url: ref.url, path: ref.path });
  });

  try {
    return await runScript(params, operations);
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface ExportAttachmentParams extends TaskRef {
  filename: string; // a specific attachment filename, or "all"
  destination: string; // absolute file path (single) or directory
}

export async function exportTaskAttachment(params: ExportAttachmentParams): Promise<AttachmentResult> {
  const refErr = validateTaskRef(params);
  if (refErr) return { success: false, error: refErr };
  if (!params.filename) return { success: false, error: 'filename is required (or "all").' };
  if (!params.destination || !isAbsolute(params.destination)) {
    return { success: false, error: 'destination must be an absolute path.' };
  }

  const destIsDir = existsSync(params.destination) && statSync(params.destination).isDirectory();
  if (params.filename === 'all' && !destIsDir) {
    return { success: false, error: 'For filename:"all", destination must be an existing directory.' };
  }

  // Validate the directory we'll write into (no auto-mkdir).
  const destDir = destIsDir ? params.destination : dirname(params.destination);
  if (!existsSync(destDir)) return { success: false, error: `Destination directory does not exist: ${destDir}` };
  try {
    accessSync(destDir, constants.W_OK);
  } catch {
    return { success: false, error: `Destination directory is not writable: ${destDir}` };
  }

  let callDir: string | null = null;
  try {
    const staging = findContainerStagingDir();
    callDir = join(staging, randomUUID());
    const outDir = join(callDir, 'out');
    mkdirSync(outDir, { recursive: true });

    const result = await runScript(params, [{ op: 'export', filename: params.filename, stagedDir: outDir }]);
    if (!result.success || !result.results) return result;

    // Move staged files out to the user's destination, handling collisions.
    const savedPaths: string[] = [];
    for (const r of result.results) {
      if (r.op === 'export' && r.written) {
        for (const w of r.written) {
          const target = destIsDir
            ? uniquePath(join(params.destination, w.filename))
            : uniquePath(params.destination);
          copyFileSync(w.stagedPath, target);
          savedPaths.push(target);
        }
        r.savedPaths = savedPaths.slice();
        delete r.written; // staged paths are internal; don't leak them
      }
    }
    return { ...result, savedPaths };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (callDir) { try { rmSync(callDir, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
}

// Exported for unit testing only — not part of the public API.
export const _testExports = {
  encodePayload,
  toFileUrl,
  uniquePath,
  validateTaskRef,
  findContainerStagingDir,
};

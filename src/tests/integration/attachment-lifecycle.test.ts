import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, statSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupIntegration, createTrackedTask } from './setup.js';
import {
  addTaskAttachments,
  removeTaskAttachments,
  exportTaskAttachment,
} from '../../tools/primitives/attachments.js';
import { queryOmnifocus } from '../../tools/primitives/queryOmnifocus.js';

describe('Attachment Lifecycle (integration)', () => {
  setupIntegration();

  let taskId: string;
  let scratch: string;
  let embedSrc: string;
  let linkSrc: string;
  let exportDir: string;
  const EMBED_NAME = 'embedded-report.txt';
  const EMBED_CONTENT = 'embedded attachment body for integration test';

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'attach-int-'));
    embedSrc = join(scratch, EMBED_NAME);
    linkSrc = join(scratch, 'linked-ref.txt');
    exportDir = join(scratch, 'exports');
    mkdirSync(exportDir, { recursive: true });
    writeFileSync(embedSrc, EMBED_CONTENT);
    writeFileSync(linkSrc, 'linked target body');
  });

  afterAll(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it('creates a task to attach to', async () => {
    const result = await createTrackedTask({ name: 'TEST:Attachment Task' });
    expect(result.success).toBe(true);
    expect(result.taskId).toBeTruthy();
    taskId = result.taskId!;
  });

  it('adds an embedded file and a linked file', async () => {
    const result = await addTaskAttachments({
      id: taskId,
      embeddedPaths: [embedSrc],
      linkedPaths: [linkSrc],
    });
    expect(result.success).toBe(true);
    const ops = result.results ?? [];
    expect(ops.filter(r => r.success)).toHaveLength(2);
  });

  it('reports attachment metadata via query_omnifocus', async () => {
    const result = await queryOmnifocus({
      entity: 'tasks',
      filters: { taskName: 'TEST:Attachment Task' },
      fields: ['name', 'attachments'],
    });
    expect(result.success).toBe(true);
    const task = (result.items ?? [])[0];
    expect(task).toBeTruthy();
    const atts = task.attachments as Array<{ filename: string; embedded: boolean; path: string | null }>;

    const embedded = atts.find(a => a.embedded);
    expect(embedded?.filename).toBe(EMBED_NAME);
    expect(embedded?.path).toBeNull();

    const linked = atts.find(a => !a.embedded);
    expect(linked).toBeTruthy();
    expect(linked?.path).toContain('linked-ref.txt');
  });

  it('exports the embedded file back to disk with matching content', async () => {
    const result = await exportTaskAttachment({
      id: taskId,
      filename: EMBED_NAME,
      destination: exportDir,
    });
    expect(result.success).toBe(true);
    expect(result.savedPaths).toHaveLength(1);
    const savedPath = result.savedPaths![0];
    expect(existsSync(savedPath)).toBe(true);
    expect(readFileSync(savedPath, 'utf8')).toBe(EMBED_CONTENT);
    expect(statSync(savedPath).size).toBe(Buffer.byteLength(EMBED_CONTENT));
  });

  it('removes both the embedded and linked attachments', async () => {
    const result = await removeTaskAttachments({
      id: taskId,
      removeEmbeddedFilenames: [EMBED_NAME],
      removeLinkedFileUrls: [linkSrc],
    });
    expect(result.success).toBe(true);

    const after = await queryOmnifocus({
      entity: 'tasks',
      filters: { taskName: 'TEST:Attachment Task' },
      fields: ['attachments'],
    });
    const task = (after.items ?? [])[0];
    expect(task.attachments).toHaveLength(0);
  });
});

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { _testExports } from '../primitives/attachments.js';

const { encodePayload, toFileUrl, uniquePath, validateTaskRef } = _testExports;

describe('encodePayload', () => {
  it('round-trips JSON via base64', () => {
    const payload = { taskId: 'abc', operations: [{ op: 'add-linked', url: 'file:///x/y.txt' }] };
    const b64 = encodePayload(payload);
    const decoded = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    expect(decoded).toEqual(payload);
  });

  it('produces output safe for the argv injection (no " \\ ` $)', () => {
    // escapeContent in scriptExecution does NOT escape double quotes; base64 must
    // never contain characters that would break the generated script string.
    const payload = { taskName: 'weird "name" with `backticks` and $vars and \\slashes', operations: [] };
    const b64 = encodePayload(payload);
    expect(b64).not.toMatch(/["`$\\]/);
    // and still round-trips
    expect(JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))).toEqual(payload);
  });
});

describe('toFileUrl', () => {
  it('converts an absolute path to a file:// URL', () => {
    expect(toFileUrl('/Users/me/My File.pdf')).toBe('file:///Users/me/My%20File.pdf');
  });

  it('passes an existing file:// URL through unchanged', () => {
    expect(toFileUrl('file:///already/a/url.txt')).toBe('file:///already/a/url.txt');
  });
});

describe('validateTaskRef', () => {
  it('rejects when neither id nor name is provided', () => {
    expect(validateTaskRef({})).toMatch(/id or name/i);
  });
  it('accepts when id is provided', () => {
    expect(validateTaskRef({ id: 'x' })).toBeNull();
  });
  it('accepts when name is provided', () => {
    expect(validateTaskRef({ name: 'x' })).toBeNull();
  });
});

describe('uniquePath', () => {
  const dir = mkdtempSync(join(tmpdir(), 'attach-unique-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('returns the path unchanged when nothing exists', () => {
    const p = join(dir, 'fresh.pdf');
    expect(uniquePath(p)).toBe(p);
  });

  it('suffixes " (1)", " (2)" before the extension on collision', () => {
    const p = join(dir, 'doc.pdf');
    writeFileSync(p, 'a');
    expect(uniquePath(p)).toBe(join(dir, 'doc (1).pdf'));
    writeFileSync(join(dir, 'doc (1).pdf'), 'b');
    expect(uniquePath(p)).toBe(join(dir, 'doc (2).pdf'));
  });
});

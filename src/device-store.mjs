import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// Local-only state. Do not certify Windows chmod as an ACL check.
export async function privateDirectory(directory, { create = false } = {}) {
  if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077))) {
    throw new Error('Device directory must be private and not a symlink; no permissions changed');
  }
}
export async function readPrivate(file, limit = 1048576) {
  await privateDirectory(path.dirname(file));
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit
      || (process.platform !== 'win32' && (info.mode & 0o077))) throw new Error('Unsafe device state file');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.size > limit || actual.ino !== info.ino || actual.dev !== info.dev) throw new Error('Device file changed');
    const bytes = await handle.readFile();
    if (bytes.length > limit) throw new Error('Device file too large');
    return bytes;
  } finally { await handle.close(); }
}
export async function readPrivateJson(file, limit) {
  try { return JSON.parse((await readPrivate(file, limit)).toString('utf8')); }
  catch (error) { if (error.code === 'ENOENT') throw error; throw new Error('Device state unavailable or invalid'); }
}
export async function createPrivate(file, data) {
  await privateDirectory(path.dirname(file));
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
}
export async function replacePrivate(file, data) {
  // Validate the old file first; never overwrite a symlink or broad-permission state.
  await readPrivate(file);
  const temporary = file + '.tmp-' + randomBytes(12).toString('hex');
  try { await createPrivate(temporary, data); await fs.rename(temporary, file); }
  finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export async function withDeviceLock(directory, operation) {
  await privateDirectory(directory);
  const lock = path.join(directory, '.device-write-lock');
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Device state is locked; do not remove a live writer lock');
    throw error;
  }
  try { return await operation(); } finally { await fs.rmdir(lock); }
}
export function exactObject(raw, fields) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).some(key => !fields.includes(key))
      || fields.some(key => !Object.hasOwn(raw, key))) throw new Error('Invalid device protocol fields');
  return raw;
}

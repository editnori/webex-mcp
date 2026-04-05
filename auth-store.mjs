import fs from 'node:fs';
import path from 'node:path';

export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  try {
    fs.chmodSync(dir, 0o700);
  } catch {}
}

export function readJsonFile(file, fallback = null, {strict = false} = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (strict && fs.existsSync(file)) {
      throw new Error(`Failed to parse JSON file ${file}: ${error.message || String(error)}`);
    }
    return fallback;
  }
}

export function writeJsonFile(file, data) {
  ensurePrivateDir(path.dirname(file));
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), {mode: 0o600});
  fs.renameSync(tempFile, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
}

function getLockFilePath(file) {
  return `${file}.lock`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withLockedFile(file, fn, {timeoutMs = 15000, pollMs = 100, staleMs = 300000} = {}) {
  ensurePrivateDir(path.dirname(file));
  const lockFile = getLockFilePath(file);
  const startedAt = Date.now();
  let fd = null;

  while (fd === null) {
    try {
      fd = fs.openSync(lockFile, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;

      try {
        const stat = fs.statSync(lockFile);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch {}

      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for token lock ${lockFile}`);
      }

      await sleep(pollMs);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      if (fd !== null) fs.closeSync(fd);
    } catch {}
    try {
      fs.unlinkSync(lockFile);
    } catch {}
  }
}

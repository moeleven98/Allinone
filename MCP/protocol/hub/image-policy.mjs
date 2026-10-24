// Cross-process, cross-project rolling window for image DISPATCH requests.
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function imageRequest(args) {
  const isImage = args.category === 'image' || args.generation === 'image' || args.imageCount != null
    || /生图|生成.{0,8}(图片|图像)|(?:generate|create).{0,20}(?:images?|pictures?)/i.test(args.task || '');
  if (!isImage) return null;
  const text = String(args.task || '');
  const numbers = [...text.matchAll(/(\d+)\s*(?:张|幅|images?\b|pictures?\b)/gi)].map((m) => Number(m[1]));
  // Explicit imageCount is the contract; a larger count in the task cannot lower it.
  const count = args.imageCount ?? (numbers.length ? Math.max(...numbers) : null);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('imageCount 必须是正整数');
  return Math.max(count, ...numbers);
}

export async function reserveImageRequest(board, count) {
  fs.mkdirSync(board, { recursive: true });
  const lock = path.join(board, 'image-requests.lock');
  let fd;
  const deadline = Date.now() + 5000;
  while (fd === undefined) {
    try { fd = fs.openSync(lock, 'wx'); fs.writeSync(fd, String(process.pid)); }
    catch (e) {
      // On Windows a lock file that is being deleted reports EPERM/EACCES instead of EEXIST: treat it as busy.
      if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
      try {
        const owner = Number(fs.readFileSync(lock, 'utf8'));
        if (owner > 0) {
          try { process.kill(owner, 0); }
          catch (err) { if (err.code === 'ESRCH') { fs.unlinkSync(lock); continue; } }
        } else if (Date.now() - fs.statSync(lock).mtimeMs > 30000) {
          fs.unlinkSync(lock); continue;
        }
      } catch (err) { if (err.code === 'ENOENT' || err.code === 'EPERM' || err.code === 'EACCES') { await delay(25); continue; } throw err; }
      if (Date.now() >= deadline) throw new Error('生图计数忙碌，请稍后重试；未执行生成');
      await delay(25);
    }
  }
  try {
    const file = path.join(board, 'image-requests.jsonl');
    const now = Date.now();
    // Corrupt accounting must fail visibly instead of silently resetting the limit.
    const recent = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
      .map((s) => JSON.parse(s)).filter((r) => now - r.time < 60000) : [];
    const row = { time: now, pid: process.pid, count };
    recent.push(row);
    fs.writeFileSync(file, recent.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return { requiresApproval: count > 5 || recent.length > 5, count, requestsInMinute: recent.length };
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

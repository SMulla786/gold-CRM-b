import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import { HttpError } from '../../../middleware/error';
import type { TenantContext } from '../../../middleware/context';

// shortcut: mirrors app/uploads.ts saveImage/imagePath (not exported there) + PDF for order designs; fold into uploads.ts when it is free to edit.
const UPLOAD_ROOT = path.join(process.cwd(), 'uploads');
export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
export const CONTENT_TYPE: Record<string, string> = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf' };

/** Magic-byte type check — never trust the client's mimetype. */
function detect(buf: Buffer, allowPdf: boolean): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (allowPdf && buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-') return 'pdf';
  return null;
}

/** Writes uploads/<businessId>/<subdir>/<uuid>.<ext>, persists the relative path via `save`, then deletes `previous`. */
export async function replaceFile(ctx: TenantContext, subdir: string, buffer: Buffer, previous: string | null, save: (rel: string) => Promise<unknown>, allowPdf = false): Promise<string> {
  const ext = detect(buffer, allowPdf);
  if (!ext) throw new HttpError(400, 'VALIDATION', allowPdf ? 'Only JPEG, PNG, WebP images or PDF files are allowed' : 'Only JPEG, PNG or WebP images are allowed');
  const rel = `${ctx.businessId}/${subdir}/${randomUUID()}.${ext}`;
  const abs = path.join(UPLOAD_ROOT, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, buffer);
  await save(rel);
  await removeFile(previous);
  return rel;
}

export async function removeFile(stored: string | null): Promise<void> {
  if (stored) await rm(path.join(UPLOAD_ROOT, stored), { force: true }).catch(() => {});
}

/** Absolute path for streaming, with a path-traversal guard. */
export function filePath(stored: string | null | undefined): string {
  if (!stored) throw new HttpError(404, 'NOT_FOUND', 'File not found');
  const abs = path.resolve(UPLOAD_ROOT, stored);
  if (!abs.startsWith(path.resolve(UPLOAD_ROOT) + path.sep)) throw new HttpError(404, 'NOT_FOUND', 'File not found');
  return abs;
}

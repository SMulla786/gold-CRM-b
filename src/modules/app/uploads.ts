import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { scopedDb } from '../../lib/db';
import { HttpError } from '../../middleware/error';
import type { TenantContext } from '../../middleware/context';

const UPLOAD_ROOT = path.join(process.cwd(), 'uploads');
export type PartyImageField = 'photoUrl' | 'shopLogoUrl';

/** Detect image type from magic bytes — never trust the client's mimetype. */
function detectImage(buf: Buffer): 'jpg' | 'png' | 'webp' | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/** Writes the image under uploads/<businessId>/parties/<uuid>.<ext>, stores the relative path, deletes the previous file. */
export async function savePartyImage(ctx: TenantContext, partyId: number, field: PartyImageField, buffer: Buffer): Promise<string> {
  const party = await scopedDb(ctx).party.findUnique({ where: { id: partyId } });
  if (!party) throw new HttpError(404, 'NOT_FOUND', 'Party not found');
  const ext = detectImage(buffer);
  if (!ext) throw new HttpError(400, 'VALIDATION', 'Only JPEG, PNG or WebP images are allowed');

  const rel = `${ctx.businessId}/parties/${randomUUID()}.${ext}`;
  const abs = path.join(UPLOAD_ROOT, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, buffer);

  const previous = party[field];
  await scopedDb(ctx).party.update({ where: { id: partyId }, data: { [field]: rel } });
  if (previous) await rm(path.join(UPLOAD_ROOT, previous), { force: true }).catch(() => {});
  return rel;
}

/** Absolute path of a party image for streaming — scoped lookup + path-traversal guard. */
export async function partyImagePath(ctx: TenantContext, partyId: number, field: PartyImageField): Promise<string> {
  const party = await scopedDb(ctx).party.findUnique({ where: { id: partyId } });
  if (!party || !party[field]) throw new HttpError(404, 'NOT_FOUND', 'Image not found');
  const abs = path.resolve(UPLOAD_ROOT, party[field]!);
  if (!abs.startsWith(path.resolve(UPLOAD_ROOT) + path.sep)) throw new HttpError(404, 'NOT_FOUND', 'Image not found');
  return abs;
}

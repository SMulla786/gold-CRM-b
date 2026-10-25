import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { scopedDb } from '../../lib/db';
import { HttpError } from '../../middleware/error';
import type { TenantContext } from '../../middleware/context';

const UPLOAD_ROOT = path.join(process.cwd(), 'uploads');
export type PartyImageField = 'photoUrl' | 'shopLogoUrl';

type FindRow = () => Promise<Record<string, unknown> | null>; // scopedDb findUnique — tenant/branch filter already applied
type SaveRel = (rel: string) => Promise<unknown>;

/** Detect image type from magic bytes — never trust the client's mimetype. */
function detectImage(buf: Buffer): 'jpg' | 'png' | 'webp' | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/** Writes the image under uploads/<businessId>/<subdir>/<uuid>.<ext>, stores the relative path, deletes the previous file. */
async function saveImage(ctx: TenantContext, find: FindRow, save: SaveRel, subdir: string, field: string, buffer: Buffer, notFound: string): Promise<string> {
  const row = await find();
  if (!row) throw new HttpError(404, 'NOT_FOUND', notFound);
  const ext = detectImage(buffer);
  if (!ext) throw new HttpError(400, 'VALIDATION', 'Only JPEG, PNG or WebP images are allowed');

  const rel = `${ctx.businessId}/${subdir}/${randomUUID()}.${ext}`;
  const abs = path.join(UPLOAD_ROOT, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, buffer);

  const previous = row[field] as string | null;
  await save(rel);
  if (previous) await rm(path.join(UPLOAD_ROOT, previous), { force: true }).catch(() => {});
  return rel;
}

/** Absolute path of a stored image for streaming — scoped lookup + path-traversal guard. */
async function imagePath(find: FindRow, field: string): Promise<string> {
  const row = await find();
  const stored = row?.[field] as string | undefined;
  if (!stored) throw new HttpError(404, 'NOT_FOUND', 'Image not found');
  const abs = path.resolve(UPLOAD_ROOT, stored);
  if (!abs.startsWith(path.resolve(UPLOAD_ROOT) + path.sep)) throw new HttpError(404, 'NOT_FOUND', 'Image not found');
  return abs;
}

export const savePartyImage = (ctx: TenantContext, partyId: number, field: PartyImageField, buffer: Buffer): Promise<string> =>
  saveImage(ctx, () => scopedDb(ctx).party.findUnique({ where: { id: partyId } }), (rel) => scopedDb(ctx).party.update({ where: { id: partyId }, data: { [field]: rel } }), 'parties', field, buffer, 'Party not found');
export const partyImagePath = (ctx: TenantContext, partyId: number, field: PartyImageField): Promise<string> =>
  imagePath(() => scopedDb(ctx).party.findUnique({ where: { id: partyId } }), field);
export const saveStockImage = (ctx: TenantContext, stockId: number, buffer: Buffer): Promise<string> =>
  saveImage(ctx, () => scopedDb(ctx).stockItem.findUnique({ where: { id: stockId } }), (rel) => scopedDb(ctx).stockItem.update({ where: { id: stockId }, data: { photoUrl: rel } }), 'stock', 'photoUrl', buffer, 'Stock item not found');
export const stockImagePath = (ctx: TenantContext, stockId: number): Promise<string> =>
  imagePath(() => scopedDb(ctx).stockItem.findUnique({ where: { id: stockId } }), 'photoUrl');

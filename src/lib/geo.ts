import { prisma } from './prisma';
import { HttpError } from '../middleware/error';

type Geo = { stateId?: number | null; districtId?: number | null };

/**
 * State / district of a branch or business: both must exist and the district must be in the state (an unknown id
 * would otherwise hit the FK → 500). Returns the fields to write: on update, a state change without a district
 * clears the stored district (it belongs to the old state); nothing given → {} (no change).
 */
export async function checkedGeo(next: Geo, current?: { stateId: number | null; districtId: number | null }): Promise<Geo> {
  if (next.stateId === undefined && next.districtId === undefined) return {};
  const stateId = next.stateId !== undefined ? next.stateId : (current?.stateId ?? null);
  const stateChanged = next.stateId !== undefined && next.stateId !== (current?.stateId ?? null);
  const districtId = next.districtId !== undefined ? next.districtId : stateChanged ? null : (current?.districtId ?? null);
  if (stateId != null && !(await prisma.state.findUnique({ where: { id: stateId } }))) throw new HttpError(400, 'VALIDATION', 'Unknown state');
  if (districtId != null) {
    const district = await prisma.district.findUnique({ where: { id: districtId } });
    if (!district) throw new HttpError(400, 'VALIDATION', 'Unknown district');
    if (stateId != null && district.stateId !== stateId) throw new HttpError(400, 'VALIDATION', 'District is not in the selected state');
  }
  return { ...(next.stateId !== undefined ? { stateId } : {}), ...(next.districtId !== undefined || stateChanged ? { districtId } : {}) };
}

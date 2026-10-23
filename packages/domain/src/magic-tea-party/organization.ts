/** Invalid legacy extensions remain in archives but never become ordering authority. */
export const getMagicTeaPartyPinnedAt = (session: { pinnedAt?: unknown }): number =>
  typeof session.pinnedAt === 'number' && Number.isSafeInteger(session.pinnedAt) && session.pinnedAt > 0 ? session.pinnedAt : 0;
export const getMagicTeaPartyPinnedOrder = (session: { pinnedOrder?: unknown }): number =>
  typeof session.pinnedOrder === 'number' && Number.isSafeInteger(session.pinnedOrder) && session.pinnedOrder > 0 ? session.pinnedOrder : 0;
export const isMagicTeaPartyPinned = (session: { pinnedAt?: unknown }): boolean => getMagicTeaPartyPinnedAt(session) > 0;
/** Full keyset order. IDs are ASCII in the Desktop contract, compared without locale rules. */
export const compareMagicTeaPartySessions = (a: { id: string; updatedAt: number; pinnedAt?: unknown; pinnedOrder?: unknown }, b: typeof a): number => {
  const atA = getMagicTeaPartyPinnedAt(a); const atB = getMagicTeaPartyPinnedAt(b);
  return Number(atB > 0) - Number(atA > 0)
    || (atA && atB ? getMagicTeaPartyPinnedOrder(b) - getMagicTeaPartyPinnedOrder(a) || atB - atA : 0)
    || b.updatedAt - a.updatedAt || (a.id === b.id ? 0 : a.id < b.id ? 1 : -1);
};

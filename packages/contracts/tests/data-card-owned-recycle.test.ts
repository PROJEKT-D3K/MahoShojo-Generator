import { describe, expect, it } from 'vitest';
import { OwnedRecycleBinQuerySchema, OwnedRecycleBinDetailQuerySchema, OwnedRecycleBinPageSchema, OwnedRecycleBinDetailResponseSchema, OWNED_RECYCLE_DETAIL_MAX_BYTES } from '../src/data-cards';
import { DesktopCardLibraryRequestSchema } from '../src/desktop-cloud';
import golden from '../fixtures/desktop-cloud.json';
const row = { id: 'c', name: 'n', description: null, type: 'character', is_public: 0, review_status: 'approved', created_at: null, updated_at: null, deleted_at: 'now', usage_count: 0, like_count: 0, isLegacyQuestionnaire: false };
const page = { success: true, accountFenceVersion: 1, ownerUserId: 7, cards: [row], total: 1, filteredCount: 1, nextOffset: null };
describe('owned recycle bounded reads', () => {
  it('strict query defaults and narrow non-mutating registry', () => {
    expect(OwnedRecycleBinQuerySchema.parse({ expectedUserId: 7 })).toEqual({ expectedUserId: 7, limit: 12, offset: 0 });
    expect(OwnedRecycleBinDetailQuerySchema.parse({ expectedUserId: 7, id: ' c ' }).id).toBe('c');
    for (const extra of [{ limit: 25 }, { offset: -1 }, { type: 'unknown' }, { data: '{}' }, { ownerUserId: 8 }]) expect(OwnedRecycleBinQuerySchema.safeParse({ expectedUserId: 7, ...extra }).success).toBe(false);
    const routes = Object.entries(golden.cardLibrary.routes).filter(([id]) => id.includes('recycle')).map(([, route]) => route);
    expect(routes).toHaveLength(2); expect(routes.every((route) => route.method === 'GET')).toBe(true);
  });
  it('IPC rejects missing identity, extra fields, noncanonical numbers and GET body', () => {
    const valid = { routeId: 'data-cards.recycle.query', expectedUserId: 7, query: { limit: '12', offset: '0' } };
    expect(DesktopCardLibraryRequestSchema.safeParse(valid).success).toBe(true);
    for (const invalid of [{ ...valid, expectedUserId: undefined }, { ...valid, body: null }, { ...valid, method: 'DELETE' },
      { ...valid, query: { limit: '01' } }, { ...valid, query: { offset: '1e2' } }, { ...valid, query: { id: 'c' } }, { ...valid, query: { expectedUserId: '8' } }]) expect(DesktopCardLibraryRequestSchema.safeParse(invalid).success).toBe(false);
  });
  it('summary cannot hide body in unknown fields and detail requires a tombstone', () => {
    expect(OwnedRecycleBinPageSchema.safeParse(page).success).toBe(true);
    for (const malformed of [{ ...page, cards: [{ ...row, data: '{}' }] }, { ...page, cards: Array(25).fill(row) }, { ...page, accountFenceVersion: 0 }, { ...page, cards: [{ ...row, deleted_at: null }] }]) expect(OwnedRecycleBinPageSchema.safeParse(malformed).success).toBe(false);
    const detail = { success: true, accountFenceVersion: 1, ownerUserId: 7, card: { ...row, data: 'x'.repeat(OWNED_RECYCLE_DETAIL_MAX_BYTES) } };
    expect(OwnedRecycleBinDetailResponseSchema.safeParse(detail).success).toBe(true);
    expect(OwnedRecycleBinDetailResponseSchema.safeParse({ ...detail, card: { ...row, data: '中'.repeat(OWNED_RECYCLE_DETAIL_MAX_BYTES / 3 + 1) } }).success).toBe(false);
  });
});

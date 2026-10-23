import { describe, expect, it } from 'vitest';
import fixture from '@mahoshojo/contracts/fixtures/desktop-magic-tea-party.json';
import { compareMagicTeaPartySessions, getMagicTeaPartyPinnedAt, getMagicTeaPartyPinnedOrder } from '../src/magic-tea-party/organization';
describe('shared Tea pin order', () => {
  it('matches the Native fixture with complete deterministic ties', () => {
    expect([...fixture.organizationOrder].reverse().sort(compareMagicTeaPartySessions).map(row => row.id)).toEqual(fixture.organizationExpected);
  });
  it('treats malformed legacy fields as unpinned without changing the archive', () => {
    for (const pinnedAt of ['1', {}, null, 1.25, -1, 0, Number.MAX_SAFE_INTEGER + 1]) {
      const value = { pinnedAt, pinnedOrder: pinnedAt }; const before = structuredClone(value);
      expect(getMagicTeaPartyPinnedAt(value)).toBe(0); expect(getMagicTeaPartyPinnedOrder(value)).toBe(0); expect(value).toEqual(before);
    }
  });
});

import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { parseCombatantsFromText } from '@mahoshojo/domain/arena-file-parser';

import { bindArenaRatingEntities, mayRequestArenaRating, parseArenaRatingEntityBinding } from '../src/arena-generation/rating-entity-binding';
import { digestArenaRatingJson, projectArenaRatingIdentity } from '../src/arena-generation/rating-identity-projection';

const base = { name: '角色甲', content: '角色设定', metadata: { authorNote: '保留正文' } };
const card = { type: 'general-character', isPreset: false, sourceDataCardId: 'card-a', data: base };
const request = new Request('https://example.test/api/arena/generate');
const requestPayload = (first: Record<string, unknown> = card) => ({ combatants: [first, { ...card, sourceDataCardId: 'card-b' }] });
const database = (canonical = base) => {
  const rows = ['card-a', 'card-b'].map((id) => ({ id, type: 'character', data: JSON.stringify(canonical), updated_at: 'version-1' }));
  const all = vi.fn(async () => ({ success: true, results: rows, meta: {} }));
  const bind = vi.fn((..._args: unknown[]) => statement);
  const statement = { bind, all, run: all };
  const prepare = vi.fn((_sql: string) => statement);
  return { prepare, bind, all, rows };
};

describe('Rating identity projection boundaries', () => {
  it('allows only known top-level mutable fields and the inferred legacy template default', async () => {
    const variant = { ...base, templateId: '通用角色', signature: 'different', _cardId: 'transport-id',
      arena_history: { entries: ['new'] }, current_state: { summary: 'changed' },
      metadata: { ...base.metadata, signature: 'different' } };
    expect(await digestArenaRatingJson(projectArenaRatingIdentity(variant)))
      .toBe(await digestArenaRatingJson(projectArenaRatingIdentity(base)));
  });

  it.each([
    { content: '改写核心正文' }, { _attack: '不能靠下划线规避' },
    { _storageLocation: '仍可能进入模型输入的未知字段' },
    { metadata: { authorNote: 'changed' } }, { extension: { signature: '正文中的同名字段' } },
    { extension: { arena_history: '未知嵌套字段' } }, { templateId: '不同模板' },
    { templateId: null }, { templateId: false }, { templateId: 0 },
  ])('keeps unrecognized or substantive data bound: %j', async (change) => {
    expect(await digestArenaRatingJson(projectArenaRatingIdentity({ ...base, ...change })))
      .not.toBe(await digestArenaRatingJson(projectArenaRatingIdentity(base)));
  });

  it('binds unsigned online cards and preserves changed local state without replacing the request body', async () => {
    const db = database();
    const payload = requestPayload({ ...card, data: { ...base, arena_history: { entries: ['local'] }, current_state: { summary: 'local' } } });
    const before = structuredClone(payload);
    const binding = await bindArenaRatingEntities({ request, payload, getD1Client: () => db });
    expect(binding).toMatchObject({ status: 'bound', entities: [
      { entityType: 'data_card', entityId: 'card-a', updatedAt: 'version-1', authorizedUserId: null },
      { entityType: 'data_card', entityId: 'card-b' },
    ] });
    expect(payload).toEqual(before);
    expect(db.prepare).toHaveBeenCalledTimes(1);
    expect(db.prepare.mock.calls[0]?.[0]).toContain("user_id = ? OR (is_public = 1 AND review_status = 'approved')");
    expect(db.bind).toHaveBeenCalledWith('card-a', 'card-b', null);
    expect(parseArenaRatingEntityBinding(binding)).toEqual(binding);
  });

  it('uses separately authenticated ownership for private Free sources, not the supplied actor key', async () => {
    const db = database();
    const binding = await bindArenaRatingEntities({ request, payload: requestPayload(), getD1Client: () => db,
      resolveAuthentication: async () => ({ status: 'authenticated', userId: 42 }) });
    expect(binding).toMatchObject({ status: 'bound', entities: [{ authorizedUserId: 42 }, { authorizedUserId: 42 }] });
    expect(db.bind).toHaveBeenCalledWith('card-a', 'card-b', 42);
    expect(await bindArenaRatingEntities({ request, payload: requestPayload(), getD1Client: () => db,
      resolveAuthentication: async () => ({ status: 'denied' }) })).toMatchObject({ status: 'unbound', reason: 'entity-reference-unavailable' });
    expect(db.all).toHaveBeenCalledTimes(1);
  });

  it('binds canonical presets with legitimate runtime state but rejects names, body edits and type substitution', async () => {
    const original = JSON.parse(await readFile(new URL('../../../content/presets/C01_egg.json', import.meta.url), 'utf8'));
    const preset = { type: 'canshou', isPreset: true, filename: 'C01_egg.json',
      data: { ...original, arena_history: { entries: [] }, current_state: { summary: 'local' } } };
    const db = database();
    expect(await bindArenaRatingEntities({ request, payload: requestPayload(preset), getD1Client: () => db })).toMatchObject({ status: 'bound' });
    for (const forged of [{ ...preset, filename: 'C02_pupa.json' }, { ...preset, type: 'general-character' },
      { ...preset, data: { ...preset.data, attackMethod: '改写' } }]) {
      expect(await bindArenaRatingEntities({ request, payload: requestPayload(forged), getD1Client: () => db }))
        .toMatchObject({ status: 'unbound', reason: 'entity-body-mismatch' });
    }
  });

  it.each([{ name: '普通角色', content: '完整设定' }, { codename: '魔法少女', magicConstruct: { name: '心之花' } }])(
    'keeps supported unmodified character parsing compatible: %j', async (raw) => {
      const parsed = await parseCombatantsFromText(JSON.stringify(raw), { existingCount: 0 });
      const source = { ...parsed[0], sourceDataCardId: 'card-a', isPreset: false };
      const db = database(raw as typeof base);
      expect(await bindArenaRatingEntities({ request, getD1Client: () => db,
        payload: { combatants: [source, { ...source, sourceDataCardId: 'card-b' }] } })).toMatchObject({ status: 'bound' });
    },
  );

  it('does not read the database for a local-only roster or an unrequested ranking', async () => {
    const getD1Client = vi.fn();
    expect(await bindArenaRatingEntities({ request, payload: { combatants: [{ data: base }, card] }, getD1Client }))
      .toMatchObject({ status: 'unbound' });
    expect(getD1Client).not.toHaveBeenCalled();
    expect(mayRequestArenaRating({ actorKey: 'user:42', ipAnonymized: '192.0.2.0', season: null,
      payload: { ...requestPayload(), readArenaHistory: true, arenaFreeRankingEnabled: false } })).toBe(false);
    expect(mayRequestArenaRating({ actorKey: 'anonymous:test', ipAnonymized: '192.0.2.0', season: null,
      payload: { ...requestPayload(), readArenaHistory: true, arenaFreeRankingEnabled: true } })).toBe(true);
  });
});

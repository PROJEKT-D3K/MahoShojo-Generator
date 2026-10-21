import { describe, expect, it } from 'vitest';
import { normalizeArenaRepairDraft, prepareAndApplyArenaCombatantRepair } from '@mahoshojo/ai-core/arena-combatant-repair';

describe('shared Web/Desktop repair draft', () => {
  it('normalizes subsets and aliases without using names as identity', async () => {
    const combatants = [{ data: { name: '甲' } }, { data: { name: '乙' } }];
    expect(await normalizeArenaRepairDraft({ combatants, draft: '{"impacts":[{"name":"乙","current_state_summary":" 平静 "}]}' }))
      .toEqual([{ combatantIndex: 1, characterName: '乙', currentStateSummary: '平静' }]);
  });
  it('rejects ambiguous names, duplicates and index/name mismatch', async () => {
    const combatants = [{ data: { name: '甲' } }, { data: { name: '甲' } }];
    await expect(normalizeArenaRepairDraft({ combatants, draft: '[{"characterName":"甲","impact":"变化"}]' })).rejects.toThrow('重名');
    await expect(normalizeArenaRepairDraft({ combatants, draft: '[{"combatantIndex":0,"characterName":"乙","impact":"变化"}]' })).rejects.toThrow('不一致');
    await expect(normalizeArenaRepairDraft({ combatants, draft: '[{"combatantIndex":0,"impact":"变化"},{"combatantIndex":0,"impact":"变化"}]' })).rejects.toThrow('重复');
  });
  it('accepts the existing stream meta input', async () => {
    const patches = await normalizeArenaRepairDraft({ combatants: [{ data: { name: '甲' } }],
      draft: '<!-- MAHOSHOJO_ARENA_META {"version":1,"report":{"headline":"终局","winner":"甲"},"impacts":[{"characterName":"甲","impact":"成长"}]} -->' });
    expect(patches).toEqual([{ combatantIndex: 0, characterName: '甲', impact: '成长' }]);
  });
  it('confirms downgrade before missing-effect creation without changing inputs', async () => {
    const combatants = [{ isValid: true, data: { name: '甲', signature: 'original' } }], events: string[] = [];
    const result = await prepareAndApplyArenaCombatantRepair({ combatants, generationId: 'generation-1', nowISO: '2026-10-21T20:00:00Z',
      patches: [{ combatantIndex: 0, characterName: '甲', currentStateSummary: '新状态' }], verifyNative: async () => false,
      confirmTrustDowngrade: () => { events.push('downgrade'); return true; }, confirmCreateMissingEffects: () => { events.push('create'); return true; } });
    expect(events).toEqual(['downgrade', 'create']); expect(result.ok).toBe(true);
    if (result.ok) expect(result.combatants[0]!.data).not.toHaveProperty('signature');
    expect(combatants[0]!.data.signature).toBe('original');
  });
});

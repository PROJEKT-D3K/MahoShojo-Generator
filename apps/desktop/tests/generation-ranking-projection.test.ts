import { describe, expect, it } from 'vitest';
import { getCombatantRankingEntityKey } from '@mahoshojo/domain/arena-file-parser';
import { PRESET_LIST } from '@mahoshojo/domain/presets';
import { projectDesktopGenerationRanking } from '../src/features/arena/generation-ranking-projection';
import { clearDesktopArenaSource, isDesktopStrictSource, projectDesktopArenaCombatant } from '../src/features/arena/strict-source';
import type { ArenaDraft } from '../src/features/arena/session';
import { rankingParticipant, readyRanking } from './helpers/generation-ranking-fixture';

const card = (id: string): Extract<ArenaDraft['combatants'][number], { data: unknown }> => ({
  type: 'general-character', filename: '同名.json', isPreset: false, isValid: false, desktopSource: 'online', sourceDataCardId: id,
  data: { name: '同名角色', content: '原文' },
});
const a = card('a'), b = card('b'), pa = rankingParticipant('data_card:a'), pb = rankingParticipant('data_card:b');
const project = (patch: Partial<Parameters<typeof projectDesktopGenerationRanking>[0]> = {}) => projectDesktopGenerationRanking({
  current: [a, b], frozen: [a, b], ranking: readyRanking([pa, pb]), hostedGenerationId: 'generation-a', ...patch,
});

describe('生成时排位历史的展示关联', () => {
  it('占位符不冒充排位实体，也不移动已有角色的结算索引', () => {
    const placeholder = { type: 'random-canshou' as const, id: 'slot', filename: '随机残兽' };
    expect(project({ current: [placeholder, b, a] }).rows).toEqual([null, pb, pa]);
  });
  it('展示 key 与 Web 相同，预设优先且 trim，不取姓名/正文/卡库选择身份', () => {
    expect(getCombatantRankingEntityKey(card(' a '))).toBe('data_card:a');
    expect(getCombatantRankingEntityKey({ ...a, isPreset: true, filename: ' x.json ' })).toBe('preset:x.json');
    expect(getCombatantRankingEntityKey({ ...a, isPreset: true, filename: ' ' })).toBeNull();
    expect(getCombatantRankingEntityKey({ ...a, sourceDataCardId: undefined })).toBeNull();
  });
  it('同名不同实体及重排不按姓名或数组下标串行，删除后重选同实体仍关联', () => {
    expect(project().rows).toEqual([pa, pb]);
    expect(project({ current: [b, a] }).rows).toEqual([pb, pa]);
    expect(project({ current: [b] })).toEqual({ rows: [pb], unmatched: [{ participant: pa, index: 0 }] });
    expect(project({ current: [b, structuredClone(a)] }).rows).toEqual([pb, pa]);
  });
  it.each(['current', 'frozen', 'participants'] as const)('%s 重复 key 不覆盖，并保留所有歧义明细', collection => {
    const result = project(collection === 'participants' ? { ranking: readyRanking([pa, pb, structuredClone(pa)]) }
      : { [collection]: [a, b, structuredClone(a)] });
    expect(result.rows.filter(Boolean)).toEqual([pb]);
    expect(result.unmatched.map(item => item.participant)).toEqual(collection === 'participants' ? [pa, pa] : [pa]);
  });
  it('participant key 与 Web 一样 trim，空白不关联且规范化后重复也保留', () => {
    const spaced = rankingParticipant(' data_card:a ');
    expect(project({ ranking: readyRanking([spaced, pb]) }).rows).toEqual([spaced, pb]);
    expect(project({ ranking: readyRanking([spaced, pa, rankingParticipant(' ')]) }).rows).toEqual([null, null]);
    expect(project({ ranking: readyRanking([spaced, pa, rankingParticipant(' ')]) }).unmatched).toHaveLength(3);
  });
  it('缺 key、改来源和恢复无冻结输入不猜测关联；保留原索引用于匿名名称', () => {
    expect(project({ current: [card('changed'), b] }).unmatched).toEqual([{ participant: pa, index: 0 }]);
    expect(project({ frozen: [card(''), b] }).rows).toEqual([null, pb]);
    expect(project({ ranking: readyRanking([rankingParticipant(null), pb]) }).unmatched[0]?.index).toBe(0);
    expect(project({ frozen: null }).unmatched).toHaveLength(2);
    expect(project({ hostedGenerationId: 'different' }).rows).toEqual([null, null]);
    expect(project({ hostedGenerationId: null }).unmatched).toHaveLength(2);
  });
  it.each([null, { success: false as const, generationId: 'generation-a', error: 'failed' },
    { success: true as const, generationId: 'generation-a', state: 'pending' as const, message: 'pending' }, readyRanking([])])('无明细不制造行结算：%j', ranking => {
    expect(project({ ranking })).toEqual({ rows: [null, null], unmatched: [] });
  });
  it.each(['online', 'preset'] as const)('%s 正文正常更新并清来源后仍展示历史，但 strict 与发送资格不恢复', source => {
    const original = source === 'online' ? a : { ...a, desktopSource: 'preset' as const, isPreset: true, filename: PRESET_LIST[0]!.filename };
    const participant = rankingParticipant(getCombatantRankingEntityKey(original));
    const current = clearDesktopArenaSource({ ...original, data: { name: '更名后', content: '更新正文', signature: 'new' } });
    const before = structuredClone(current);
    expect(isDesktopStrictSource(original)).toBe(true);
    expect(project({ current: [current], frozen: [original], ranking: readyRanking([participant]) }).rows).toEqual([participant]);
    expect(current).toEqual(before); expect(isDesktopStrictSource(current)).toBe(false);
    expect(projectDesktopArenaCombatant(current)).toMatchObject({ isPreset: false });
    expect(projectDesktopArenaCombatant(current).sourceDataCardId).toBeUndefined();
  });
});

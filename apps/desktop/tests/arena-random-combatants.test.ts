import { describe, expect, it, vi } from 'vitest';
import type { CardRepository } from '@mahoshojo/local-library/repository';
import { materializeArenaRandomCombatants, type ArenaRandomCombatantPlaceholder } from '@mahoshojo/domain/arena-random-combatants';
import { ARENA_DRAFT_KEY, DesktopArenaSession, arenaReadinessMessage, buildDesktopArenaInput, createInitialArenaDraft, validateArenaDraft, type ArenaDraft } from '../src/features/arena/session';
import { isArenaRealCombatant } from '../src/features/arena/roster-types';
import { prepareDesktopRoomSource, prepareDesktopRoomStartSource } from '../src/features/arena/room-source';
import { captureDesktopStorySeed } from '../src/features/arena/story-snapshot';
import { projectDesktopRankingRoster } from '../src/features/ranking/arena-ranking-modal';

const memory = () => {
  const values = new Map<string, string>();
  return { values, get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
};
const placeholder = (id = 'random-1', type: ArenaRandomCombatantPlaceholder['type'] = 'random-magical-girl'): ArenaRandomCombatantPlaceholder => ({ id, type, filename: type === 'random-magical-girl' ? '随机魔法少女' : '随机残兽', teamId: 2 });
const real = (name = '已有角色') => ({ type: 'general-character', data: { templateId: '通用角色', name, content: '完整设定' }, isValid: false, isPreset: false, filename: `${name}.json`, teamId: 1 });
const draft = (): ArenaDraft => ({ ...createInitialArenaDraft(), combatants: [placeholder(), real(), placeholder('random-2', 'random-canshou')], teams: [{ id: 1, name: '一队' }, { id: 2, name: '二队' }] });
const factory = () => vi.fn<typeof materializeArenaRandomCombatants>(items => items.map((item, index) => ({ ...real(`生成${index}`), teamId: item.teamId })));
const setup = (materialize = factory(), storage = memory(), extra = {}) => {
  const session = new DesktopArenaSession({ repository: {} as CardRepository, storage, materializeRandomCombatants: materialize, ...extra });
  session.setScope('fixture:direct');
  return { session, storage, materialize };
};

describe('桌面随机占位符草稿与一次物化', () => {
  it('旧实卡草稿仍用 v1；占位符使用 v2，恢复与导出不会抽取角色', () => {
    const f = setup(); f.session.updateDraft({ ...draft(), combatants: [real()] });
    expect(JSON.parse(f.storage.getItem(ARENA_DRAFT_KEY)!).version).toBe(1);
    f.session.updateDraft(draft());
    expect(JSON.parse(f.storage.getItem(ARENA_DRAFT_KEY)!).version).toBe(2);
    f.session.dispose();
    const reopened = setup(factory(), f.storage);
    expect(reopened.session.getSnapshot().pendingRestore).toBe(true);
    expect(JSON.parse(reopened.session.exportDocument())).toMatchObject({ version: 2, draft: { combatants: draft().combatants } });
    expect(() => reopened.session.materializeRandomPlaceholders(reopened.session.getSnapshot().draft)).toThrow();
    reopened.session.restoreDraft();
    expect(reopened.session.getSnapshot().draft.combatants).toEqual(draft().combatants);
    expect(reopened.materialize).not.toHaveBeenCalled(); reopened.session.dispose();
  });

  it('真实默认生成器的未分队角色是可持久化 JSON，不带 undefined 字段', () => {
    const session = new DesktopArenaSession({ repository: {} as CardRepository, storage: memory() });
    session.updateDraft({ ...createInitialArenaDraft(), combatants: [
      { type: 'random-magical-girl', id: 'girl', filename: '随机魔法少女' },
      { type: 'random-canshou', id: 'beast', filename: '随机残兽' },
    ] });
    const next = session.materializeRandomPlaceholders(session.getSnapshot().draft);
    expect(next.combatants).toEqual(JSON.parse(JSON.stringify(next.combatants)));
    expect(next.combatants.every(item => !('teamId' in item))).toBe(true); session.dispose();
  });

  it('v1 实卡草稿正常恢复，不触发随机生成且清除当前来源资格', () => {
    const storage = memory(); storage.setItem(ARENA_DRAFT_KEY, JSON.stringify({ version: 1, draft: { ...draft(), combatants: [{ ...real(), isValid: true, desktopSource: 'online', sourceDataCardId: 'public-source' }] } }));
    const f = setup(factory(), storage); expect(f.session.getSnapshot().pendingRestore).toBe(true); f.session.restoreDraft();
    expect(f.session.getSnapshot().draft.combatants[0]).toMatchObject({ isValid: false, data: real().data });
    expect(f.session.getSnapshot().draft.combatants[0]).not.toHaveProperty('desktopSource');
    expect(f.materialize).not.toHaveBeenCalled(); f.session.dispose();
  });

  it.each([1, 3])('版本 %s 下的占位草稿拒绝且编辑/保存/退出不会覆盖原文', version => {
    const storage = memory(), raw = JSON.stringify({ version, draft: draft() }); storage.setItem(ARENA_DRAFT_KEY, raw);
    const f = setup(factory(), storage);
    expect(f.session.getSnapshot().draftError).toContain('原数据已保留');
    f.session.updateDraft({ ...createInitialArenaDraft(), combatants: [real()] }); f.session.retryDraftSave();
    expect(JSON.parse(f.session.exportDocument()).protectedLocalDraft.raw).toBe(raw);
    f.session.dispose(); expect(storage.getItem(ARENA_DRAFT_KEY)).toBe(raw); expect(f.materialize).not.toHaveBeenCalled();
  });

  it('先实卡后随机角色，保留队伍且仅一次安装，后续重试不重抽', () => {
    const f = setup(); f.session.updateDraft(draft()); const source = f.session.getSnapshot().draft;
    const next = f.session.materializeRandomPlaceholders(source);
    expect(next.combatants.map(item => item.filename)).toEqual(['已有角色.json', '生成0.json', '生成1.json']);
    expect(next.combatants.map(item => item.teamId)).toEqual([1, 2, 2]);
    expect(next.combatants.every(isArenaRealCombatant)).toBe(true);
    expect(next.combatants.slice(1).every(item => isArenaRealCombatant(item) && !item.isValid && !item.isPreset && !('id' in item) && !item.desktopSource)).toBe(true);
    expect(f.session.materializeRandomPlaceholders(next)).toBe(next); expect(f.materialize).toHaveBeenCalledTimes(1);
    expect(JSON.parse(f.storage.getItem(ARENA_DRAFT_KEY)!).version).toBe(1);
    expect(() => f.session.materializeRandomPlaceholders(source)).toThrow(); f.session.dispose();
  });

  it.each(['generator', 'budget'] as const)('%s 失败时整批不安装、不覆盖占位符', kind => {
    const materialize = factory(); materialize.mockImplementation(items => {
      if (kind === 'generator') { items.map((_, index) => { if (index === 1) throw new Error('第二次生成失败'); return real('首次成功'); }); }
      return items.map(() => ({ ...real(), data: { name: '过大', content: 'x'.repeat(13 * 1024 * 1024) } }));
    });
    const f = setup(materialize); f.session.updateDraft(draft()); const before = f.session.getSnapshot().draft, raw = f.storage.getItem(ARENA_DRAFT_KEY);
    expect(() => f.session.materializeRandomPlaceholders(before)).toThrow();
    expect(f.session.getSnapshot().draft).toBe(before); expect(f.storage.getItem(ARENA_DRAFT_KEY)).toBe(raw); f.session.dispose();
  });

  it('占位符计入 32 人上限，不能夹带来源资格或正文；预览就绪不等于允许发送', async () => {
    const two = { ...draft(), combatants: [placeholder(), placeholder('second')] };
    expect(arenaReadinessMessage(two, 'battle', true)).toBeNull();
    expect(arenaReadinessMessage(two)).toContain('尚未生成'); expect(() => buildDesktopArenaInput(two)).toThrow('尚未生成');
    expect(validateArenaDraft({ ...two, combatants: Array.from({ length: 32 }, (_, i) => placeholder(String(i))) }).combatants).toHaveLength(32);
    expect(() => validateArenaDraft({ ...two, combatants: Array.from({ length: 33 }, (_, i) => placeholder(String(i))) })).toThrow();
    for (const extra of [{ data: {} }, { isValid: true }, { desktopSource: 'online' }]) expect(() => validateArenaDraft({ ...two, combatants: [{ ...placeholder(), ...extra }] })).toThrow();
    expect(() => captureDesktopStorySeed(two, 'battle')).toThrow('尚未生成');
    expect(projectDesktopRankingRoster(two.combatants)).toEqual({ rankableRosterEntities: [], selectedEntityKeys: new Set() });
    expect(await prepareDesktopRoomSource(two)).toMatchObject({ ok: false, issues: [expect.stringContaining('随机占位符')] });
    await expect(prepareDesktopRoomStartSource(two)).rejects.toThrow('尚未生成');
  });

  it.each(['direct', 'hosted'] as const)('%s 只能收到物化实卡，生成失败后再次提交不重新抽取', async mode => {
    const execute = vi.fn(async () => { throw new Error('合成生成失败'); });
    const f = setup(factory(), memory(), mode === 'direct' ? { execute } : { executeHosted: execute });
    f.session.updateDraft(draft());
    const send = async (input: ArenaDraft) => mode === 'direct'
      ? f.session.generate({ profileId: 'fixture' }, input, { mode: 'direct-local', generationMode: 'non-stream', modelId: 'fixture' })
      : f.session.generateHosted({}, input, { mode: 'hosted', generationMode: 'non-stream', modelId: 'default', systemConfig: {} }, { kind: 'anonymous' });
    await send(f.session.getSnapshot().draft); expect(execute).not.toHaveBeenCalled();
    const next = f.session.materializeRandomPlaceholders(f.session.getSnapshot().draft);
    await send(next); expect(execute).toHaveBeenCalledTimes(1);
    const sent = execute.mock.calls[0] as unknown as unknown[];
    expect((sent[1] as { combatants: unknown[] }).combatants).toEqual(buildDesktopArenaInput(next).combatants);
    await send(f.session.materializeRandomPlaceholders(f.session.getSnapshot().draft));
    expect(execute).toHaveBeenCalledTimes(2); expect(f.materialize).toHaveBeenCalledTimes(1); f.session.dispose();
  });
});

import { requireArenaRealCombatants } from '../src/features/arena/roster-types';
import { describe, expect, it, vi } from 'vitest';
import type { CardRepository } from '@mahoshojo/local-library/repository';
import type { LocalCardRecordV1 } from '@mahoshojo/local-library/record';
import { DesktopArenaSession, createInitialArenaDraft } from '../src/features/arena/session';
import { projectDesktopRoleUpdates } from '../src/features/arena/role-update-presentation';
import type { executeArenaDirect } from '../src/features/arena/direct';

const generationId = 'manual-repair-generation';
const markdown = '# 修复测试\n\n' + '两位角色共同经历了这场事件。'.repeat(12) + '\n\n## 胜利者\n\n- 甲';
const ports = () => ({ canApply: () => true, confirmTrustDowngrade: vi.fn(() => true), confirmCreateMissingEffects: vi.fn(() => true) });
const patch = (impact = '手工修正') => JSON.stringify({ impacts: [{ combatantIndex: 0, characterName: '甲', impact }] });
async function fixture(writeEffects = true) {
  const values = new Map<string, string>(), records = new Map<string, LocalCardRecordV1>();
  const repository = { get: vi.fn(async (id: string) => records.get(id) ?? null), putIfAbsent: vi.fn(async (record: LocalCardRecordV1) => {
    if (records.has(record.id)) return { alreadyPresent: true };
    records.set(record.id, record); return { written: true };
  }) } as unknown as CardRepository;
  const execute: typeof executeArenaDirect = async (_options, _input, intent, host) => ({
    status: 'completed', scopeKey: host.scopeKey, requestId: intent.requestId, mode: intent.mode,
    rawText: markdown, markdown, reasoning: '', metaStatus: 'valid',
    terminal: { requestId: intent.requestId, contractVersion: 1, mode: intent.mode, status: 'completed', finishReason: 'stop', output: { text: markdown } },
    report: { headline: '修复测试', reporterInfo: { name: '记者', publication: '刊物' }, article: { body: markdown, analysis: '共同成长' }, officialReport: { winner: '甲', conclusion: '合作' } },
    impacts: [{ characterName: '甲', impact: '原影响', currentStateSummary: '原状态' }],
  });
  const session = new DesktopArenaSession({ repository, storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } }, execute,
    requestId: () => generationId, now: () => '2026-10-21T19:00:00.000Z' });
  session.setScope('account-A');
  const initial = createInitialArenaDraft();
  const draft = { ...initial, settings: { ...initial.settings, writeArenaHistory: writeEffects, writeCurrentState: writeEffects },
    combatants: ['甲', '乙'].map(name => ({ type: 'general-character' as const, filename: `${name}.json`, isValid: false, isPreset: false,
      data: { name, templateId: '通用角色', content: '设定', signature: 'old-signature', metadata: { signature: 'legacy' } } })) };
  session.updateDraft(draft);
  await session.generate({ invoke: vi.fn(), profileId: 'local' }, draft, { mode: 'direct-local', generationMode: 'non-stream', modelId: 'fixture' });
  expect(session.getSnapshot().phase).toBe('completed');
  return { session, records, repository };
}

describe('Desktop explicit unsigned manual repair', () => {
  it('未物化占位只阻断当前名单修复，旧生成与修复候选仍可独立保存', async () => {
    const f = await fixture();
    const original = projectDesktopRoleUpdates(f.session.getSnapshot())[0]!.selection!;
    await f.session.applyManualRepair(patch(), ports());
    const repaired = projectDesktopRoleUpdates(f.session.getSnapshot())[0]!.repairSelection!;
    const before = f.session.getSnapshot();
    f.session.updateDraft({ ...before.draft, combatants: [...before.draft.combatants,
      { type: 'random-canshou', id: 'slot', filename: '随机残兽' }] });
    const withPlaceholder = f.session.getSnapshot();
    await expect(f.session.applyManualRepair(patch('不可写入'), ports())).rejects.toThrow('当前名单含尚未生成的随机角色');
    expect(f.session.getSnapshot().draft).toBe(withPlaceholder.draft);
    expect(f.session.getSnapshot().candidates).toBe(before.candidates);
    expect(f.session.getSnapshot().repairs).toBe(before.repairs);
    expect(f.session.canSaveCharacter(original)).toBe(true);
    expect(f.session.canSaveRepairedCharacter(repaired)).toBe(true);
    expect(await f.session.saveRepairedCharacters(repaired)).toBe(true);
    expect(await f.session.saveCharacter(original)).toBe(true);
    f.session.dispose();
  });
  it('updates only working copies; exports and independent saves use edited data, D2 does not', async () => {
    const f = await fixture(), before = f.session.getSnapshot(), original = projectDesktopRoleUpdates(before)[0]!.selection!;
    const untouched = before.draft.combatants[1];
    await f.session.applyManualRepair(patch(), ports());
    const state = f.session.getSnapshot(), displayed = projectDesktopRoleUpdates(state)[0]!;
    expect(state.draft.combatants[1]).toBe(untouched);
    expect(displayed.impact).toBe('手工修正'); expect(displayed.selection).toBeNull();
    expect(displayed.data).not.toHaveProperty('signature'); expect(displayed.data.metadata).not.toHaveProperty('signature');
    expect(state.candidates).toBe(before.candidates);
    expect(f.session.canSaveCharacter(displayed.repairSelection!)).toBe(false);
    expect(f.session.canSaveCharacter(original)).toBe(true);
    expect(f.records.size).toBe(0);
    expect(JSON.parse(f.session.exportDocument()).result.repairs.items[0].data).toEqual(displayed.data);
    expect(await f.session.saveRepairedCharacters(displayed.repairSelection!)).toBe(true);
    expect([...f.records.values()][0]?.provenance).toEqual({ kind: 'unsigned', execution: 'edited' });
    expect([...f.records.values()][0]?.data).toEqual(displayed.data);
    f.session.dispose();
  });
  it('no-op preserves references and trust, actual edits clear only touched Desktop source', async () => {
    const f = await fixture(), state = f.session.getSnapshot();
    f.session.updateDraft({ ...state.draft, combatants: requireArenaRealCombatants(state.draft.combatants).map((item, index) => index ? item : {
      ...item, isValid: true, isPreset: true, desktopSource: 'preset' as const, sourceDataCardId: 'source', data: { ...item.data, signature: 'native' },
    }) });
    const before = f.session.getSnapshot().draft.combatants, confirm = ports();
    expect(await f.session.applyManualRepair(patch('原影响'), confirm)).toContain('未修改');
    expect(f.session.getSnapshot().draft.combatants).toBe(before); expect(confirm.confirmTrustDowngrade).not.toHaveBeenCalled();
    await f.session.applyManualRepair(patch(), confirm);
    expect(confirm.confirmTrustDowngrade).toHaveBeenCalledOnce();
    const changed = requireArenaRealCombatants(f.session.getSnapshot().draft.combatants)[0]!;
    expect(changed).not.toHaveProperty('desktopSource'); expect(changed).not.toHaveProperty('sourceDataCardId'); expect(changed.isValid).toBe(false);
    f.session.dispose();
  });
  it('missing effect requires confirmation, and repeated edits patch rather than append', async () => {
    const f = await fixture(false), denied = { ...ports(), confirmCreateMissingEffects: () => false };
    const before = f.session.getSnapshot().draft;
    expect(await f.session.applyManualRepair(patch(), denied)).toContain('取消'); expect(f.session.getSnapshot().draft).toBe(before);
    const confirmed = ports(); await f.session.applyManualRepair(patch(), confirmed);
    expect(confirmed.confirmCreateMissingEffects).toHaveBeenCalledOnce();
    await f.session.applyManualRepair(patch('再次修正'), ports());
    expect((requireArenaRealCombatants(f.session.getSnapshot().draft.combatants)[0]!.data.arena_history as { entries: unknown[] }).entries).toHaveLength(1);
    f.session.dispose();
  });
  it('source lock and changed account reject; delayed confirmation cannot publish', async () => {
    const f = await fixture(false), before = f.session.getSnapshot().draft;
    await expect(f.session.applyManualRepair(patch(), { ...ports(), canApply: () => false })).rejects.toThrow();
    let release!: (value: boolean) => void, entered!: () => void;
    const confirmation = new Promise<void>(resolve => { entered = resolve; });
    const task = f.session.applyManualRepair(patch(), { ...ports(), confirmTrustDowngrade: () => new Promise<boolean>(resolve => { release = resolve; entered(); }) });
    await confirmation;
    f.session.setScope('account-B');
    const afterScope = f.session.getSnapshot().draft;
    expect(afterScope.combatants).toBe(before.combatants);
    release(true);
    await expect(task).rejects.toThrow('上下文');
    expect(f.session.getSnapshot().draft).toBe(afterScope); expect(f.records.size).toBe(0); f.session.dispose();
  });
  it('bad subset is atomic, and save failure retains editable/exportable derivatives', async () => {
    const f = await fixture(), before = f.session.getSnapshot().draft;
    await expect(f.session.applyManualRepair('{"impacts":[{"combatantIndex":1,"characterName":"甲","impact":"错位"}]}', ports())).rejects.toThrow();
    expect(f.session.getSnapshot().draft).toBe(before);
    await f.session.applyManualRepair(patch(), ports());
    vi.mocked(f.repository.putIfAbsent).mockRejectedValueOnce(new Error('disk full'));
    expect(await f.session.saveRepairedCharacters()).toBe(false); expect(f.session.getSnapshot().repairs?.items).toHaveLength(1);
    expect(await f.session.saveRepairedCharacters()).toBe(true); f.session.dispose();
  });
});

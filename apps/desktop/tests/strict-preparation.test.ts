import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CardRepository } from '@mahoshojo/local-library/repository';
import { PRESET_LIST } from '@mahoshojo/domain/presets';
import { SCENARIO_PRESET_LIST } from '@mahoshojo/domain/scenario-presets';
import type { PublicSeasonMeta } from '@mahoshojo/contracts/public-ranking';
import { buildArenaGenerationInputSnapshot } from '@mahoshojo/ai-core/arena-generation';
import { resolveDesktopAiTarget } from '../src/features/ai-config/desktop-ai-config';
import { ARENA_DRAFT_KEY, DesktopArenaSession, createInitialArenaDraft, buildDesktopArenaInput, inheritedArenaAdjudication, type ArenaDraft } from '../src/features/arena/session';
import { clearDesktopArenaSource, retainDesktopArenaSelectionSource } from '../src/features/arena/strict-source';
import { prepareDesktopStrictDraft } from '../src/features/arena/strict-preparation';
import { buildDesktopStrictPreflightInput } from '../src/features/arena/strict-preflight-input';
import { describeDesktopStrictSetup } from '../src/features/arena/strict-setup';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }));
const season: PublicSeasonMeta = { id: 'S1', name: '合成', status: 'current', startsAt: '', description: '' };
const draft = (): ArenaDraft => ({ ...createInitialArenaDraft(), combatants: [
  { type: 'general-character', data: { name: '真实线上原件', content: '原文', signature: 'unverified' }, filename: 'online.json', isPreset: false, isValid: false, sourceDataCardId: 'online-id', desktopSource: 'online' },
  { type: 'general-character', data: { name: '预设原件', content: '原文' }, filename: PRESET_LIST[0]!.filename, isPreset: true, isValid: false, desktopSource: 'preset' },
] });
const target = resolveDesktopAiTarget({ executionPreference: 'server', clientConnectionId: null }, [], {}, {}, {});
afterEach(() => vi.unstubAllGlobals());

describe('Desktop Strict preparation source and dispatch projection', () => {
  it('retains current online/preset references in both advisory and real generation without granting native authority', () => {
    const input = draft(), before = structuredClone(input);
    const advisory = buildDesktopStrictPreflightInput(input, target, 0);
    const generated = buildArenaGenerationInputSnapshot(buildDesktopArenaInput(input));
    expect(advisory.combatants).toMatchObject([{ sourceDataCardId: 'online-id', isPreset: false }, { filename: PRESET_LIST[0]!.filename, isPreset: true }]);
    expect(generated.combatants).toMatchObject([{ sourceDataCardId: 'online-id', isNative: false }, { isPreset: true, isNative: false }]);
    expect(advisory.combatants[0]).not.toHaveProperty('data'); expect(input).toEqual(before);
  });
  it('strips forged/restored/uploaded/cache IDs and same-name scenario files from every new dispatch', () => {
    const input = draft(); input.combatants = input.combatants.map(card => ({ ...clearDesktopArenaSource(card), data: { ...card.data, cloudRef: { id: 'forged' }, _cardId: 'forged' } }));
    input.battleMode = 'scenario'; input.scenario = { content: { title: '上传' }, fileName: SCENARIO_PRESET_LIST[0]!.filename };
    const generated = buildArenaGenerationInputSnapshot(buildDesktopArenaInput(input));
    expect(generated.combatants.every(card => !card.isPreset && card.sourceDataCardId === undefined)).toBe(true);
    expect(generated.scenarioFileName).toBeNull(); expect(buildDesktopStrictPreflightInput(input, target, 0).combatants.every(card => !card.isPreset && card.sourceDataCardId === null)).toBe(true);
    expect(input.combatants[0]!.sourceDataCardId).toBe('online-id'); // historical reference retained in draft only
  });
  it('restoring persisted provenance cannot restore active selection identity', () => {
    const input = draft(); input.scenario = { content: null, fileName: SCENARIO_PRESET_LIST[0]!.filename, isPreset: true };
    const saved = new Map([[ARENA_DRAFT_KEY, JSON.stringify({ version: 1, draft: input })]]);
    const session = new DesktopArenaSession({ repository: {} as CardRepository, storage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => { saved.set(key, value); }, removeItem: key => { saved.delete(key); } } });
    session.restoreDraft(); const restored = session.getSnapshot().draft;
    expect(restored.combatants.every(card => card.desktopSource === undefined)).toBe(true); expect(restored.scenario.isPreset).toBe(false);
    expect(buildArenaGenerationInputSnapshot(buildDesktopArenaInput(restored)).combatants.every(card => !card.isPreset && !card.sourceDataCardId)).toBe(true);
    session.dispose();
  });
  it('applies shared settings without touching ordinary write flags, free ranking or signed bodies', async () => {
    const input = draft(); input.combatants = input.combatants.map(card => ({ ...card, characterGuidance: '行动', data: { ...card.data, adjudicationEvents: [{ type: 'binary', description: '原事件', probability: 50 }] } }));
    const before = structuredClone(input);
    const prepared = await prepareDesktopStrictDraft(input, season, new AbortController().signal);
    expect(input).toEqual(before); expect(prepared.combatants.map(card => card.data)).toEqual(input.combatants.map(card => card.data));
    expect(prepared.settings).toMatchObject({ userGuidance: '', readArenaHistory: false, readCurrentState: false, readNarrativeHistory: false,
      writeArenaHistory: input.settings.writeArenaHistory, writeCurrentState: input.settings.writeCurrentState });
    expect(prepared.arenaFreeRankingEnabled).toBe(false); expect(prepared.combatants.every(card => card.characterGuidance === '')).toBe(true);
    expect(inheritedArenaAdjudication(prepared, 'battle').events).toHaveLength(2);
    expect(describeDesktopStrictSetup({ draft: prepared, isAuthenticated: true, executionLocation: 'server', modelId: 'default', modelUnavailable: false, adjudicationEventCount: 2 }, season).reasons).toContain('需清空「随机判定器事件」');
  });
  it('sets scenario provenance only after successful known preset fetch and rejects unknown resources', async () => {
    const filename = SCENARIO_PRESET_LIST[0]!.filename;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ templateId: '通用情景', title: '合成情景', content: '原文' }))));
    const prepared = await prepareDesktopStrictDraft(draft(), { ...season, specialRules: { mode: 'scenario', scenarioPresetFilename: filename } }, new AbortController().signal);
    expect(prepared.scenario).toMatchObject({ fileName: filename, isPreset: true });
    expect(fetch).toHaveBeenCalledWith(`/scenario-presets/${filename}`, expect.objectContaining({ credentials: 'omit', redirect: 'error' }));
    await expect(prepareDesktopStrictDraft(draft(), { ...season, specialRules: { mode: 'scenario', scenarioPresetFilename: 'unknown.json' } }, new AbortController().signal)).rejects.toThrow('尚不能识别');
    await expect(prepareDesktopStrictDraft(draft(), { ...season, specialRules: { questionnaireLorePresetIds: ['unknown'] } }, new AbortController().signal)).rejects.toThrow('未找到');
  });
});


it('keeps complete selected cloud/preset source bodies even when the generic parser would normalize nested fields', () => {
  const raw = { name: '原件', nested: { unknownField: 'must-survive' }, legacyValue: 'legacy', signature: 'original' };
  const parsed = [{ ...draft().combatants[0]!, data: { name: '原件', nested: {} } }];
  for (const source of [{ kind: 'online' as const, cardId: 'cloud-id' }, { kind: 'preset' as const, filename: PRESET_LIST[0]!.filename }]) {
    const cards = retainDesktopArenaSelectionSource(parsed, raw, source);
    expect(cards[0]!.data).toEqual(raw); expect(cards[0]!.data).not.toBe(raw);
    expect(buildArenaGenerationInputSnapshot(buildDesktopArenaInput({ ...draft(), combatants: cards })).combatants[0]!.data).toEqual(raw);
  }
  expect(() => retainDesktopArenaSelectionSource([...parsed, ...parsed], raw, { kind: 'online', cardId: 'cloud' })).toThrow('单张');
});

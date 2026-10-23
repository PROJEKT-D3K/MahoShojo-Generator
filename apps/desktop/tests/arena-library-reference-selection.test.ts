import { buildArenaGenerationInputSnapshot } from '@mahoshojo/ai-core/arena-generation';
import { describe, expect, it } from 'vitest';
import { applyArenaLibraryReferenceSelection, getArenaReferenceSelectionId } from '../src/features/arena/library-selection';
import { buildDesktopArenaInput, createInitialArenaDraft, validateArenaDraft, type ArenaDraft } from '../src/features/arena/session';
import type { CardLibrarySelectionContext } from '@mahoshojo/ui-web/card-library';

const scenario = { templateId: '通用情景', title: '同名情景', content: '原件',
  adjudicationEvents: [{ id: 'event', type: 'binary', description: '来源事件', probability: 100 }] };
const initial = (): ArenaDraft => ({ ...createInitialArenaDraft(), battleMode: 'scenario', scenario: { content: scenario, fileName: null } });
const options = { advanced: true, createId: () => 'reference-id', onWarning: () => {} };
const context = (location: 'local' | 'cache' | 'cloud', raw: CardLibrarySelectionContext['rawSourceData'] = scenario): CardLibrarySelectionContext => ({
  storageLocation: location, selectionId: `${location}:same-id`, rawSourceData: raw,
  ...(location === 'cloud' ? { cloudCardId: 'same-id', cloudCardUpdatedAt: 'current-version' } : {}),
});

describe('Arena reference library admission', () => {
  it.each(['auxScenario', 'material'] as const)('%s distinguishes local, cached and online rows and removes exactly one', purpose => {
    let draft = initial();
    for (const location of ['local', 'cache', 'cloud'] as const) {
      draft = applyArenaLibraryReferenceSelection(draft, purpose, true, context(location), options);
    }
    const items = (value: ArenaDraft) => purpose === 'auxScenario' ? value.auxScenarios : value.materials;
    expect(items(draft).map(getArenaReferenceSelectionId)).toEqual(['local:same-id', 'cache:same-id', 'cloud:same-id']);
    expect(applyArenaLibraryReferenceSelection(draft, purpose, true, context('cloud'), options)).toBe(draft);
    draft = applyArenaLibraryReferenceSelection(draft, purpose, false, { ...context('cache'), rawSourceData: undefined }, options);
    expect(items(draft).map(getArenaReferenceSelectionId)).toEqual(['local:same-id', 'cloud:same-id']);
    if (purpose === 'auxScenario') {
      expect(draft.adjudicationEvents).toHaveLength(2);
      expect(draft.adjudicationEvents).toMatchObject([{ sourceKey: 'data_card:local:same-id' }, { sourceKey: 'data_card:same-id' }]);
    }
    expect(validateArenaDraft(draft, 'arena')).toEqual(draft);
    const input = buildArenaGenerationInputSnapshot(buildDesktopArenaInput(draft, 'arena'));
    const sent = purpose === 'auxScenario' ? input.auxScenarios : input.materials;
    for (const item of sent ?? []) expect(item).not.toHaveProperty('cardLibrarySelectionId');
  });

  it('keeps shared main/auxiliary source events merged and removes them by the existing global source key', () => {
    const source = context('cloud');
    let draft = applyArenaLibraryReferenceSelection(initial(), 'scenario', true, source, options);
    draft = applyArenaLibraryReferenceSelection(draft, 'auxScenario', true, source, options);
    expect(draft.adjudicationEvents).toEqual([expect.objectContaining({ sourceKey: 'data_card:same-id', description: '来源事件' })]);
    draft = applyArenaLibraryReferenceSelection(draft, 'auxScenario', false, source, options);
    expect(draft.scenario.content).toBeTruthy(); expect(draft.auxScenarios).toHaveLength(0);
    expect(draft.adjudicationEvents).toEqual([]);
  });

  it('retains the visible cache row identity after a fresh cloud read without conflating it with a cloud row', () => {
    const selected = applyArenaLibraryReferenceSelection(initial(), 'material', true,
      { ...context('cloud'), rowSelectionId: 'cache:same-id' }, options);
    expect(selected.materials[0]).toMatchObject({ cardLibrarySelectionId: 'cache:same-id', sourceDataCardId: 'same-id' });
    const removed = applyArenaLibraryReferenceSelection(selected, 'material', false,
      { selectionId: 'cache:same-id', storageLocation: 'cache' }, options);
    expect(removed.materials).toHaveLength(0);
  });

  it.each(['local', 'cache'] as const)('does not elevate %s body IDs to online references or send local picker metadata', location => {
    const raw = { ...scenario, _cardId: 'untrusted', sourceDataCardId: 'untrusted', sourceDataCardUpdatedAt: 'old' };
    const selected = applyArenaLibraryReferenceSelection(initial(), 'material', true, context(location, raw), options);
    expect(selected.materials[0]).not.toHaveProperty('sourceDataCardId');
    expect(selected.materials[0]).not.toHaveProperty('sourceDataCardUpdatedAt');
    expect(selected.materials[0]).toHaveProperty('content.sourceDataCardId', 'untrusted');
    expect(buildDesktopArenaInput(selected, 'arena').materials[0]).not.toHaveProperty('cardLibrarySelectionId');
    expect(raw.sourceDataCardId).toBe('untrusted');
  });

  it.each(['auxScenario', 'material'] as const)('%s enforces the current shared budget but permits duplicate no-op and removal at capacity', purpose => {
    const first = applyArenaLibraryReferenceSelection(initial(), purpose, true, context('local'), options);
    const full = { ...first, materials: [...first.materials, ...Array.from({ length: 255 }, (_, index) => ({ id: String(index), name: '素材', content: {}, fileName: null, sourceKind: 'raw-json', sourceType: 'raw-json', isNative: false }))] };
    expect(() => applyArenaLibraryReferenceSelection(full, purpose, true, context('cloud'), options)).toThrow('256');
    expect(applyArenaLibraryReferenceSelection(full, purpose, true, context('local'), options)).toBe(full);
    expect(() => applyArenaLibraryReferenceSelection(full, purpose, false, context('local'), options)).not.toThrow();
  });

  it('rejects invalid scenarios and mismatched cloud identity without changing the original draft', () => {
    const draft = initial();
    expect(() => applyArenaLibraryReferenceSelection(draft, 'auxScenario', true, context('local', { name: '角色', content: '角色正文', templateId: '通用角色' }), options)).toThrow();
    expect(() => applyArenaLibraryReferenceSelection(draft, 'material', true, { ...context('cloud'), cloudCardId: 'other' }, options)).toThrow('身份');
    expect(draft.auxScenarios).toEqual([]); expect(draft.materials).toEqual([]);
  });
});

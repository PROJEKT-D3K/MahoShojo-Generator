import { describe, expect, it, vi } from 'vitest';
import { ArenaRoomProposalSubmitRequestSchema, type ArenaRoomSharedConfig } from '@mahoshojo/contracts/arena-room';
import { createArenaMemberProposalModel } from '../src/member-proposal';
import { ARENA_ROOM_PRESET_CATALOG } from '../src/preset-catalog';

const ref = (id: string, kind: 'character' | 'scenario' | 'material' = 'character', versionToken = 'observed-v1') => ({ id, kind, versionToken });
const config = (): ArenaRoomSharedConfig => ({
  battleMode: 'classic', reportFormat: 'markdown', combatants: ['a', 'b', 'c'].map(id => ({ key: `data-card:${id}`, ref: { ...ref(id), kind: 'character' as const } })),
  teams: [{ key: 'team:one', displayName: '一队', combatantKeys: ['data-card:b', 'data-card:a'] }],
  scenario: null, auxScenarios: [], materials: [], userGuidance: '', storyLength: 'default', customStoryLength: null, selectedLanguage: 'zh-CN',
  historySettings: { readArenaHistory: true, readArenaHistoryLimit: 3, isArenaHistoryUnlimited: false, writeArenaHistory: true, readCurrentState: true, writeCurrentState: true,
    readNarrativeHistory: false, readNarrativeHistoryLimit: 10, isNarrativeHistoryUnlimited: false, writeNarrativeHistory: false },
});
const snapshot = (revision = 7, sharedConfig = config(), roomEpoch = 'epoch-1') => ({ roomId: 'room-1', roomEpoch, revision, sharedConfig });
const changed = () => { const model = createArenaMemberProposalModel(snapshot()); model.actions.setUserGuidance('用户看过的 A'); return model; };

describe('detached member proposal model', () => {
  it('detaches source, freezes snapshots and exports copies without touching ordinary state', () => {
    const original = snapshot(), saved = JSON.stringify(original), model = createArenaMemberProposalModel(original);
    model.actions.setUserGuidance('成员修改');
    expect(JSON.stringify(original)).toBe(saved);
    const exported = model.exportSharedConfig(), entry = exported.combatants[0]!;
    if (!('ref' in entry)) throw new Error('Expected reference fixture');
    entry.ref.versionToken = 'external-mutation';
    expect(model.exportSharedConfig().combatants[0]).toMatchObject({ ref: { versionToken: 'observed-v1' } });
    const frozen = model.store.getState().editor.workingConfig.combatants[0]!;
    if (!('ref' in frozen)) throw new Error('Expected reference fixture');
    expect(Object.isFrozen(frozen.ref)).toBe(true);
    expect(model.store.getInitialState().editor.workingConfig.userGuidance).toBe('');
  });

  it('dispatches exactly the frozen valid preview once, including nested values', () => {
    const model = changed(), preview = model.preparePreview('proposal-frozen');
    expect(preview.intent).toMatchObject({ proposalId: 'proposal-frozen', expectedRoomEpoch: 'epoch-1', baseRevision: 7,
      changes: [expect.objectContaining({ type: 'setUserGuidance', value: '用户看过的 A' })] });
    expect(ArenaRoomProposalSubmitRequestSchema.safeParse(preview.intent).success).toBe(true);
    expect(Object.isFrozen(preview.intent)).toBe(true); expect(Object.isFrozen(preview.intent!.changes[0])).toBe(true);
    const intent = model.takePreviewIntent(preview); expect(intent).toBe(preview.intent);
    expect(model.isPreviewCurrent(preview)).toBe(false); expect(() => model.takePreviewIntent(preview)).toThrow();
  });

  it('invalidates same-change-ID content edits permanently, even after returning to the old value', () => {
    const model = changed(), preview = model.preparePreview('proposal-before-edit');
    model.actions.setUserGuidance('后来修改的 B');
    expect(model.preparePreview('proposal-after-edit').changes[0]!.changeId).toBe(preview.changes[0]!.changeId);
    expect(() => model.takePreviewIntent(preview)).toThrow();
    model.actions.setUserGuidance('用户看过的 A'); expect(model.isPreviewCurrent(preview)).toBe(false);
    expect(preview.intent!.changes[0]).toMatchObject({ value: '用户看过的 A' });
  });

  it('dismisses a confirmation without editing the draft or invalidating an in-flight source generation', () => {
    const model = changed(), preview = model.preparePreview('dismissed'), before = model.store.getState();
    model.dismissPreview();
    expect(model.store.getState()).toBe(before);
    expect(model.isPreviewCurrent(preview)).toBe(false); expect(() => model.takePreviewIntent(preview)).toThrow();
    expect(model.preparePreview('reopened').intent).not.toBeNull();
  });

  it('keeps only the latest preview confirmation even without a configuration change', () => {
    const model = changed(), first = model.preparePreview('proposal-first'), second = model.preparePreview('proposal-second');
    expect(model.isPreviewCurrent(first)).toBe(false); expect(() => model.takePreviewIntent(first)).toThrow();
    expect(model.takePreviewIntent(second).proposalId).toBe('proposal-second');
  });

  it('cannot transfer a preview between model instances or forge one by copying fields', () => {
    const first = changed(), second = changed(), preview = first.preparePreview('proposal-model');
    expect(second.isPreviewCurrent(preview)).toBe(false); expect(() => second.takePreviewIntent(preview)).toThrow();
    expect(first.isPreviewCurrent({ ...preview })).toBe(false);
  });

  it('selection supersedes its previous confirmation and does not auto-complete dependencies', () => {
    const model = createArenaMemberProposalModel(snapshot());
    model.actions.selectOnlineReference('character', ref('new-character'));
    model.actions.setCharacterGuidance('data-card:new-character', '新角色行动');
    const all = model.preparePreview('proposal-dependencies');
    const guide = all.changes.find(change => change.type === 'setCharacterGuidance')!; expect(guide).toBeDefined();
    const invalid = model.selectPreview(all, [guide.changeId]);
    expect(invalid.intent).toBeNull(); expect(invalid.issues.length).toBeGreaterThan(0);
    expect(model.isPreviewCurrent(all)).toBe(false); expect(() => model.takePreviewIntent(invalid)).toThrow();
    const restored = model.selectPreview(invalid, all.selectedChangeIds);
    expect(model.isPreviewCurrent(invalid)).toBe(false); expect(restored.intent).not.toBeNull();
    expect(model.takePreviewIntent(restored).changes).toEqual(all.changes);
  });

  it('empty selection has no dispatchable intent and does not silently pick changes', () => {
    const model = changed(), all = model.preparePreview('proposal-empty'), none = model.selectPreview(all, []);
    expect(none.selectedChangeIds).toEqual([]); expect(none.intent).toBeNull(); expect(() => model.takePreviewIntent(none)).toThrow();
  });

  it('preserves a preview across genuine no-op updates and repeated identical authority', () => {
    const model = changed(), preview = model.preparePreview('proposal-noop'), generation = model.store.getState().generation;
    model.actions.setUserGuidance('用户看过的 A'); model.sync(snapshot());
    expect(model.store.getState().generation).toBe(generation); expect(model.isPreviewCurrent(preview)).toBe(true);
  });

  it('clean follows authority, while dirty stays on the old baseline and can submit after a fresh preview', () => {
    const fresh = config(); fresh.selectedLanguage = 'en-US';
    const clean = createArenaMemberProposalModel(snapshot()); clean.sync(snapshot(8, fresh));
    expect(clean.store.getState().editor).toMatchObject({ baselineRevision: 8, dirty: false, stale: false });
    const dirty = changed(), old = dirty.preparePreview('proposal-before-authority'); dirty.sync(snapshot(8, fresh));
    expect(dirty.store.getState().editor).toMatchObject({ baselineRevision: 7, dirty: true, stale: true });
    expect(dirty.exportSharedConfig().userGuidance).toBe('用户看过的 A'); expect(dirty.isPreviewCurrent(old)).toBe(false);
    const renewed = dirty.preparePreview('proposal-old-baseline'); expect(dirty.takePreviewIntent(renewed).baseRevision).toBe(7);
  });

  it('rejects same-revision contradictory authority even while retaining a dirty older baseline', () => {
    const model = changed(), fresh = config(); fresh.selectedLanguage = 'en-US'; model.sync(snapshot(8, fresh));
    const inconsistent = structuredClone(fresh); inconsistent.userGuidance = '同一修订不应有另一个配置';
    expect(() => model.sync(snapshot(8, inconsistent))).toThrow();
    expect(model.exportSharedConfig().userGuidance).toBe('用户看过的 A');
  });

  it('requires explicit replacement on epoch change and never revives the previous preview', () => {
    const model = changed(), old = model.preparePreview('proposal-old-epoch'); model.sync(snapshot(1, config(), 'epoch-2'));
    expect(model.store.getState().editor.replacementRequired).toBe(true); expect(() => model.preparePreview('proposal-blocked')).toThrow();
    model.replace(snapshot(1, config(), 'epoch-2')); model.actions.setUserGuidance('新作用域');
    expect(model.isPreviewCurrent(old)).toBe(false); expect(model.preparePreview('proposal-new-epoch').intent!.expectedRoomEpoch).toBe('epoch-2');
  });

  it('keeps global roster order separate from team member order and cleans membership on removal', () => {
    const model = createArenaMemberProposalModel(snapshot()); model.actions.moveCombatant(0, 2);
    expect(model.exportSharedConfig().combatants.map(item => item.key)).toEqual(['data-card:b', 'data-card:c', 'data-card:a']);
    expect(model.exportSharedConfig().teams[0]!.combatantKeys).toEqual(['data-card:b', 'data-card:a']);
    model.actions.moveTeamMember('team:one', 1, 0); model.actions.createTeam('team:two', '二队');
    model.actions.assignCombatant('data-card:c', 'team:two'); model.actions.renameTeam('team:two', '改名'); model.actions.moveTeam('team:two', -1);
    expect(model.exportSharedConfig().teams.map(team => team.key)).toEqual(['team:two', 'team:one']);
    model.actions.removeCombatant('data-card:a'); expect(model.exportSharedConfig().teams[1]!.combatantKeys).toEqual(['data-card:b']);
    model.actions.removeTeam('team:two'); expect(model.exportSharedConfig().combatants.some(item => item.key === 'data-card:c')).toBe(true);
  });

  it('retains online observed version drift without turning it into an exact-version conflict', () => {
    const model = createArenaMemberProposalModel(snapshot());
    model.actions.selectOnlineReference('character', { ...ref('a', 'character', 'observed-v2'), payload: 'must not enter proposal' } as ReturnType<typeof ref>);
    const item = model.exportSharedConfig().combatants.find(value => value.key === 'data-card:a')!;
    if (!('ref' in item)) throw new Error('Expected reference fixture');
    expect(item.ref.versionToken).toBe('observed-v2'); expect(item.ref).not.toHaveProperty('payload');
    expect(() => model.actions.selectOnlineReference('material', ref('wrong-kind'))).toThrow();
  });

  it('only creates preset refs from the shared exact-digest catalog', () => {
    const preset = ARENA_ROOM_PRESET_CATALOG.find(entry => entry.kind === 'character')!, model = createArenaMemberProposalModel(snapshot());
    model.actions.togglePreset('character', preset.id);
    expect(model.exportSharedConfig().combatants.at(-1)).toMatchObject({ key: `preset:${preset.id}`, ref: { id: preset.id, versionToken: preset.versionToken } });
    expect(() => model.actions.togglePreset('character', 'not-in-catalog.json')).toThrow();
  });

  it('covers scenario/material ordering and all shared scalar controls without transport or persistence', () => {
    const model = createArenaMemberProposalModel(snapshot());
    model.actions.setBattleMode('scenario'); model.actions.selectOnlineReference('scenario', ref('main', 'scenario'));
    for (const id of ['aux-a', 'aux-b']) model.actions.selectOnlineReference('auxScenario', ref(id, 'scenario'));
    for (const id of ['mat-a', 'mat-b']) model.actions.selectOnlineReference('material', ref(id, 'material'));
    model.actions.moveAuxScenario(0, 1); model.actions.moveMaterial(0, 1); model.actions.setStoryLength('detailed'); model.actions.setCustomStoryLength(' 600 ');
    model.actions.setSelectedLanguage('ja'); model.actions.updateHistorySettings({ readArenaHistory: false, readNarrativeHistory: true });
    expect(model.exportSharedConfig()).toMatchObject({ battleMode: 'scenario', storyLength: 'detailed', customStoryLength: '600', selectedLanguage: 'ja', historySettings: { readArenaHistory: false, readNarrativeHistory: true } });
    expect(model.exportSharedConfig().auxScenarios.map(item => item.key)).toEqual(['data-card:aux-b', 'data-card:aux-a']);
    expect(model.exportSharedConfig().materials.map(item => item.key)).toEqual(['data-card:mat-b', 'data-card:mat-a']);
    model.actions.removeAuxScenario('data-card:aux-a'); model.actions.clearAuxScenarios(); model.actions.removeMaterial('data-card:mat-a'); model.actions.clearMaterials(); model.actions.clearScenario();
    expect(model.exportSharedConfig()).toMatchObject({ scenario: null, auxScenarios: [], materials: [] });
  });

  it('disposal is idempotent and fences old actions/previews/subscriptions', () => {
    const model = changed(), listener = vi.fn(), stop = model.store.subscribe(listener), preview = model.preparePreview('proposal-dispose');
    model.dispose(); expect(listener).toHaveBeenCalledTimes(1); model.dispose(); expect(listener).toHaveBeenCalledTimes(1); stop();
    expect(() => model.actions.setUserGuidance('late')).toThrow(); expect(() => model.takePreviewIntent(preview)).toThrow();
    expect(model.store.getState().disposed).toBe(true);
  });
});

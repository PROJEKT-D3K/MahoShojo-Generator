import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopArenaHostedActor } from '@mahoshojo/contracts/desktop-arena-hosted';
import { DesktopArenaStorySession, type PrepareStoryExecution } from '../src/features/arena/story-session';
import { DesktopHostedStorySession } from '../src/features/arena/hosted-story-session';
import { createIpcStoryNativePort } from '../src/platform/arena-story-native';
import { STORY_PENDING_IPC } from '../src/platform/arena-story-pending-native';
import { prepareStoryStorageCommit } from '../src/platform/arena-story-storage';
import { STORY_CANDIDATE_COMMIT_BYTES } from '@mahoshojo/contracts/desktop-arena-story';
import { ARENA_HOSTED_RECOVERY_KEYS } from '../src/features/arena/hosted-recovery';
import { deferred, installStoryCrypto, storyDraft } from './helpers/story-fixture';
import { HostedStoryFixture, hostedStoryInput, type HostedStoryFixtureProduct } from './helpers/hosted-story-fixture';

installStoryCrypto();
beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('owner fixture must not access a real network'); }); });
afterEach(() => vi.restoreAllMocks());
const setup = (options: { fixture?: HostedStoryFixture; product?: HostedStoryFixtureProduct; actor?: DesktopArenaHostedActor; roles?: boolean; prepareCommit?: typeof prepareStoryStorageCommit } = {}) => {
  const fixture = options.fixture ?? new HostedStoryFixture(), product = options.product ?? 'battle';
  const input = hostedStoryInput(product, options.roles ?? true), actor = options.actor ?? { kind: 'anonymous' };
  const onSaved = vi.fn(async () => undefined), onResult = vi.fn(), onState = vi.fn();
  const owner = new DesktopHostedStorySession({ product, port: fixture.port, sink: fixture.sink, storage: fixture.storage, invoke: fixture.invoke,
    now: () => 200, prepareCommit: options.prepareCommit, createChannel: () => ({ onmessage: () => undefined }), wait: async () => undefined, maxReconnectAttempts: 0,
    onState, onResult, onSaved, captureSelection: () => input.selection, loadBaseline: async () => input.session });
  owner.setContext(`actor:${JSON.stringify(actor)}`, actor);
  return { owner, fixture, input, actor, onSaved, onResult, onState,
    generate: () => owner.generate(input, fixture.target(actor), new AbortController().signal) };
};
const roleCalls = (fixture: HostedStoryFixture) => fixture.streams.filter(request => request.operation === 'reconcile-story');
const createCalls = (fixture: HostedStoryFixture) => fixture.streams.filter(request => request.operation === 'create-story-stream');

describe('Hosted continuous-story owner through real TS binders and a synthetic Native peer', () => {
  for (const product of ['battle', 'arena'] as const) for (const actor of [{ kind: 'anonymous' }, { kind: 'account', expectedUserId: 7 }] as DesktopArenaHostedActor[]) {
    it.each(['system', 'preset'] as const)(`${product}/${actor.kind}/%s durably saves start and explicit continuation`, async funding => {
      const fixture = new HostedStoryFixture(); let id = 0;
      const owner = new DesktopArenaStorySession({ port: createIpcStoryNativePort(fixture.invoke), id: () => `fixture-owner-${++id}`, now: () => 200,
        exportMarkdown: async () => ({ absolutePath: '/fixture/export.md', byteLength: 1 }),
        hosted: { product, port: fixture.port, sink: fixture.sink, storage: fixture.storage, invoke: fixture.invoke, now: () => 200,
          createChannel: () => ({ onmessage: () => undefined }), wait: async () => undefined, maxReconnectAttempts: 0 } });
      owner.setExecutionScope(`actor:${JSON.stringify(actor)}`, actor);
      const prepare: PrepareStoryExecution = async run => run(fixture.target(actor, funding));
      const draft = storyDraft(); draft.settings.writeArenaHistory = true; draft.settings.writeCurrentState = true;
      const original = structuredClone(draft), h = { fixture, owner };
      await owner.start({ draft, product }, prepare);
      expect(owner.getSnapshot(), owner.getSnapshot().hosted?.message ?? '').toMatchObject({ phase: 'completed', resultSaved: true, active: { chapterCount: 1, revision: 1 } });
      expect(draft).toEqual(original);
      const sessionId = owner.getSnapshot().active!.id;
      draft.combatants[0]!.data.name = '其它页面角色'; draft.settings.userGuidance = '其它页面引导';
      await owner.continue('第二章独立引导', prepare);
      expect(owner.getSnapshot(), owner.getSnapshot().hosted?.message ?? '').toMatchObject({ phase: 'completed', resultSaved: true, active: { id: sessionId, chapterCount: 2, revision: 2 } });
      expect(createCalls(h.fixture)).toHaveLength(2); expect(roleCalls(h.fixture)).toHaveLength(2);
      expect(h.fixture.commands(STORY_PENDING_IPC.prepareSave)).toHaveLength(2); expect(h.fixture.commands(STORY_PENDING_IPC.save)).toHaveLength(2);
      for (const request of createCalls(h.fixture)) {
        expect(request).toMatchObject({ product, actor }); expect(request).not.toHaveProperty('body'); expect(request).not.toHaveProperty('combatants');
        expect(request).toHaveProperty(funding === 'system' ? 'systemConfig' : 'presetConfig');
      }
      expect(h.fixture.trace.indexOf('sealed:input')).toBeLessThan(h.fixture.trace.indexOf('pointer:write'));
      expect(h.fixture.trace.indexOf('pointer:write')).toBeLessThan(h.fixture.trace.indexOf('native:create-claim'));
      expect(h.fixture.trace.indexOf('model:invoke-settled')).toBeLessThan(h.fixture.trace.indexOf('sealed:completed'));
      expect(h.fixture.trace.indexOf('sealed:completed')).toBeLessThan(h.fixture.trace.indexOf('role:invoke-settled'));
      expect(h.fixture.trace.indexOf('role:invoke-settled')).toBeLessThan(h.fixture.trace.indexOf('sealed:accepted'));
      expect(h.fixture.trace.indexOf('sealed:accepted')).toBeLessThan(h.fixture.trace.indexOf('sealed:commit'));
      expect(h.fixture.trace.indexOf('sealed:commit')).toBeLessThan(h.fixture.trace.indexOf(STORY_PENDING_IPC.prepareSave));
      expect(h.fixture.pointers.size).toBe(0); expect(h.fixture.slots.size).toBe(0); expect(globalThis.fetch).not.toHaveBeenCalled();
      const secondInput = JSON.parse(new TextDecoder().decode(h.fixture.sealed.find(item => item.snapshot.manifest.expectedRevision === 1)!.bytes.get('input')));
      expect(secondInput.userGuidance).toBe('第二章独立引导');
      expect(secondInput.chapterContext.workingCombatants[0]).toMatchObject({ data: { name: '甲', signature: 'server-signed-fixture' }, isNative: true });
      expect(JSON.stringify(secondInput)).not.toContain('其它页面');
      const chapter = h.fixture.records.chapterDocuments(sessionId)[0]!;
      expect(chapter.markdown).toBe(h.fixture.markdown);
      expect(chapter.cardSnapshot).toMatchObject({ aiUsage: h.fixture.telemetry.usage, aiModel: 'actual-fixture-model' });
      const checkpoint = h.fixture.records.documents.get(`${sessionId}:fixture-owner-4`)!.value;
      expect(checkpoint.combatants).toEqual(expect.arrayContaining([expect.objectContaining({ data: expect.objectContaining({ signature: 'server-signed-fixture', extension: { signature: 'nested-keep' } }), isNative: true })]));
    });
  }
});

describe('Hosted completion, roles and single-use save', () => {
  it('uses only original response metadata for live, completed and cold-restored presentation', async () => {
    const h = setup(); h.fixture.failPrepareSave = true;
    h.input.story.seed.mode = 'scenario'; h.input.story.seed.scenario = { title: '原始故事情景' };
    h.input.session.source.mode = 'scenario'; h.input.session.seed.scenario = h.input.story.seed.scenario;
    await h.generate();
    const live = h.onResult.mock.calls.find(([result, , phase]) => phase === 'generating' && result.markdown && !result.presentation?.aiModel)?.[0];
    expect(live).toMatchObject({ presentation: { mode: 'scenario', scenarioName: '原始故事情景', userGuidance: '首章引导', reporterInfo: { name: '合成记者' }, aiUsage: null } });
    expect(live?.presentation).not.toHaveProperty('aiModel');
    const completed = [...h.onResult.mock.calls].reverse().find(([, , phase]) => phase === 'completed')?.[0];
    expect(completed).toMatchObject({ presentation: { aiModel: 'actual-fixture-model',
      aiUsage: { completionTokens: 7, cachedTokens: 0, completionTokensIncludesReasoning: false } } });
    expect(completed?.presentation.aiUsage).not.toHaveProperty('promptTokens');
    h.owner.dispose(); const cold = setup({ fixture: h.fixture }); await cold.owner.openCandidate();
    expect(cold.onResult.mock.calls.at(-1)?.[0].presentation).toEqual(completed?.presentation);
    expect(createCalls(h.fixture)).toHaveLength(1); expect(globalThis.fetch).not.toHaveBeenCalled();
    cold.owner.dispose();
  });
  it.each(['whole-commit', 'pending-originals-plus-commit'] as const)('%s budget refusal preserves completed originals and permits export without another model', async budget => {
    const h = setup({ prepareCommit: async input => {
      if (budget === 'whole-commit') throw new Error('whole commit exceeds 128 MiB');
      const commit = await prepareStoryStorageCommit(input);
      // Descriptor-only boundary injection: no large allocation. The whole commit
      // fits its own 128 MiB but cannot fit alongside the sealed original parts.
      const otherBytes = commit.manifest.parts.filter(part => part.kind !== 'chapter').reduce((sum, part) => sum + part.byteLength, 0);
      return { ...commit, byteLength: STORY_CANDIDATE_COMMIT_BYTES, manifest: { ...commit.manifest,
        parts: commit.manifest.parts.map(part => part.kind === 'chapter' ? { ...part, byteLength: STORY_CANDIDATE_COMMIT_BYTES - otherBytes } : part) } };
    } });
    await h.generate();
    expect(h.owner.getSnapshot()).toMatchObject({ outputDurable: true, role: { status: 'accepted' }, localRetry: 'freeze' });
    expect(h.fixture.part('battle', 'markdown')).toBe(h.fixture.markdown);
    expect(h.fixture.slots.get('battle')!.snapshot.manifest.commitManifest).toBeNull();
    expect(h.fixture.commands(STORY_PENDING_IPC.prepareSave)).toHaveLength(0);
    expect(h.fixture.commands(STORY_PENDING_IPC.save)).toHaveLength(0);
    await h.owner.exportOriginals();
    expect(h.owner.getSnapshot().exportError).toBeNull();
    expect(h.owner.getSnapshot().exportResults).toHaveLength(h.fixture.slots.get('battle')!.snapshot.manifest.parts.length + 1);
    expect(createCalls(h.fixture)).toHaveLength(1); expect(roleCalls(h.fixture)).toHaveLength(1);
  });
  it('freezes chapter and checkpoint times from the original pending identity, not a later completion clock', async () => {
    const h = setup();
    expect(h.input.session.createdAt).toBe(100); // The owner completion clock is 200.
    await h.generate();
    expect(h.onSaved, h.owner.getSnapshot().message ?? '').toHaveBeenCalledTimes(1);
    const frozen = h.fixture.sealed.at(-1)!;
    expect(frozen.snapshot.manifest.createdAt).toBe(100);
    for (const kind of ['chapter', 'checkpoint0', 'checkpoint1'] as const) {
      expect(JSON.parse(new TextDecoder().decode(frozen.bytes.get(kind))).createdAt).toBe(100);
    }
    expect(JSON.parse(new TextDecoder().decode(frozen.bytes.get('session')))).toMatchObject({ createdAt: 100, updatedAt: 100, summaryMeta: { refreshedAt: 100 } });
  });
  it('does not promote Channel completion before the original Native invoke settles', async () => {
    const h = setup(), gate = deferred<void>(); h.fixture.beforeModelSettles = () => gate.promise;
    const run = h.generate(); await vi.waitFor(() => expect(h.fixture.trace).toContain('model:c0-completed'));
    expect(h.onResult.mock.calls.some(([result]) => result.markdown === h.fixture.markdown)).toBe(true);
    expect(h.fixture.sealed).toHaveLength(1); expect(roleCalls(h.fixture)).toHaveLength(0);
    expect(h.fixture.commands(STORY_PENDING_IPC.prepareSave)).toHaveLength(0);
    gate.resolve(); await run; expect(h.onSaved, h.owner.getSnapshot().message ?? '').toHaveBeenCalledTimes(1);
  });
  it('retains prose but refuses completion when Native rejects after the final Channel event', async () => {
    const h = setup(); h.fixture.beforeModelSettles = async () => { throw { code: 'scope-changed', dispatchState: 'unknown' }; };
    await h.generate(); expect(h.onResult.mock.calls.at(-1)?.[0].markdown).toBe(h.fixture.markdown);
    expect(h.fixture.sealed).toHaveLength(1); expect(h.owner.getSnapshot().outputDurable).toBe(false);
    expect(roleCalls(h.fixture)).toHaveLength(0); expect(h.onSaved).not.toHaveBeenCalled();
  });
  it('waits for Native role settlement before accepting the complete JSON carrier', async () => {
    const h = setup(), gate = deferred<void>(); h.fixture.beforeRoleSettles = () => gate.promise;
    const run = h.generate(); await vi.waitFor(() => expect(roleCalls(h.fixture)).toHaveLength(1));
    expect(h.owner.getSnapshot()).toMatchObject({ outputDurable: true, role: { status: 'unresolved' } });
    expect(h.fixture.sealed.map(item => item.snapshot.manifest.roleState)).toEqual(['unresolved', 'unresolved']);
    expect(h.fixture.commands(STORY_PENDING_IPC.save)).toHaveLength(0);
    gate.resolve(); await run; expect(h.onSaved).toHaveBeenCalledTimes(1);
  });
  it('accepts a checked zero-role success and preserves all original role fields', async () => {
    const h = setup(); h.fixture.roleMode = 'zero'; await h.generate();
    expect(h.onSaved, h.owner.getSnapshot().message ?? '').toHaveBeenCalledTimes(1);
    const accepted = h.fixture.sealed.find(item => item.snapshot.manifest.roleState === 'accepted')!;
    expect(JSON.parse(new TextDecoder().decode(accepted.bytes.get('roleResponse'))).updatedCombatants).toEqual([]);
    expect(h.fixture.records.documents.get(`${h.input.session.id}:${h.input.checkpointId}`)!.value.combatants).toEqual(h.input.story.chapterContext.workingCombatants);
    expect(roleCalls(h.fixture)).toHaveLength(1);
  });
  it('skips roles when no role writes were requested and preserves true/null telemetry too', async () => {
    const h = setup({ roles: false }); h.fixture.telemetry.usage.completionTokensIncludesReasoning = true; await h.generate();
    expect(h.onSaved, h.owner.getSnapshot().message ?? '').toHaveBeenCalledTimes(1); expect(roleCalls(h.fixture)).toHaveLength(0);
    expect(h.fixture.records.chapterDocuments(h.input.session.id)[0]!.cardSnapshot).toMatchObject({ aiUsage: {
      promptTokens: null, reasoningTokens: null, totalTokens: null, cachedTokens: 0, completionTokensIncludesReasoning: true,
    } });
  });
  it.each(['network', 'malformed'] as const)('%s role failure remains unresolved; explicit retry never creates a model', async roleMode => {
    const h = setup(); h.fixture.roleMode = roleMode; await h.generate();
    expect(h.owner.getSnapshot()).toMatchObject({ outputDurable: true, role: { status: 'unresolved' }, active: { manifest: { modelCompleted: true, commitManifest: null } } });
    expect(h.fixture.part('battle', 'markdown')).toBe(h.fixture.markdown); expect(h.fixture.commands(STORY_PENDING_IPC.save)).toHaveLength(0);
    h.fixture.roleMode = 'accepted'; await h.owner.retryRoles(); expect(h.onSaved, h.owner.getSnapshot().message ?? '').toHaveBeenCalledTimes(1);
    expect(createCalls(h.fixture)).toHaveLength(1); expect(roleCalls(h.fixture)).toHaveLength(2);
  });
  it('checked HTTP failure freezes an explicit old-role chapter and retains the completed originals', async () => {
    const h = setup(); h.fixture.roleMode = 'http'; await h.generate(); expect(h.onSaved, h.owner.getSnapshot().message ?? '').toHaveBeenCalledTimes(1);
    const frozen = h.fixture.sealed.at(-1)!;
    expect(frozen.snapshot.manifest).toMatchObject({ roleState: 'old-roles', modelCompleted: true });
    expect(frozen.snapshot.manifest.commitManifest).not.toBeNull(); expect(frozen.bytes.has('roleResponse')).toBe(false);
    expect(h.fixture.records.chapterDocuments(h.input.session.id)[0]!.cardSnapshot).toMatchObject({ storyRoleSync: { state: 'old-roles', reason: 'http-failure' } });
  });
  it('completion seal failure allows local reseal then an explicit role decision, never model replay', async () => {
    const h = setup(); h.fixture.failSeal = manifest => manifest.modelCompleted; await h.generate();
    expect(h.owner.getSnapshot()).toMatchObject({ outputDurable: false, localRetry: 'seal' });
    expect(h.fixture.slots.get('battle')!.snapshot.manifest.modelCompleted).toBe(false); expect(roleCalls(h.fixture)).toHaveLength(0);
    h.fixture.failSeal = null; await h.owner.retryLocal();
    expect(h.owner.getSnapshot()).toMatchObject({ outputDurable: true, role: { status: 'unresolved' } });
    expect(createCalls(h.fixture)).toHaveLength(1); expect(roleCalls(h.fixture)).toHaveLength(0);
    await h.owner.retryRoles(); expect(h.onSaved).toHaveBeenCalledTimes(1);
  });
  it('accepted role carrier survives seal failure without repeating reconciliation on local retry', async () => {
    const h = setup(); h.fixture.failSeal = manifest => manifest.roleState === 'accepted'; await h.generate();
    expect(h.owner.getSnapshot()).toMatchObject({ outputDurable: true, localRetry: 'seal', role: { status: 'accepted' } });
    h.fixture.failSeal = null; await h.owner.retryLocal(); expect(h.onSaved, h.owner.getSnapshot().message ?? '').toHaveBeenCalledTimes(1);
    expect(roleCalls(h.fixture)).toHaveLength(1); expect(createCalls(h.fixture)).toHaveLength(1);
  });
  it('old-role seal failure stays unresolved and requires a fresh explicit old-role choice', async () => {
    const h = setup(); h.fixture.roleMode = 'network'; await h.generate();
    h.fixture.failSeal = manifest => manifest.roleState === 'old-roles'; await h.owner.keepOriginalRoles();
    expect(h.owner.getSnapshot()).toMatchObject({ role: { status: 'unresolved' }, active: { manifest: { roleState: 'unresolved', commitManifest: null } } });
    expect(h.fixture.commands(STORY_PENDING_IPC.save)).toHaveLength(0);
    h.fixture.failSeal = null; await h.owner.retryLocal(); expect(h.fixture.commands(STORY_PENDING_IPC.save)).toHaveLength(0);
    await h.owner.keepOriginalRoles(); expect(h.onSaved, h.owner.getSnapshot().message ?? '').toHaveBeenCalledTimes(1);
    expect(h.fixture.records.chapterDocuments(h.input.session.id)[0]!.cardSnapshot).toMatchObject({ storyRoleSync: { state: 'old-roles', reason: 'user-kept-original' } });
    expect(roleCalls(h.fixture)).toHaveLength(1);
  });
  it.each(['prepare', 'save'] as const)('unknown %s and absent receipt permit queries only, never a second attempt', async phase => {
    const h = setup(); h.fixture.records.hideReceipts = true; h.fixture.failPrepareSave = phase === 'prepare'; h.fixture.loseSaveReply = phase === 'save';
    await h.generate(); expect(h.owner.getSnapshot().evidence).toBe('unknown');
    await h.owner.retryLocal(); await h.owner.queryReceipt(); await h.owner.retryRoles(); await h.owner.keepOriginalRoles();
    expect(h.owner.getSnapshot().evidence).toBe('unknown'); expect(h.onSaved).not.toHaveBeenCalled();
    expect(h.fixture.commands(STORY_PENDING_IPC.prepareSave)).toHaveLength(1); expect(h.fixture.commands(STORY_PENDING_IPC.save)).toHaveLength(phase === 'save' ? 1 : 0);
    expect(createCalls(h.fixture)).toHaveLength(1); expect(roleCalls(h.fixture)).toHaveLength(1);
    if (phase === 'save') { h.fixture.records.hideReceipts = false; await h.owner.queryReceipt(); expect(h.onSaved).toHaveBeenCalledTimes(1); expect(h.fixture.commands(STORY_PENDING_IPC.save)).toHaveLength(1); }
  });
});

describe('Hosted cold recovery, actor fencing and exact local exits', () => {
  it('missing pointer recovers from Native claim with original lookup and zero-cursor replay, never creates', async () => {
    const h = setup(); h.fixture.roleMode = 'network'; await h.generate(); h.owner.dispose();
    h.fixture.pointers.clear(); const count = createCalls(h.fixture).length;
    const cold = setup({ fixture: h.fixture }); await cold.owner.openCandidate(); await cold.owner.recover();
    expect(createCalls(h.fixture)).toHaveLength(count);
    expect(h.fixture.controls.at(-1)).toEqual({ operation: 'lookup-request', product: 'battle', requestId: h.input.requestId, actor: h.actor, restoreSession: true });
    expect(h.fixture.streams.at(-1)).toEqual({ operation: 'resume', product: 'battle', requestId: h.input.requestId, actor: h.actor,
      generationId: h.fixture.generations.get(h.input.requestId) });
    expect(cold.owner.getSnapshot()).toMatchObject({ hydrated: true, outputDurable: true, role: { status: 'unresolved' } });
    expect(roleCalls(h.fixture)).toHaveLength(1); expect(cold.owner.recovery.getSnapshot().pointer?.actor).toEqual(h.actor);
  });
  it('pointer write failure retains exact durable input, and cold no-claim candidate never creates', async () => {
    const h = setup(); h.fixture.failPointerWrite = true; await h.generate();
    expect(h.fixture.sealed).toHaveLength(1); expect(h.fixture.streams).toHaveLength(0);
    expect(h.fixture.slots.get('battle')!.snapshot.createClaim).toBeNull(); h.owner.dispose();
    h.fixture.failPointerWrite = false; const cold = setup({ fixture: h.fixture }); await cold.owner.openCandidate();
    await cold.owner.recover(); await cold.owner.retryLocal(); await cold.owner.retryRoles();
    expect(h.fixture.streams).toHaveLength(0); expect(h.fixture.commands(STORY_PENDING_IPC.save)).toHaveLength(0);
    expect(cold.owner.getSnapshot().message).toContain('claim');
    await cold.owner.generate(cold.input, h.fixture.target(), new AbortController().signal).catch(() => undefined);
    expect(h.fixture.streams).toHaveLength(0);
  });
  it('backup-restored completion permits original replay and export but no reseal, role or save', async () => {
    const h = setup(); h.fixture.roleMode = 'network'; await h.generate(); h.owner.dispose();
    h.fixture.slots.get('battle')!.snapshot.restored = true; const seals = h.fixture.sealed.length;
    const cold = setup({ fixture: h.fixture }); await cold.owner.openCandidate();
    await cold.owner.retryRoles(); await cold.owner.keepOriginalRoles(); await cold.owner.retryLocal(); await cold.owner.recover();
    expect(h.fixture.sealed).toHaveLength(seals); expect(roleCalls(h.fixture)).toHaveLength(1);
    expect(h.fixture.commands(STORY_PENDING_IPC.prepareSave)).toHaveLength(0); expect(h.fixture.commands(STORY_PENDING_IPC.save)).toHaveLength(0);
    expect(cold.owner.getSnapshot().active?.restored).toBe(true);
    await cold.owner.exportOriginals(); expect(cold.owner.getSnapshot().exportError).toBeNull(); expect(h.fixture.exports.length).toBeGreaterThan(1);
  });
  it.each(['model', 'role'] as const)('account switch fences late %s callbacks without erasing retained originals', async phase => {
    const h = setup({ actor: { kind: 'account', expectedUserId: 7 } }), gate = deferred<void>();
    if (phase === 'model') h.fixture.beforeModelSettles = () => gate.promise; else h.fixture.beforeRoleSettles = () => gate.promise;
    const run = h.generate(); await vi.waitFor(() => expect(phase === 'model' ? h.fixture.trace.includes('model:c0-completed') : roleCalls(h.fixture).length === 1).toBe(true));
    h.owner.setContext('account-8', { kind: 'account', expectedUserId: 8 }); gate.resolve(); await run;
    expect(h.owner.getSnapshot().actorCurrent).toBe(false); expect(h.onSaved).not.toHaveBeenCalled();
    expect(h.fixture.commands(STORY_PENDING_IPC.prepareSave)).toHaveLength(0); expect(h.fixture.commands(STORY_PENDING_IPC.save)).toHaveLength(0);
    expect(h.fixture.slots.get('battle')!.snapshot.manifest).toMatchObject({ actor: { kind: 'account', expectedUserId: 7 }, roleState: 'unresolved', modelCompleted: phase === 'role' });
    expect(h.fixture.sealed.some(value => value.snapshot.manifest.roleState === 'accepted')).toBe(false);
  });
  it('exports exact sealed bytes and manifest; partial cleanup retains the explicit abandonment identity', async () => {
    const h = setup(); h.fixture.roleMode = 'network'; await h.generate();
    const before = structuredClone(h.fixture.slots.get('battle')!), snapshot = before.snapshot;
    await h.owner.exportOriginals(); expect(h.owner.getSnapshot().exportError).toBeNull();
    expect(h.fixture.exports).toHaveLength(snapshot.manifest.parts.length + 1);
    for (const exported of h.fixture.exports) {
      expect(exported.source.key).toEqual({ product: 'battle', requestId: h.input.requestId, pendingRevision: snapshot.manifest.pendingRevision });
      if (exported.source.scope === 'pending-part') expect(exported.bytes).toEqual(before.bytes.get(exported.source.kind));
      else expect(JSON.parse(new TextDecoder().decode(exported.bytes))).toEqual(snapshot.manifest);
    }
    expect(h.fixture.commands(STORY_PENDING_IPC.abandon)).toHaveLength(0); expect(h.owner.hasCandidate()).toBe(true);
    h.fixture.partialAbandon = true; await h.owner.abandonConfirmed();
    expect(h.owner.getSnapshot().abandonment).toMatchObject({ state: 'cleanup-pending', candidate: 'retained' });
    expect(h.fixture.pointers.size).toBe(1); expect(h.owner.hasCandidate()).toBe(true);
    await h.owner.retryLocal(); await h.owner.retryRoles(); expect(h.fixture.commands(STORY_PENDING_IPC.save)).toHaveLength(0);
    h.fixture.partialAbandon = false; await h.owner.abandonConfirmed();
    expect(h.fixture.commands(STORY_PENDING_IPC.abandon).map(([, args]) => args)).toEqual(Array(2).fill({ request: {
      key: { product: 'battle', requestId: h.input.requestId, pendingRevision: snapshot.manifest.pendingRevision }, inputDigest: snapshot.manifest.inputDigest, actor: h.actor,
    } }));
    expect(h.owner.getSnapshot().abandonment?.state).toBe('abandoned'); expect(h.owner.hasCandidate()).toBe(false);
    expect(h.fixture.controls).toEqual([]); expect(h.fixture.pointers.size).toBe(0);
  });
  it('failed export publishes no success, and abandonment preserves a concurrent pointer replacement byte-for-byte', async () => {
    const h = setup(); h.fixture.roleMode = 'network'; await h.generate();
    h.fixture.failExport = true; await h.owner.exportOriginals();
    expect(h.owner.getSnapshot().exportError).toContain('disk full'); expect(h.owner.getSnapshot().exportResults).toEqual([]); expect(h.fixture.exports).toEqual([]);
    const foreign = '  { "version": 3, "foreign": "new single-shot identity" }\n';
    h.fixture.pointers.set(ARENA_HOSTED_RECOVERY_KEYS.battle, foreign); await h.owner.abandonConfirmed();
    expect(h.fixture.pointers.get(ARENA_HOSTED_RECOVERY_KEYS.battle)).toBe(foreign);
    expect(h.owner.getSnapshot().pointerError).not.toBeNull(); expect(h.fixture.controls).toEqual([]);
  });
});

describe('Hosted parent directory and reload integration', () => {
  const parent = (fixture: HostedStoryFixture) => {
    let id = 0;
    const owner = new DesktopArenaStorySession({ port: createIpcStoryNativePort(fixture.invoke), id: () => `fixture-parent-${++id}`, now: () => 300,
      exportMarkdown: async () => ({ absolutePath: '/fixture/export.md', byteLength: 1 }),
      hosted: { product: 'battle', port: fixture.port, sink: fixture.sink, storage: fixture.storage, invoke: fixture.invoke, now: () => 300,
        createChannel: () => ({ onmessage: () => undefined }), wait: async () => undefined, maxReconnectAttempts: 0 } });
    owner.setExecutionScope('account-7', { kind: 'account', expectedUserId: 7 }); return owner;
  };
  const prepare = (fixture: HostedStoryFixture): PrepareStoryExecution => async run => run(fixture.target({ kind: 'account', expectedUserId: 7 }));
  it.each(['missing-stream-end', 'malformed-after-done'] as const)('done plus settled Native with %s cannot seal, reconcile or save a Hosted parent chapter', async failure => {
    const fixture = new HostedStoryFixture(), owner = parent(fixture), gate = deferred<void>(), draft = storyDraft();
    draft.settings.writeArenaHistory = true; fixture.omitStreamEnd = failure === 'missing-stream-end';
    fixture.malformedAfterDone = failure === 'malformed-after-done'; fixture.beforeModelSettles = () => gate.promise;
    const run = owner.start({ draft, product: 'battle' }, prepare(fixture));
    await vi.waitFor(() => expect(fixture.trace).toContain('model:c0-completed'));
    expect(owner.getSnapshot().result?.markdown).toBe(fixture.markdown);
    expect(fixture.sealed).toHaveLength(1); expect(roleCalls(fixture)).toHaveLength(0);
    gate.resolve(); await run;
    expect(owner.getSnapshot()).toMatchObject({ resultSaved: false, result: { markdown: fixture.markdown }, hosted: { outputDurable: false } });
    expect(fixture.sealed.every(value => !value.snapshot.manifest.modelCompleted)).toBe(true);
    expect(roleCalls(fixture)).toHaveLength(0); expect(fixture.commands(STORY_PENDING_IPC.prepareSave)).toHaveLength(0);
    expect(fixture.commands(STORY_PENDING_IPC.save)).toHaveLength(0); expect(fixture.records.documents.size).toBe(0);
  });
  it('cold first-chapter assembly restores exact local plan metadata instead of guessing from the network chapter limit', async () => {
    const fixture = new HostedStoryFixture(), first = parent(fixture), draft = storyDraft();
    draft.settings.writeArenaHistory = true; fixture.roleMode = 'network';
    const chapterPlan = { totalChapters: 3, source: 'user' as const, locked: true };
    await first.start({ draft, product: 'battle', chapterPlan }, prepare(fixture));
    expect(first.getSnapshot().hosted?.active?.manifest.localAssembly).toEqual({ version: 1, chapterPlan });
    expect(JSON.parse(fixture.part('battle', 'input')).chapterPlan).toEqual({ totalChapters: 3 });
    first.dispose(); const cold = parent(fixture); await cold.initialize(); await cold.hosted!.openCandidate();
    fixture.roleMode = 'accepted'; await cold.hosted!.retryRoles();
    expect(cold.getSnapshot(), cold.getSnapshot().hosted?.message ?? '').toMatchObject({ resultSaved: true, active: { chapterCount: 1, chapterPlan } });
    expect(createCalls(fixture)).toHaveLength(1); expect(roleCalls(fixture)).toHaveLength(2);
  });
  it('manual chapter selection while a Hosted save completes wins over automatic reopening', async () => {
    const fixture = new HostedStoryFixture(), owner = parent(fixture), draft = storyDraft();
    await owner.start({ draft, product: 'battle' }, prepare(fixture)); const first = owner.getSnapshot().active!.lastChapterId;
    const gate = deferred<void>(); fixture.records.beforeEnd = () => gate.promise;
    const run = owner.continue('第二章', prepare(fixture)); await vi.waitFor(() => expect(fixture.records.end).toHaveBeenCalledTimes(2));
    await owner.selectChapter(first); gate.resolve(); await run;
    expect(owner.getSnapshot()).toMatchObject({ active: { chapterCount: 2 }, selected: { status: 'loaded', chapterId: first }, savedUnread: { chapterCount: 2 }, resultSaved: true });
    expect(createCalls(fixture)).toHaveLength(2); expect(fixture.commands(STORY_PENDING_IPC.save)).toHaveLength(2);
  });
  it('a restored frozen candidate can query its original receipt but cannot prepare another save', async () => {
    const h = setup(); h.fixture.failPrepareSave = true; await h.generate(); h.owner.dispose();
    h.fixture.slots.get('battle')!.snapshot.restored = true;
    const beforePrepare = h.fixture.commands(STORY_PENDING_IPC.prepareSave).length, beforeSeals = h.fixture.sealed.length;
    const cold = setup({ fixture: h.fixture }); await cold.owner.openCandidate();
    await cold.owner.retryLocal(); await cold.owner.retryRoles(); await cold.owner.queryReceipt();
    expect(cold.owner.getSnapshot().evidence).toBe('unknown'); expect(h.fixture.commands(STORY_PENDING_IPC.prepareSave)).toHaveLength(beforePrepare);
    expect(h.fixture.commands(STORY_PENDING_IPC.save)).toHaveLength(0); expect(h.fixture.sealed).toHaveLength(beforeSeals);
    expect(h.fixture.commands('query_arena_story_receipt').length).toBeGreaterThan(0); expect(createCalls(h.fixture)).toHaveLength(1); expect(roleCalls(h.fixture)).toHaveLength(1);
  });
});

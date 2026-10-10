import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopArenaHostedActor } from '@mahoshojo/contracts/desktop-arena-hosted';
import { DesktopHostedStorySession } from '../src/features/arena/hosted-story-session';
import { DesktopArenaStorySession } from '../src/features/arena/story-session';
import { createIpcStoryNativePort } from '../src/platform/arena-story-native';
import { STORY_PENDING_IPC } from '../src/platform/arena-story-pending-native';
import { deferred, installStoryCrypto } from './helpers/story-fixture';
import { HostedStoryFixture, hostedStoryInput } from './helpers/hosted-story-fixture';

installStoryCrypto();
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('read-fence fixture must not access a real network'); });
});
afterEach(() => vi.restoreAllMocks());

type Dependencies = ConstructorParameters<typeof DesktopHostedStorySession>[0];
const setup = (fixture = new HostedStoryFixture(), overrides: Partial<Dependencies> = {}) => {
  const input = hostedStoryInput(), actor: DesktopArenaHostedActor = { kind: 'account', expectedUserId: 7 };
  const onSaved = vi.fn(async () => undefined), onResult = vi.fn(), onState = vi.fn();
  const owner = new DesktopHostedStorySession({
    product: 'battle', port: fixture.port, sink: fixture.sink, storage: fixture.storage, invoke: fixture.invoke,
    now: () => 200, createChannel: () => ({ onmessage: () => undefined }), wait: async () => undefined, maxReconnectAttempts: 0,
    onSaved, onResult, onState, captureSelection: () => input.selection, loadBaseline: async () => input.session, ...overrides,
  });
  owner.setContext('account-7', actor);
  return { fixture, input, actor, owner, onSaved, onResult, onState,
    generate: (signal = new AbortController().signal) => owner.generate(input, fixture.target(actor), signal) };
};
const createCalls = (fixture: HostedStoryFixture) => fixture.streams.filter(request => request.operation === 'create-story-stream');
const roleCalls = (fixture: HostedStoryFixture) => fixture.streams.filter(request => request.operation === 'reconcile-story');
const writes = (fixture: HostedStoryFixture) => [STORY_PENDING_IPC.begin, STORY_PENDING_IPC.append, STORY_PENDING_IPC.seal,
  STORY_PENDING_IPC.prepareSave, STORY_PENDING_IPC.save].map(command => fixture.commands(command).length);
const retainedCandidate = async (accepted = false) => {
  const h = setup();
  if (accepted) h.fixture.failSeal = manifest => manifest.commitManifest !== null;
  else h.fixture.roleMode = 'network';
  await h.generate(); h.owner.dispose(); h.fixture.failSeal = null;
  expect(h.fixture.slots.get('battle')!.snapshot.manifest).toMatchObject({ modelCompleted: true, roleState: accepted ? 'accepted' : 'unresolved' });
  return h.fixture;
};

describe('Hosted owner delayed reads are bound to their original epoch', () => {
  it.each(['account', 'detach'] as const)('does not hydrate after %s changes during an in-flight Native input frame', async change => {
    const fixture = await retainedCandidate(), entered = deferred<void>(), release = deferred<void>();
    const read = fixture.port.read.bind(fixture.port);
    vi.spyOn(fixture.port, 'read').mockImplementationOnce(async (...args) => {
      const bytes = await read(...args); entered.resolve(); await release.promise; return bytes;
    });
    const h = setup(fixture), run = h.owner.openCandidate(); await entered.promise;
    if (change === 'account') h.owner.setContext('account-8', { kind: 'account', expectedUserId: 8 }); else h.owner.detach();
    const before = writes(fixture); release.resolve(); await run;
    expect(h.onResult).not.toHaveBeenCalled();
    expect(h.owner.getSnapshot()).toMatchObject({ hydrated: false, role: null, busy: null });
    await h.owner.retryRoles(); await h.owner.retryLocal();
    expect(writes(fixture)).toEqual(before); expect(h.onSaved).not.toHaveBeenCalled();
  });

  it.each(['account', 'detach'] as const)('does not publish accepted originals over a newer window after %s changes during loadBaseline', async change => {
    const fixture = await retainedCandidate(true), entered = deferred<void>(), release = deferred<void>();
    const input = hostedStoryInput(); let visibleMarkdown = '';
    const onResult = vi.fn<Dependencies['onResult']>(result => { visibleMarkdown = result.markdown ?? ''; });
    const h = setup(fixture, { onResult, loadBaseline: async () => { entered.resolve(); await release.promise; return input.session; } });
    const run = h.owner.openCandidate(); await entered.promise;
    if (change === 'account') h.owner.setContext('account-8', { kind: 'account', expectedUserId: 8 }); else h.owner.detach();
    visibleMarkdown = '较新窗口正文，不能被已失效的旧候选读取覆盖';
    const before = writes(fixture); release.resolve(); await run;
    expect(onResult).not.toHaveBeenCalled();
    expect(visibleMarkdown).toBe('较新窗口正文，不能被已失效的旧候选读取覆盖');
    expect(h.owner.getSnapshot()).toMatchObject({ hydrated: false, role: null, outputDurable: false, busy: null });
    await h.owner.retryRoles(); await h.owner.retryLocal();
    expect(writes(fixture)).toEqual(before); expect(h.onSaved).not.toHaveBeenCalled();
  });

  it.each(['detached', 'same-epoch'] as const)('does not replace a freshly discovered accepted revision with a stale describe reply (%s)', async context => {
    const fixture = await retainedCandidate(), entered = deferred<void>(), release = deferred<void>();
    const describePending = fixture.port.describe.bind(fixture.port);
    vi.spyOn(fixture.port, 'describe').mockImplementationOnce(async product => {
      const snapshot = await describePending(product); entered.resolve(); await release.promise; return snapshot;
    });
    const h = setup(fixture), run = h.owner.openCandidate(); await entered.promise;
    if (context === 'detached') h.owner.detach();
    // A second legitimate owner advances the same durable candidate while the first
    // Native reply is delayed; no private owner state or fake snapshot is injected.
    const newer = setup(fixture); await newer.owner.openCandidate();
    fixture.roleMode = 'accepted'; fixture.failSeal = manifest => manifest.commitManifest !== null;
    await newer.owner.retryRoles(); fixture.failSeal = null;
    const accepted = structuredClone(fixture.slots.get('battle')!.snapshot);
    expect(accepted.manifest.roleState).toBe('accepted');
    await h.owner.discover(); expect(h.owner.getSnapshot().slots.battle).toEqual(accepted);
    release.resolve(); await run;
    expect(h.owner.getSnapshot().slots.battle).toEqual(accepted);
    expect(h.owner.getSnapshot().active).toBeNull(); expect(h.onResult).not.toHaveBeenCalled();
    newer.owner.dispose();
  });

  it('does not hydrate a stale baseline after a same-epoch discovery finds a newer accepted revision', async () => {
    const fixture = await retainedCandidate(), entered = deferred<void>(), release = deferred<void>();
    const input = hostedStoryInput(); let visibleMarkdown = '';
    const onResult = vi.fn<Dependencies['onResult']>(result => { visibleMarkdown = result.markdown ?? ''; });
    const h = setup(fixture, { onResult, loadBaseline: async () => { entered.resolve(); await release.promise; return input.session; } });
    const run = h.owner.openCandidate(); await entered.promise;
    const newer = setup(fixture); await newer.owner.openCandidate();
    fixture.roleMode = 'accepted'; fixture.failSeal = manifest => manifest.commitManifest !== null;
    await newer.owner.retryRoles(); fixture.failSeal = null;
    const accepted = structuredClone(fixture.slots.get('battle')!.snapshot);
    expect(accepted.manifest).toMatchObject({ roleState: 'accepted', pendingRevision: 3 });
    await h.owner.discover(); expect(h.owner.getSnapshot().slots.battle).toEqual(accepted);
    visibleMarkdown = '同一账号的新窗口正文';
    const before = writes(fixture); release.resolve(); await run;
    expect(onResult).not.toHaveBeenCalled(); expect(visibleMarkdown).toBe('同一账号的新窗口正文');
    expect(h.owner.getSnapshot()).toMatchObject({ hydrated: false, role: null, outputDurable: false, busy: null });
    expect(h.owner.getSnapshot().slots.battle).toEqual(accepted);
    await h.owner.retryRoles(); await h.owner.retryLocal();
    expect(writes(fixture)).toEqual(before); expect(h.onSaved).not.toHaveBeenCalled();
    newer.owner.dispose();
  });

  it('invalidates a delayed anonymous candidate read when the actor changes under the same scope string', async () => {
    const initial = setup(), anonymous = { kind: 'anonymous' } as const;
    initial.owner.setContext('unchanged-scope', anonymous); initial.fixture.roleMode = 'network';
    await initial.owner.generate(initial.input, initial.fixture.target(anonymous), new AbortController().signal); initial.owner.dispose();
    const entered = deferred<void>(), release = deferred<void>();
    const h = setup(initial.fixture, { loadBaseline: async () => { entered.resolve(); await release.promise; return initial.input.session; } });
    h.owner.setContext('unchanged-scope', anonymous);
    const run = h.owner.openCandidate(); await entered.promise;
    h.owner.setContext('unchanged-scope', { kind: 'account', expectedUserId: 8 });
    const before = writes(h.fixture); release.resolve(); await run;
    expect(h.onResult).not.toHaveBeenCalled();
    expect(h.owner.getSnapshot()).toMatchObject({ actorCurrent: false, hydrated: false, role: null, outputDurable: false });
    await h.owner.retryRoles(); await h.owner.retryLocal();
    expect(writes(h.fixture)).toEqual(before); expect(h.onSaved).not.toHaveBeenCalled();
  });
});

describe('Hosted owner initial input upload acknowledgement recovery', () => {
  it('recovers an already sealed input after lost seal ACK using only its exact active snapshot', async () => {
    const h = setup(), seal = h.fixture.port.seal.bind(h.fixture.port), describePending = h.fixture.port.describe.bind(h.fixture.port);
    let failReadback = false;
    vi.spyOn(h.fixture.port, 'seal').mockImplementationOnce(async token => {
      await seal(token); failReadback = true; throw new Error('lost initial input seal acknowledgement');
    });
    vi.spyOn(h.fixture.port, 'describe').mockImplementation(async product => {
      if (product === 'battle' && failReadback) { failReadback = false; throw new Error('initial ACK readback unavailable'); }
      return describePending(product);
    });
    await h.generate();
    expect(h.owner.getSnapshot()).toMatchObject({ active: null, localRetry: 'seal' });
    expect(h.fixture.slots.get('battle')!.snapshot.manifest).toMatchObject({ pendingRevision: 1, modelCompleted: false });
    const before = writes(h.fixture), queries = h.fixture.commands(STORY_PENDING_IPC.queryUpload).length;
    await h.owner.retryLocal();
    expect(h.owner.getSnapshot()).toMatchObject({ active: { manifest: { pendingRevision: 1, modelCompleted: false }, createClaim: null }, localRetry: null });
    expect(writes(h.fixture)).toEqual(before); expect(h.fixture.commands(STORY_PENDING_IPC.queryUpload)).toHaveLength(queries);
    expect(h.fixture.streams).toHaveLength(0); expect(h.fixture.pointers.size).toBe(0); expect(h.onSaved).not.toHaveBeenCalled();
  });

  it('resumes a known unsealed input token without repeating begin or durable input bytes', async () => {
    const h = setup(); h.fixture.failSeal = () => true; await h.generate();
    expect(h.owner.getSnapshot()).toMatchObject({ active: null, localRetry: 'seal' }); expect(h.fixture.slots.size).toBe(0);
    const before = writes(h.fixture), queries = h.fixture.commands(STORY_PENDING_IPC.queryUpload).length;
    const knownToken = (h.fixture.commands(STORY_PENDING_IPC.seal)[0]![1] as { token: string }).token;
    const uploaded = new TextDecoder().decode(h.fixture.commands(STORY_PENDING_IPC.append)[0]![1] as Uint8Array);
    h.input.story.userGuidance = '读取后页面中的新引导不得混入原输入导出';
    expect(await h.owner.readWindowInputOriginal()).toBe(uploaded);
    expect(uploaded).not.toContain(knownToken); expect(uploaded).not.toContain('读取后页面中的新引导');
    expect(JSON.stringify(h.onState.mock.calls)).not.toContain(knownToken);
    expect(JSON.stringify(h.onResult.mock.calls)).not.toContain(knownToken);
    h.fixture.failSeal = null; await h.owner.retryLocal();
    expect(writes(h.fixture)).toEqual([before[0], before[1], before[2]! + 1, 0, 0]);
    expect(h.fixture.commands(STORY_PENDING_IPC.queryUpload)).toHaveLength(queries + 1);
    expect(h.fixture.commands(STORY_PENDING_IPC.queryUpload).at(-1)?.[1]).toEqual({ token: knownToken });
    expect(h.fixture.commands(STORY_PENDING_IPC.seal).at(-1)?.[1]).toEqual({ token: knownToken });
    expect(h.owner.getSnapshot()).toMatchObject({ active: { manifest: { pendingRevision: 1 }, createClaim: null }, localRetry: null });
    expect(h.fixture.streams).toHaveLength(0); expect(h.fixture.pointers.size).toBe(0); expect(h.onSaved).not.toHaveBeenCalled();
  });

  it.each(['upload-query', 'active-query', 'missing-upload'] as const)('%s failure on explicit input retry cannot begin, append, seal or create', async failure => {
    const h = setup(); h.fixture.failSeal = () => true; await h.generate(); h.fixture.failSeal = null;
    const before = writes(h.fixture);
    if (failure === 'active-query') vi.spyOn(h.fixture.port, 'describe').mockRejectedValue(new Error('active query unavailable'));
    else if (failure === 'missing-upload') vi.spyOn(h.fixture.port, 'queryUpload').mockResolvedValue(null);
    else vi.spyOn(h.fixture.port, 'queryUpload').mockRejectedValue(new Error('upload query unavailable'));
    await h.owner.retryLocal(); await h.owner.retryLocal();
    expect(writes(h.fixture)).toEqual(before); expect(h.fixture.slots.size).toBe(0);
    expect(h.owner.getSnapshot()).toMatchObject({ active: null, localRetry: 'seal' });
    expect(h.fixture.streams).toHaveLength(0); expect(h.fixture.pointers.size).toBe(0); expect(h.onSaved).not.toHaveBeenCalled();
  });

  it('a same-scope actor switch blocks an active-less known input upload retry while preserving token-free window export', async () => {
    const h = setup(); h.fixture.failSeal = () => true; await h.generate(); h.fixture.failSeal = null;
    const token = (h.fixture.commands(STORY_PENDING_IPC.seal)[0]![1] as { token: string }).token;
    const inputOriginal = await h.owner.readWindowInputOriginal();
    expect(h.owner.getSnapshot()).toMatchObject({ active: null, localRetry: 'seal' }); expect(h.owner.canRetryLocal()).toBe(true);
    h.owner.setContext('account-7', { kind: 'account', expectedUserId: 8 });
    const before = writes(h.fixture), queries = h.fixture.commands(STORY_PENDING_IPC.queryUpload).length;
    expect(h.owner.canRetryLocal()).toBe(false); await h.owner.retryLocal(); await h.owner.retryLocal();
    expect(writes(h.fixture)).toEqual(before); expect(h.fixture.commands(STORY_PENDING_IPC.queryUpload)).toHaveLength(queries);
    expect(await h.owner.readWindowInputOriginal()).toBe(inputOriginal);
    expect(inputOriginal).not.toContain(token); expect(JSON.stringify(h.onState.mock.calls)).not.toContain(token);
    expect(h.fixture.slots.size).toBe(0); expect(h.fixture.streams).toHaveLength(0); expect(h.onSaved).not.toHaveBeenCalled();
    h.owner.setContext('account-7', h.actor); expect(h.owner.canRetryLocal()).toBe(true); await h.owner.retryLocal();
    expect(h.owner.getSnapshot().active?.manifest.actor).toEqual(h.actor);
    expect(writes(h.fixture)).toEqual([before[0], before[1], before[2]! + 1, 0, 0]);
    expect(h.fixture.streams).toHaveLength(0);
  });

  it('never guesses a missing input token after both initial begin acknowledgements are lost', async () => {
    const h = setup(), begin = h.fixture.port.begin.bind(h.fixture.port);
    vi.spyOn(h.fixture.port, 'begin').mockImplementation(async manifest => { await begin(manifest); throw new Error('lost begin ACK'); });
    await h.generate(); expect(h.fixture.commands(STORY_PENDING_IPC.begin)).toHaveLength(2);
    const before = writes(h.fixture), queries = h.fixture.commands(STORY_PENDING_IPC.queryUpload).length;
    await h.owner.retryLocal(); await h.owner.retryLocal();
    expect(writes(h.fixture)).toEqual(before); expect(h.fixture.commands(STORY_PENDING_IPC.queryUpload)).toHaveLength(queries);
    expect(h.owner.getSnapshot()).toMatchObject({ active: null, localRetry: 'seal' });
    expect(h.fixture.streams).toHaveLength(0); expect(h.fixture.pointers.size).toBe(0); expect(h.onSaved).not.toHaveBeenCalled();
  });

  it('an external abort while role response settlement is delayed cannot seal accepted roles or save', async () => {
    const h = setup(), signal = new AbortController(), release = deferred<void>();
    h.fixture.beforeRoleSettles = () => release.promise;
    const run = h.generate(signal.signal); await vi.waitFor(() => expect(roleCalls(h.fixture)).toHaveLength(1));
    signal.abort(); release.resolve(); await run;
    expect(h.fixture.slots.get('battle')!.snapshot.manifest).toMatchObject({ modelCompleted: true, roleState: 'unresolved', commitManifest: null });
    expect(h.fixture.sealed.some(value => value.snapshot.manifest.roleState === 'accepted')).toBe(false);
    expect(h.fixture.commands(STORY_PENDING_IPC.prepareSave)).toHaveLength(0); expect(h.fixture.commands(STORY_PENDING_IPC.save)).toHaveLength(0);
    expect(createCalls(h.fixture)).toHaveLength(1); expect(h.onSaved).not.toHaveBeenCalled();
  });
});

describe('Hosted parent cold assembly distinguishes missing metadata from explicit no-plan', () => {
  const parent = (fixture: HostedStoryFixture) => {
    const owner = new DesktopArenaStorySession({ port: createIpcStoryNativePort(fixture.invoke), now: () => 300,
      exportMarkdown: async () => ({ absolutePath: '/fixture/export.md', byteLength: 1 }),
      hosted: { product: 'battle', port: fixture.port, sink: fixture.sink, storage: fixture.storage, invoke: fixture.invoke,
        now: () => 300, createChannel: () => ({ onmessage: () => undefined }), wait: async () => undefined, maxReconnectAttempts: 0 } });
    owner.setExecutionScope('account-7', { kind: 'account', expectedUserId: 7 }); return owner;
  };

  it.each([false, true])('missing localAssembly keeps an old no-plan candidate readable but forbids roles and assembly (accepted=%s)', async accepted => {
    const fixture = await retainedCandidate(accepted), sealed = fixture.slots.get('battle')!;
    // Emulate the persisted legacy manifest, without rewriting its exact input or
    // completed originals. Absence is not an affirmative chapterPlan:null decision.
    delete sealed.snapshot.manifest.localAssembly;
    expect(JSON.parse(fixture.part('battle', 'input'))).not.toHaveProperty('chapterPlan');
    const originals = structuredClone(sealed), owner = parent(fixture);
    await owner.initialize(); await owner.hosted!.openCandidate();
    const readState = owner.getSnapshot(), canResolve = owner.hosted!.canResolveRoles(), canKeep = owner.hosted!.canKeepOriginalRoles();
    const before = writes(fixture), beforeRoles = roleCalls(fixture).length;
    fixture.roleMode = 'accepted';
    await owner.hosted!.retryRoles(); await owner.hosted!.keepOriginalRoles(); await owner.hosted!.retryLocal();
    expect(writes(fixture)).toEqual(before); expect(roleCalls(fixture)).toHaveLength(beforeRoles);
    expect(readState).toMatchObject({ resultSaved: false, result: { markdown: fixture.markdown }, hosted: {
      hydrated: true, outputDurable: true, localRetry: null,
      role: { status: accepted ? 'accepted' : 'unresolved' },
    } });
    expect(readState.hosted!.message).toContain('旧候选缺少原本地组装依据');
    expect(canResolve).toBe(false); expect(canKeep).toBe(false);
    expect(fixture.slots.get('battle')).toEqual(originals); expect(fixture.records.documents.size).toBe(0);
    await owner.hosted!.exportOriginals();
    expect(owner.getSnapshot().hosted!.exportError).toBeNull();
    expect(fixture.exports).toHaveLength(originals.snapshot.manifest.parts.length + 1);
    expect(createCalls(fixture)).toHaveLength(1); expect(owner.getSnapshot().resultSaved).toBe(false);
    owner.dispose();
  });

  it('explicit localAssembly.chapterPlan:null restores and saves a no-plan candidate through the real parent baseline loader', async () => {
    const fixture = await retainedCandidate();
    expect(fixture.slots.get('battle')!.snapshot.manifest.localAssembly).toEqual({ version: 1, chapterPlan: null });
    expect(JSON.parse(fixture.part('battle', 'input'))).not.toHaveProperty('chapterPlan');
    const owner = parent(fixture); await owner.initialize(); await owner.hosted!.openCandidate();
    expect(owner.hosted!.canResolveRoles()).toBe(true);
    fixture.roleMode = 'accepted'; await owner.hosted!.retryRoles();
    expect(owner.getSnapshot(), owner.getSnapshot().hosted?.message ?? '').toMatchObject({ resultSaved: true, active: { chapterCount: 1, revision: 1 } });
    expect(owner.getSnapshot().active).not.toHaveProperty('chapterPlan');
    expect(createCalls(fixture)).toHaveLength(1); expect(roleCalls(fixture)).toHaveLength(2);
    expect(fixture.commands(STORY_PENDING_IPC.prepareSave)).toHaveLength(1); expect(fixture.commands(STORY_PENDING_IPC.save)).toHaveLength(1);
    expect(fixture.slots.size).toBe(0); owner.dispose();
  });
});

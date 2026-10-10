import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopArenaHostedActor } from '@mahoshojo/contracts/desktop-arena-hosted';
import { DesktopHostedStorySession } from '../src/features/arena/hosted-story-session';
import { STORY_IPC } from '../src/platform/arena-story-native';
import { STORY_PENDING_IPC } from '../src/platform/arena-story-pending-native';
import { HostedStoryFixture, hostedStoryInput } from './helpers/hosted-story-fixture';
import { deferred, installStoryCrypto } from './helpers/story-fixture';

installStoryCrypto();
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('save-fence fixture must not access a real network'); });
});
afterEach(() => vi.restoreAllMocks());

type Dependencies = ConstructorParameters<typeof DesktopHostedStorySession>[0];
const setup = () => {
  const fixture = new HostedStoryFixture(), input = hostedStoryInput();
  const actor: DesktopArenaHostedActor = { kind: 'account', expectedUserId: 7 };
  const onSaved = vi.fn<Dependencies['onSaved']>(async () => undefined);
  const owner = new DesktopHostedStorySession({
    product: 'battle', port: fixture.port, sink: fixture.sink, storage: fixture.storage, invoke: fixture.invoke,
    now: () => 200, createChannel: () => ({ onmessage: () => undefined }), wait: async () => undefined, maxReconnectAttempts: 0,
    onState: () => undefined, onResult: () => undefined, onSaved,
    captureSelection: () => input.selection, loadBaseline: async () => input.session,
  });
  owner.setContext('account-7', actor);
  return { fixture, input, actor, owner, onSaved,
    generate: () => owner.generate(input, fixture.target(actor), new AbortController().signal) };
};
type Harness = ReturnType<typeof setup>;
type SavePhase = 'receipt' | 'input-read' | 'prepare-ack' | 'prepared-describe';
type Invalidation = 'account' | 'detach';
const phases: readonly SavePhase[] = ['receipt', 'input-read', 'prepare-ack', 'prepared-describe'];
const invalidate = (owner: DesktopHostedStorySession, change: Invalidation) => {
  if (change === 'account') owner.setContext('account-8', { kind: 'account', expectedUserId: 8 });
  else owner.detach();
};
const createCalls = (fixture: HostedStoryFixture) => fixture.streams.filter(request => request.operation === 'create-story-stream');
const roleCalls = (fixture: HostedStoryFixture) => fixture.streams.filter(request => request.operation === 'reconcile-story');
const expectOriginalReceiptQueries = ({ fixture, input }: Harness) => {
  const calls = fixture.commands(STORY_IPC.receipt);
  expect(calls.length).toBeGreaterThan(0);
  for (const [, request] of calls) expect(request).toEqual({ sessionId: input.session.id, operationId: input.operationId });
};

/** Delay real binder replies rather than manufacturing an owner/Native state.
 * In particular, input-read only stops the SAVE preflight: the commit must already
 * be sealed, so earlier reads used by completed/accepted/commit uploads run normally. */
const delaySavePhase = (fixture: HostedStoryFixture, phase: SavePhase) => {
  const entered = deferred<void>(), release = deferred<void>();
  const wait = async () => { entered.resolve(); await release.promise; };
  if (phase === 'receipt') {
    const receipt = fixture.port.receipt.bind(fixture.port);
    vi.spyOn(fixture.port, 'receipt').mockImplementationOnce(async (...args) => {
      const result = await receipt(...args); await wait(); return result;
    });
  } else if (phase === 'input-read') {
    const read = fixture.port.read.bind(fixture.port); let delayed = false;
    vi.spyOn(fixture.port, 'read').mockImplementation(async (...args) => {
      const result = await read(...args);
      if (!delayed && args[1] === 'input' && fixture.slots.get('battle')?.snapshot.manifest.commitManifest) {
        delayed = true; await wait();
      }
      return result;
    });
  } else if (phase === 'prepare-ack') {
    const prepare = fixture.port.prepareSave.bind(fixture.port);
    vi.spyOn(fixture.port, 'prepareSave').mockImplementationOnce(async (...args) => {
      const result = await prepare(...args); await wait(); return result;
    });
  } else {
    const describePending = fixture.port.describe.bind(fixture.port); let delayed = false;
    vi.spyOn(fixture.port, 'describe').mockImplementation(async product => {
      const result = await describePending(product);
      if (!delayed && product === 'battle' && fixture.slots.get(product)?.snapshot.saveAttemptId) {
        delayed = true; await wait();
      }
      return result;
    });
  }
  return { entered: entered.promise, release: () => release.resolve() };
};

describe('Hosted owner save authority stays with its original epoch across every preflight await', () => {
  for (const phase of phases) it.each(['account', 'detach'] as const)(`${phase}: %s invalidation cannot dispatch a later save`, async change => {
    const h = setup(), gate = delaySavePhase(h.fixture, phase);
    const prepared = phase === 'prepare-ack' || phase === 'prepared-describe';
    const run = h.generate(); await gate.entered;
    try {
      const retained = structuredClone(h.fixture.slots.get('battle')!);
      expect(retained.snapshot.manifest.commitManifest).not.toBeNull();
      expect(retained.snapshot.createClaim).not.toBeNull();
      expect(h.fixture.commands(STORY_PENDING_IPC.prepareSave)).toHaveLength(prepared ? 1 : 0);
      expect(h.fixture.commands(STORY_PENDING_IPC.save)).toHaveLength(0);
      if (prepared) {
        expect(retained.snapshot.saveAttemptId).not.toBeNull();
        expect(h.fixture.attempts).toEqual(new Set([retained.snapshot.saveAttemptId]));
      } else {
        expect(retained.snapshot.saveAttemptId).toBeNull(); expect(h.fixture.attempts.size).toBe(0);
      }

      invalidate(h.owner, change); gate.release(); await run;
      expect(h.fixture.commands(STORY_PENDING_IPC.prepareSave)).toHaveLength(prepared ? 1 : 0);
      expect(h.fixture.commands(STORY_PENDING_IPC.save)).toHaveLength(0);
      expect(h.fixture.slots.get('battle')).toEqual(retained);
      expect(h.fixture.records.chapterDocuments(h.input.session.id)).toHaveLength(0);
      expect(h.onSaved).not.toHaveBeenCalled();
      expect(h.owner.getSnapshot()).toMatchObject({
        active: retained.snapshot, evidence: prepared ? 'unknown' : 'not-written', localRetry: prepared ? null : 'save', busy: null,
      });

      h.owner.setContext('account-7', h.actor);
      if (prepared) {
        const callsBeforeRetry = h.fixture.invoke.mock.calls.length;
        await h.owner.retryLocal(); await h.owner.queryReceipt(); await h.owner.retryRoles(); await h.owner.retryLocal();
        expect(h.fixture.invoke.mock.calls.slice(callsBeforeRetry).map(([command]) => command)).toEqual([
          STORY_IPC.receipt, STORY_IPC.receipt, STORY_IPC.receipt,
        ]);
        expect(h.owner.getSnapshot()).toMatchObject({ evidence: 'unknown', localRetry: null, active: retained.snapshot });
        expect(h.fixture.attempts).toEqual(new Set([retained.snapshot.saveAttemptId]));
      }
      // Returning to the original account cannot revive the obsolete in-flight
      // action. A prepared attempt is receipt-only even after explicit retries.
      expect(h.fixture.commands(STORY_PENDING_IPC.prepareSave)).toHaveLength(prepared ? 1 : 0);
      expect(h.fixture.commands(STORY_PENDING_IPC.save)).toHaveLength(0);
      expect(h.fixture.slots.get('battle')).toEqual(retained);
      expect(h.fixture.records.chapterDocuments(h.input.session.id)).toHaveLength(0);
      expect(createCalls(h.fixture)).toHaveLength(1); expect(roleCalls(h.fixture)).toHaveLength(1);
      expect(h.onSaved).not.toHaveBeenCalled(); expectOriginalReceiptQueries(h);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally { gate.release(); await run; h.owner.dispose(); }
  });

  it.each(phases)('%s: switching away and back before the reply still invalidates the original epoch', async phase => {
    const h = setup(), gate = delaySavePhase(h.fixture, phase);
    const prepared = phase === 'prepare-ack' || phase === 'prepared-describe';
    const run = h.generate(); await gate.entered;
    try {
      // Keep the scope string stable: actor changes themselves must invalidate the
      // controller/epoch, and matching actor data later cannot restore that action.
      h.owner.setContext('account-7', { kind: 'account', expectedUserId: 8 });
      h.owner.setContext('account-7', h.actor);
      gate.release(); await run;
      expect(h.fixture.commands(STORY_PENDING_IPC.prepareSave)).toHaveLength(prepared ? 1 : 0);
      expect(h.fixture.commands(STORY_PENDING_IPC.save)).toHaveLength(0);
      expect(h.fixture.records.chapterDocuments(h.input.session.id)).toHaveLength(0);
      expect(h.owner.getSnapshot()).toMatchObject({ actorCurrent: true, evidence: prepared ? 'unknown' : 'not-written' });
      expect(h.onSaved).not.toHaveBeenCalled(); expectOriginalReceiptQueries(h);
    } finally { gate.release(); await run; h.owner.dispose(); }
  });
});

describe('Hosted owner preserves uncertainty once the original save has been dispatched', () => {
  it.each(['account', 'detach'] as const)('%s invalidation plus a lost save ACK never fabricates rollback or permits another attempt', async change => {
    const h = setup(), entered = deferred<void>(), release = deferred<void>();
    const save = h.fixture.port.save.bind(h.fixture.port);
    vi.spyOn(h.fixture.port, 'save').mockImplementationOnce(async (...args) => {
      await save(...args); entered.resolve(); await release.promise;
      throw new Error('lost committed save acknowledgement');
    });
    const run = h.generate(); await entered.promise;
    try {
      const original = structuredClone(h.owner.getSnapshot().active!);
      expect(h.fixture.commands(STORY_PENDING_IPC.prepareSave)).toHaveLength(1);
      expect(h.fixture.commands(STORY_PENDING_IPC.save)).toHaveLength(1);
      expect(h.fixture.records.chapterDocuments(h.input.session.id)).toHaveLength(1);
      expect(h.fixture.slots.size).toBe(0); expect(h.fixture.attempts.size).toBe(0);

      invalidate(h.owner, change); h.fixture.records.hideReceipts = true; release.resolve(); await run;
      expect(h.owner.getSnapshot()).toMatchObject({ evidence: 'unknown', localRetry: null, active: original, busy: null });
      expect(h.onSaved).not.toHaveBeenCalled();

      h.owner.setContext('account-7', h.actor);
      const callsBeforeRetry = h.fixture.invoke.mock.calls.length;
      await h.owner.retryLocal(); await h.owner.queryReceipt(); await h.owner.retryRoles(); await h.owner.retryLocal();
      expect(h.fixture.invoke.mock.calls.slice(callsBeforeRetry).map(([command]) => command)).toEqual([
        STORY_IPC.receipt, STORY_IPC.receipt, STORY_IPC.receipt,
      ]);
      expect(h.owner.getSnapshot()).toMatchObject({ evidence: 'unknown', localRetry: null, active: original });
      expect(h.onSaved).not.toHaveBeenCalled();

      h.fixture.records.hideReceipts = false; await h.owner.queryReceipt();
      expect(h.onSaved).toHaveBeenCalledTimes(1);
      expect(h.onSaved.mock.calls[0]?.[0]).toMatchObject({ sessionId: h.input.session.id, operationId: h.input.operationId,
        chapterId: h.input.operationId, revision: 1, chapterCount: 1 });
      expect(h.owner.getSnapshot().active).toBeNull(); expect(h.fixture.pointers.size).toBe(0);
      expect(h.fixture.commands(STORY_PENDING_IPC.prepareSave)).toHaveLength(1);
      expect(h.fixture.commands(STORY_PENDING_IPC.save)).toHaveLength(1);
      expect(h.fixture.records.chapterDocuments(h.input.session.id)).toHaveLength(1);
      expect(createCalls(h.fixture)).toHaveLength(1); expect(roleCalls(h.fixture)).toHaveLength(1);
      expectOriginalReceiptQueries(h); expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally { release.resolve(); await run; h.owner.dispose(); }
  });
});

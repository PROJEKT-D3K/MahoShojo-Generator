import { describe, expect, it, vi } from 'vitest';
import { DESKTOP_ARENA_HOSTED_LIMITS } from '@mahoshojo/contracts/desktop-arena-hosted';
import { DesktopArenaHostedAnyRecoveryPointerSchema } from '@mahoshojo/contracts/desktop-arena-hosted-json';
import {
  DesktopArenaHostedStoryRecoveryPointerSchema,
  type DesktopArenaHostedStoryRecoveryPointer,
} from '@mahoshojo/contracts/desktop-arena-story-transport';
import { ARENA_HOSTED_RECOVERY_KEYS } from '../src/features/arena/hosted-recovery';
import {
  DesktopArenaHostedStoryRecovery,
  type ArenaHostedStoryRecoveryPatch,
} from '../src/features/arena/hosted-story-recovery';

const pointer = (patch: Partial<DesktopArenaHostedStoryRecoveryPointer> = {}): DesktopArenaHostedStoryRecoveryPointer => ({
  version: 4, purpose: 'story', product: 'battle', delivery: 'stream', protocolVersion: 'arena-hosted-sse-v1',
  storyProtocolVersion: 'arena-story-v1', requestId: 'story-request-0001', bodyHash: 'a'.repeat(64),
  actor: { kind: 'anonymous' }, format: 'markdown', battleMode: 'daily', state: 'prepared',
  updatedAt: '2026-10-10T18:00:00.000Z', inputDigest: `sha256:${'b'.repeat(64)}`,
  sessionId: 'original-session', operationId: 'original-operation', ...patch,
});
const recoveryPointer = () => pointer({ state: 'unknown' });
const generationId = `arena_${'c'.repeat(64)}`;
const foreign = (version: 1 | 2 | 3) => DesktopArenaHostedAnyRecoveryPointerSchema.parse({
  version, product: 'battle', protocolVersion: 'arena-hosted-sse-v1', requestId: `single-request-${version}`,
  bodyHash: 'a'.repeat(64), actor: { kind: 'anonymous' }, format: 'markdown', battleMode: 'daily',
  state: 'prepared', updatedAt: '2026-10-10T18:00:00.000Z',
  ...(version !== 1 ? { delivery: 'stream' } : {}),
  ...(version === 3 ? { reconciliationVersion: 'arena-reconciliation-v1', writeArenaHistory: true, writeCurrentState: true } : {}),
});
class Storage {
  values = new Map<string, string>();
  failRead = false;
  failWrite = false;
  failRemove = false;
  getItem = vi.fn((key: string) => {
    if (this.failRead) throw new Error('read canary');
    return this.values.get(key) ?? null;
  });
  setItem = vi.fn((key: string, raw: string) => {
    if (this.failWrite) throw new Error('write canary');
    this.values.set(key, raw);
  });
  removeItem = vi.fn((key: string) => {
    if (this.failRemove) throw new Error('remove canary');
    this.values.delete(key);
  });
}
function setup(raw?: string) {
  const storage = new Storage();
  if (raw !== undefined) storage.values.set(ARENA_HOSTED_RECOVERY_KEYS.battle, raw);
  return { storage, owner: new DesktopArenaHostedStoryRecovery(storage, 'battle') };
}

describe('Hosted story v4 public pointer owner', () => {
  it('uses only the original two product slots, independently of large body drafts', () => {
    const storage = new Storage();
    storage.values.set('mahoshojo.desktop.arena.battle.draft.v1', 'unrelated body');
    const battle = new DesktopArenaHostedStoryRecovery(storage, 'battle');
    const arena = new DesktopArenaHostedStoryRecovery(storage, 'arena');
    expect(battle.prepare(pointer())).toBe(true);
    expect(arena.prepare(pointer({ product: 'arena', requestId: 'arena-story-0002' }))).toBe(true);
    expect(battle.clear(pointer().requestId, battle.getSnapshot().raw!)).toBe(true);
    expect(storage.getItem(ARENA_HOSTED_RECOVERY_KEYS.arena)).not.toBeNull();
    expect(storage.getItem('mahoshojo.desktop.arena.battle.draft.v1')).toBe('unrelated body');
    expect(storage.setItem.mock.calls.map(([key]) => key)).toEqual([
      'mahoshojo.desktop.arena.battle.hosted-recovery.v1', 'mahoshojo.desktop.arena.advanced.hosted-recovery.v1',
    ]);
  });

  it('reads valid v4 without writing and retains the exact raw including whitespace', () => {
    const original = pointer({ state: 'resuming', generationId, cursor: '80-0' });
    const raw = ` \n${JSON.stringify(original)}\t`, { storage, owner } = setup(raw);
    expect(owner.getSnapshot()).toMatchObject({ pointer: original, raw, kind: 'story', pendingRestore: true, blocked: false, saved: true });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(owner.acceptRestore('wrong-request')).toBeNull();
    expect(owner.acceptRestore(original.requestId)).toEqual(original);
    expect(owner.getSnapshot().pendingRestore).toBe(false);
    expect(storage.getItem(ARENA_HOSTED_RECOVERY_KEYS.battle)).toBe(raw);
  });

  it.each([1, 2, 3] as const)('v%s remains a read-only foreign record with no story authority', (version) => {
    const original = foreign(version), raw = ` ${JSON.stringify(original)} `, { storage, owner } = setup(raw);
    expect(owner.getSnapshot()).toMatchObject({ pointer: null, raw, kind: 'foreign', pendingRestore: false, blocked: true });
    expect(owner.prepare(pointer())).toBe(false);
    expect(owner.recoverFromClaim(recoveryPointer())).toBe(false);
    expect(owner.acceptRestore(original.requestId)).toBeNull();
    expect(owner.update(original.requestId, { state: 'completed' })).toBe(false);
    expect(owner.clear(original.requestId, raw)).toBe(false);
    expect(storage.getItem(ARENA_HOSTED_RECOVERY_KEYS.battle)).toBe(raw);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it.each([
    '{unreadable', 'null', '[]', JSON.stringify({ ...pointer(), product: 'arena' }),
    JSON.stringify({ ...pointer(), version: 5 }), JSON.stringify({ ...pointer(), funding: { mode: 'system' } }),
    JSON.stringify({ ...pointer(), pendingRevision: 3 }), JSON.stringify({ ...pointer(), writeOptions: {} }),
    JSON.stringify({ ...pointer(), secret: 'secret-canary' }), JSON.stringify({ ...pointer(), inputDigest: 'bad' }),
  ])('never repairs, overwrites or clears an invalid original %#', (raw) => {
    const { storage, owner } = setup(raw);
    expect(owner.getSnapshot()).toMatchObject({ kind: 'invalid', pointer: null, raw, blocked: true });
    expect(owner.getSnapshot().error).not.toContain('secret-canary');
    expect(owner.prepare(pointer())).toBe(false);
    expect(owner.recoverFromClaim(recoveryPointer())).toBe(false);
    expect(owner.update(pointer().requestId, { state: 'failed' })).toBe(false);
    expect(owner.acceptRestore(pointer().requestId)).toBeNull();
    expect(owner.clear(pointer().requestId, raw)).toBe(false);
    expect(storage.getItem(ARENA_HOSTED_RECOVERY_KEYS.battle)).toBe(raw);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('applies the 16,384 UTF-16 code-unit bound to the raw original before parsing', () => {
    expect(DESKTOP_ARENA_HOSTED_LIMITS.recoveryPointerCodeUnits).toBe(16_384);
    const original = JSON.stringify(pointer());
    const atLimit = original.padEnd(16_384, ' '), overLimit = `${atLimit} `;
    expect(setup(atLimit).owner.getSnapshot().kind).toBe('story');
    const parse = vi.spyOn(JSON, 'parse');
    try {
      const { storage, owner } = setup(overLimit);
      expect(parse).not.toHaveBeenCalled();
      expect(owner.getSnapshot()).toMatchObject({ kind: 'oversized', pointer: null, raw: overLimit, blocked: true });
      expect(owner.prepare(pointer())).toBe(false);
      expect(owner.recoverFromClaim(recoveryPointer())).toBe(false);
      expect(owner.clear(pointer().requestId, overLimit)).toBe(false);
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.removeItem).not.toHaveBeenCalled();
    } finally { parse.mockRestore(); }
    expect(setup('😀'.repeat(8193)).owner.getSnapshot().kind).toBe('oversized');
  });

  it('treats an unreadable slot as unavailable, not empty, until an explicit successful reread', () => {
    const storage = new Storage(); storage.failRead = true;
    const owner = new DesktopArenaHostedStoryRecovery(storage, 'battle');
    expect(owner.getSnapshot()).toMatchObject({ kind: 'unavailable', blocked: true, pointer: null });
    expect(owner.getSnapshot().error).not.toContain('canary');
    storage.failRead = false;
    expect(owner.prepare(pointer())).toBe(false);
    expect(owner.recoverFromClaim(recoveryPointer())).toBe(false);
    expect(owner.read().kind).toBe('empty');
    expect(owner.prepare(pointer())).toBe(true);
  });

  it('prepares only a fresh intent in an empty slot and never grants its own replacement', () => {
    const { storage, owner } = setup();
    expect(owner.prepare(pointer({ state: 'unknown' }))).toBe(false);
    expect(owner.prepare(pointer({ generationId }))).toBe(false);
    expect(owner.prepare(pointer({ cursor: '0-0' }))).toBe(false);
    expect(owner.prepare(pointer())).toBe(true);
    const raw = owner.getSnapshot().raw;
    expect(owner.getSnapshot().pendingRestore).toBe(false);
    expect(owner.prepare(pointer())).toBe(false);
    expect(owner.prepare(pointer({ requestId: 'new-story-0002' }))).toBe(false);
    expect(owner.update(pointer().requestId, { state: 'completed' })).toBe(true);
    expect(owner.prepare(pointer({ requestId: 'new-story-0002' }))).toBe(false);
    expect(raw).not.toBeNull();
    expect(storage.setItem).toHaveBeenCalledTimes(2);
  });

  it('restores a missing pointer from the caller-verified claim without any create-ready transition', () => {
    const { storage, owner } = setup();
    expect(owner.recoverFromClaim(pointer())).toBe(false);
    expect(owner.recoverFromClaim(recoveryPointer())).toBe(true);
    expect(owner.getSnapshot()).toMatchObject({ kind: 'story', pointer: recoveryPointer(), pendingRestore: true });
    expect(owner.getSnapshot().pointer?.generationId).toBeUndefined();
    expect(owner.getSnapshot().pointer?.cursor).toBeUndefined();
    expect(owner.prepare(pointer())).toBe(false);
    expect(owner.update(pointer().requestId, { state: 'prepared' })).toBe(false);
    expect(owner.acceptRestore(pointer().requestId)).toEqual(recoveryPointer());
    expect(owner.getSnapshot().pendingRestore).toBe(false);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it.each(['prepare', 'recoverFromClaim'] as const)('raw-CAS rejects an external writer before %s', (method) => {
    const { storage, owner } = setup();
    const external = JSON.stringify(foreign(3)); storage.values.set(ARENA_HOSTED_RECOVERY_KEYS.battle, external);
    expect(owner[method](method === 'prepare' ? pointer() : recoveryPointer())).toBe(false);
    expect(owner.getSnapshot().blocked).toBe(true);
    expect(storage.getItem(ARENA_HOSTED_RECOVERY_KEYS.battle)).toBe(external);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(owner.read().kind).toBe('foreign');
  });

  it.each(['story', 'foreign', 'invalid', 'oversized', 'empty'] as const)('preserves an externally replaced %s original on all late operations', (kind) => {
    const { storage, owner } = setup(JSON.stringify(pointer()));
    const raw = owner.getSnapshot().raw!;
    const external = kind === 'story' ? JSON.stringify(pointer({ requestId: 'external-story-0002' }))
      : kind === 'foreign' ? JSON.stringify(foreign(2)) : kind === 'invalid' ? '{new original'
        : kind === 'oversized' ? 'x'.repeat(16_385) : null;
    if (external === null) storage.values.delete(ARENA_HOSTED_RECOVERY_KEYS.battle);
    else storage.values.set(ARENA_HOSTED_RECOVERY_KEYS.battle, external);
    expect(owner.update(pointer().requestId, { state: 'unknown', generationId })).toBe(false);
    expect(owner.getSnapshot()).toMatchObject({ blocked: true, saved: false, raw, pointer: { generationId } });
    expect(owner.acceptRestore(pointer().requestId)).toBeNull();
    expect(owner.clear(pointer().requestId, raw)).toBe(false);
    expect(owner.prepare(pointer({ requestId: 'new-story-0003' }))).toBe(false);
    expect(owner.recoverFromClaim(recoveryPointer())).toBe(false);
    expect(storage.getItem(ARENA_HOSTED_RECOVERY_KEYS.battle)).toBe(external);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it.each(['acceptRestore', 'clear'] as const)('%s also checks raw-CAS without an earlier update', (operation) => {
    const { storage, owner } = setup(JSON.stringify(pointer()));
    const raw = owner.getSnapshot().raw!;
    const external = ` ${raw}`; storage.values.set(ARENA_HOSTED_RECOVERY_KEYS.battle, external);
    if (operation === 'clear') expect(owner.clear(pointer().requestId, raw)).toBe(false);
    else expect(owner.acceptRestore(pointer().requestId)).toBeNull();
    expect(owner.getSnapshot().blocked).toBe(true);
    expect(storage.getItem(ARENA_HOSTED_RECOVERY_KEYS.battle)).toBe(external);
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('clears only the exact request and original raw, allowing a later separately authorized fresh intent', () => {
    const raw = ` ${JSON.stringify(pointer())} `, { storage, owner } = setup(raw);
    expect(owner.clear('wrong-request', raw)).toBe(false);
    expect(owner.clear(pointer().requestId, JSON.stringify(pointer()))).toBe(false);
    expect(owner.clear(pointer().requestId, raw)).toBe(true);
    expect(owner.getSnapshot()).toMatchObject({ kind: 'empty', pointer: null, raw: null, blocked: false });
    expect(storage.removeItem).toHaveBeenCalledTimes(1);
    expect(owner.prepare(pointer({ requestId: 'new-story-0002' }))).toBe(true);
    expect(owner.clear(pointer().requestId, raw)).toBe(false);
    expect(storage.getItem(ARENA_HOSTED_RECOVERY_KEYS.battle)).toBe(owner.getSnapshot().raw);
  });

  it('does not allow a clear acknowledgement captured before a later pointer update', () => {
    const { storage, owner } = setup(JSON.stringify(pointer()));
    const original = owner.getSnapshot().raw!;
    expect(owner.update(pointer().requestId, { state: 'unknown' })).toBe(true);
    const updated = owner.getSnapshot().raw;
    expect(owner.clear(pointer().requestId, original)).toBe(false);
    expect(storage.getItem(ARENA_HOSTED_RECOVERY_KEYS.battle)).toBe(updated);
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('retains exact original on remove failure and permits retry with the same receipt', () => {
    const raw = JSON.stringify(pointer()), { storage, owner } = setup(raw);
    storage.failRemove = true;
    expect(owner.clear(pointer().requestId, raw)).toBe(false);
    expect(owner.getSnapshot()).toMatchObject({ pointer: pointer(), raw, kind: 'story', saved: false });
    expect(storage.getItem(ARENA_HOSTED_RECOVERY_KEYS.battle)).toBe(raw);
    storage.failRemove = false;
    expect(owner.clear(pointer().requestId, raw)).toBe(true);
  });

  it('rejects malformed or authority-expanding patches at runtime', () => {
    const { storage, owner } = setup(JSON.stringify(pointer()));
    const invalid: unknown[] = [
      { requestId: 'changed-request-0002' }, { product: 'arena' }, { bodyHash: 'd'.repeat(64) },
      { actor: { kind: 'account', expectedUserId: 4 } }, { sessionId: 'changed-session' },
      { funding: { mode: 'system' } }, { pendingRevision: 9 }, { writeOptions: {} },
      { cursor: 'bad-cursor-canary' }, { updatedAt: 'bad-time' },
    ];
    expect(owner.update('wrong-request', { state: 'failed' })).toBe(false);
    for (const patch of invalid) expect(owner.update(pointer().requestId, patch as ArenaHostedStoryRecoveryPatch)).toBe(false);
    expect(owner.getSnapshot().pointer).toEqual(pointer());
    expect(owner.getSnapshot().error).not.toContain('canary');
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(owner.update(pointer().requestId, { generationId, cursor: '1-0', state: 'generating' })).toBe(true);
    expect(owner.update(pointer().requestId, { generationId: `arena_${'d'.repeat(64)}` })).toBe(false);
    expect(owner.update(pointer().requestId, { generationId: undefined })).toBe(false);
    expect(owner.update(pointer().requestId, { state: 'prepared' })).toBe(false);
    expect(owner.getSnapshot().pointer?.generationId).toBe(generationId);
  });

  it('distinguishes prewrite failure from a live update failure and keeps live identity in memory', () => {
    const { storage, owner } = setup(); storage.failWrite = true;
    expect(owner.prepare(pointer())).toBe(false);
    expect(owner.getSnapshot()).toMatchObject({ kind: 'empty', pointer: null, raw: null, saved: false });
    storage.failWrite = false; expect(owner.prepare(pointer())).toBe(true);
    const original = owner.getSnapshot().raw; storage.failWrite = true;
    expect(owner.update(pointer().requestId, { generationId, cursor: '2-1', state: 'unknown' })).toBe(false);
    expect(owner.getSnapshot()).toMatchObject({ raw: original, saved: false, pointer: { generationId, cursor: '2-1' } });
    expect(storage.getItem(ARENA_HOSTED_RECOVERY_KEYS.battle)).toBe(original);
    expect(owner.getSnapshot().error).not.toContain('canary');
    storage.failWrite = false;
    expect(owner.update(pointer().requestId, { state: 'resuming' })).toBe(true);
    expect(DesktopArenaHostedStoryRecoveryPointerSchema.parse(JSON.parse(owner.getSnapshot().raw!))).toMatchObject({ generationId, cursor: '2-1', state: 'resuming' });
  });

  it('freezes snapshots and emits stable subscription updates without persisting Native authority', () => {
    const { owner } = setup(), listener = vi.fn(), unsubscribe = owner.subscribe(listener);
    const previous = owner.getSnapshot(); expect(owner.getSnapshot()).toBe(previous);
    expect(owner.prepare(pointer())).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(owner.getSnapshot())).toBe(true);
    expect(Object.isFrozen(owner.getSnapshot().pointer)).toBe(true);
    expect(Object.isFrozen(owner.getSnapshot().pointer?.actor)).toBe(true);
    for (const key of ['funding', 'pendingRevision', 'writeOptions', 'secret', 'createClaim']) {
      expect(JSON.parse(owner.getSnapshot().raw!)).not.toHaveProperty(key);
    }
    unsubscribe(); owner.acceptRestore(pointer().requestId);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

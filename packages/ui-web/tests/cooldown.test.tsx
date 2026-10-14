// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildProviderCooldownStorageKey,
  getProviderCooldownNoticeText,
  readCooldownSnapshot,
  subscribeCooldownKey,
  useCooldown,
  useProviderModeCooldown,
  writeCooldownSnapshot,
  type ProviderCooldownMode,
} from '../src/cooldown';

const KEY = 'nameGenerationCooldown';
let container: HTMLDivElement;
let root: Root;
const hooks = new Map<string, ReturnType<typeof useCooldown>>();
let provider: ReturnType<typeof useProviderModeCooldown>;

function Harness({ id = 'first', storageKey = KEY }: { id?: string; storageKey?: string }) {
  const state = useCooldown(storageKey, 60_000);
  hooks.set(id, state);
  return <output data-testid={id}>{state.remainingTime}</output>;
}

function ProviderHarness({ mode }: { mode: ProviderCooldownMode }) {
  provider = useProviderModeCooldown({
    baseKey: 'arena', currentMode: mode, systemDurationMs: 60_000, customDurationMs: 15_000,
  });
  return <output>{provider.remainingTime}/{provider.otherRemainingTime}</output>;
}

function storageEvent(key: string | null, newValue: string | null = null, storageArea = localStorage) {
  window.dispatchEvent(new StorageEvent('storage', { key, newValue, storageArea }));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  localStorage.clear();
  storageEvent(null);
  hooks.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('shared cooldown storage and notifications', () => {
  it('notifies every matching subscriber, isolates notification exceptions and unsubscribes', () => {
    const bad = subscribeCooldownKey(KEY, () => { throw new Error('notification failed'); });
    const current = vi.fn();
    const unrelated = vi.fn();
    const off = subscribeCooldownKey(KEY, current);
    const offOther = subscribeCooldownKey('other', unrelated);
    const endTime = Date.now() + 60_000;

    expect(writeCooldownSnapshot(KEY, endTime)).toEqual({ endTime, remainingTime: 60 });
    expect(current).toHaveBeenCalledTimes(1);
    expect(unrelated).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBe(String(endTime));
    storageEvent(KEY, String(endTime));
    expect(current).toHaveBeenCalledTimes(2);
    off();
    writeCooldownSnapshot(KEY, null);
    expect(current).toHaveBeenCalledTimes(2);
    bad();
    offOther();
  });

  it('does not clean an unparseable value and tolerates failed expiration cleanup', () => {
    localStorage.setItem(KEY, 'unknown-format');
    expect(readCooldownSnapshot(KEY)).toEqual({ endTime: null, remainingTime: 0 });
    expect(localStorage.getItem(KEY)).toBe('unknown-format');
    localStorage.setItem(KEY, String(Date.now() - 1));
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied'); });
    expect(readCooldownSnapshot(KEY)).toEqual({ endTime: null, remainingTime: 0 });
    expect(readCooldownSnapshot(KEY)).toEqual({ endTime: null, remainingTime: 0 });
  });

  it('keeps a failed explicit clear in this document without resurrecting the stale stored value', () => {
    writeCooldownSnapshot(KEY, Date.now() + 60_000);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied'); });
    expect(writeCooldownSnapshot(KEY, null)).toEqual({ endTime: null, remainingTime: 0 });
    expect(readCooldownSnapshot(KEY)).toEqual({ endTime: null, remainingTime: 0 });
    expect(localStorage.getItem(KEY)).not.toBeNull();
  });

  it('does not claim a failed write survived a fresh document', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(writeCooldownSnapshot(KEY, Date.now() + 60_000).remainingTime).toBe(60);
    vi.stubGlobal('window', new EventTarget());
    expect(readCooldownSnapshot(KEY)).toEqual({ endTime: null, remainingTime: 0 });
    vi.unstubAllGlobals();
    expect(readCooldownSnapshot(KEY).remainingTime).toBe(60);
  });

  it('restores a successfully persisted deadline in a fresh document', () => {
    writeCooldownSnapshot(KEY, Date.now() + 60_000);
    vi.stubGlobal('window', new EventTarget());
    expect(readCooldownSnapshot(KEY).remainingTime).toBe(60);
  });

  it('handles absent storage and isolates fallback state by key', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(readCooldownSnapshot(KEY).remainingTime).toBe(0);
    expect(writeCooldownSnapshot(KEY, Date.now() + 60_000).remainingTime).toBe(60);
    expect(readCooldownSnapshot('other').remainingTime).toBe(0);
    vi.unstubAllGlobals();
    // Restored storage still has no value; that must not replace the failed local write.
    expect(readCooldownSnapshot(KEY).remainingTime).toBe(60);
  });

  it('accepts cross-page updates while unmounted and ignores sessionStorage notifications', () => {
    const failedWrite = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    writeCooldownSnapshot(KEY, Date.now() + 60_000);
    storageEvent(null, null, sessionStorage);
    expect(readCooldownSnapshot(KEY).remainingTime).toBe(60);
    failedWrite.mockRestore();
    const endTime = Date.now() + 90_000;
    localStorage.setItem(KEY, String(endTime));
    storageEvent(KEY, String(endTime));
    expect(readCooldownSnapshot(KEY).remainingTime).toBe(90);
    localStorage.clear();
    storageEvent(null);
    expect(readCooldownSnapshot(KEY).remainingTime).toBe(0);
  });

  it('uses a storage event snapshot when getItem is unavailable', () => {
    writeCooldownSnapshot(KEY, Date.now() + 60_000);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    storageEvent(KEY, String(Date.now() + 90_000));
    expect(readCooldownSnapshot(KEY).remainingTime).toBe(90);
    storageEvent(KEY, null);
    expect(readCooldownSnapshot(KEY).remainingTime).toBe(0);
  });
});

describe('useCooldown', () => {
  it('mounts and starts a session cooldown when accessing localStorage itself throws', () => {
    vi.spyOn(globalThis, 'localStorage', 'get').mockImplementation(() => { throw new Error('denied'); });
    act(() => root.render(<Harness />));
    expect(hooks.get('first')?.isCooldown).toBe(false);
    act(() => hooks.get('first')!.startCooldown());
    expect(hooks.get('first')?.remainingTime).toBe(60);
  });

  it('mounts when reading storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    act(() => root.render(<Harness />));
    expect(hooks.get('first')?.isCooldown).toBe(false);
    act(() => hooks.get('first')!.startCooldown());
    expect(hooks.get('first')?.remainingTime).toBe(60);
  });

  it('shares failed writes, counts down and preserves them across route remounts', () => {
    localStorage.setItem(KEY, String(Date.now() + 10_000));
    const failedWrite = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    act(() => root.render(<><Harness /><Harness id="second" /><Harness id="other" storageKey="other" /></>));
    act(() => hooks.get('first')!.startCooldown());
    expect(hooks.get('first')?.remainingTime).toBe(60);
    expect(hooks.get('second')?.remainingTime).toBe(60);
    expect(hooks.get('other')?.remainingTime).toBe(0);
    act(() => vi.advanceTimersByTime(15_000));
    expect(hooks.get('second')?.remainingTime).toBe(45);
    act(() => root.render(null));
    act(() => root.render(<Harness />));
    expect(hooks.get('first')?.remainingTime).toBe(45);
    failedWrite.mockRestore();
    act(() => hooks.get('first')!.startCooldown(90_000));
    expect(localStorage.getItem(KEY)).toBe(String(Date.now() + 90_000));
    act(() => vi.advanceTimersByTime(90_000));
    expect(hooks.get('first')?.isCooldown).toBe(false);
  });

  it('does not let an old timer remove a newer persisted deadline', () => {
    act(() => root.render(<Harness />));
    act(() => hooks.get('first')!.startCooldown(1_000));
    const extended = Date.now() + 60_000;
    // The timer must re-read even before a queued cross-tab storage event arrives.
    localStorage.setItem(KEY, String(extended));
    act(() => vi.advanceTimersByTime(1_000));
    expect(hooks.get('first')?.remainingTime).toBe(59);
    expect(localStorage.getItem(KEY)).toBe(String(extended));
  });

  it('does not delete an unseen extension when reads fail at the cached deadline', () => {
    act(() => root.render(<Harness />));
    act(() => hooks.get('first')!.startCooldown(1_000));
    const extended = Date.now() + 60_000;
    localStorage.setItem(KEY, String(extended));
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    act(() => vi.advanceTimersByTime(1_000));
    expect(removeItem).not.toHaveBeenCalled();
    getItem.mockRestore();
    expect(localStorage.getItem(KEY)).toBe(String(extended));
    act(() => root.render(null));
    act(() => root.render(<Harness />));
    expect(hooks.get('first')?.remainingTime).toBe(59);
  });

  it('honors cross-page set/remove/clear for mounted consumers', () => {
    act(() => root.render(<Harness />));
    const endTime = Date.now() + 60_000;
    act(() => {
      localStorage.setItem(KEY, String(endTime));
      storageEvent(KEY, String(endTime));
    });
    expect(hooks.get('first')?.remainingTime).toBe(60);
    act(() => { localStorage.removeItem(KEY); storageEvent(KEY); });
    expect(hooks.get('first')?.remainingTime).toBe(0);
    act(() => hooks.get('first')!.startCooldown());
    act(() => { localStorage.clear(); storageEvent(null); });
    expect(hooks.get('first')?.remainingTime).toBe(0);
  });

  it('skips storage and cooldown entirely in development', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    act(() => root.render(<Harness />));
    act(() => hooks.get('first')!.startCooldown());
    expect(hooks.get('first')).toMatchObject({ isCooldown: false, remainingTime: 0 });
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it('keeps provider mode keys, durations and the other-channel notice independent', () => {
    act(() => root.render(<ProviderHarness mode="system" />));
    act(() => provider.startCooldown());
    act(() => root.render(<ProviderHarness mode="custom" />));
    expect(provider).toMatchObject({ remainingTime: 0, otherMode: 'system', otherRemainingTime: 60 });
    expect(getProviderCooldownNoticeText({ currentMode: 'custom', currentIsCooldown: false, otherRemainingTime: 60 }))
      .toBe('默认通道冷却中 (60s)，当前自定义通道仍可使用。');
    act(() => provider.startCooldown());
    expect(provider).toMatchObject({ remainingTime: 15, otherRemainingTime: 60 });
    expect(localStorage.getItem(buildProviderCooldownStorageKey('arena', 'custom'))).toBe(String(Date.now() + 15_000));
    act(() => root.render(<ProviderHarness mode="system" />));
    expect(provider).toMatchObject({ remainingTime: 60, otherRemainingTime: 15 });
  });
});

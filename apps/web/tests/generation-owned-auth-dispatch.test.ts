// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authStorage, AuthIdentityChangedError, type OwnedAuthHeaders } from '@/lib/auth';
import { AUTH_STORAGE_KEY, captureAuthIdentity, type AuthIdentity } from '@/lib/auth-identity';
import { honoApiConfig } from '@/config/hono-api';
import { hostedDrClientRouting } from '@/config/hosted-routing';
import {
  createGenerationApiIntentLatch, createPinnedGenerationApiSafeReadDispatcher,
  type GenerationApiAuth,
} from '@/lib/hono-api-client';

const originalConfig = { ...honoApiConfig };
const a = { username: 'fixture-owner-a', userId: 101, authKey: 'synthetic-a', activityToken: 'synthetic-activity-a' };
const b = { username: 'fixture-owner-b', userId: 202, authKey: 'synthetic-b', activityToken: 'synthetic-activity-b' };
let rawA: string;
let rawB: string;
const deferred = <T,>() => {
  let resolve!: (_value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const switchIdentity = (raw: string) => {
  const oldValue = localStorage.getItem(AUTH_STORAGE_KEY);
  localStorage.setItem(AUTH_STORAGE_KEY, raw);
  window.dispatchEvent(new StorageEvent('storage', {
    key: AUTH_STORAGE_KEY, oldValue, newValue: raw, storageArea: localStorage,
  }));
};
const verified = () => ({ success: true, authSource: 'better-auth-session', authKey: a.authKey,
  user: { id: a.userId, username: a.username }, activityToken: a.activityToken });
const ready = () => Response.json({
  ok: true, service: 'mahoshojo-hono', placement: 'hono-primary',
  contractVersion: hostedDrClientRouting.contractVersion,
}, { headers: { 'Cache-Control': 'no-store' } });

// These are consumer adapters, not replacement auth/dispatch implementations: the
// credential resolution, placement, latch lifecycle and final fetch are real.
const ownedDependencies = (identity: AuthIdentity = captureAuthIdentity()) => {
  let owned: OwnedAuthHeaders | undefined;
  let preparing: Promise<OwnedAuthHeaders> | undefined;
  const prepare = () => preparing ??= authStorage.getOwnedAuthHeaders(identity).then((value) => {
    owned = value;
    return value;
  });
  const auth: GenerationApiAuth = Object.freeze({
    getAuthHeader: async () => (await prepare()).headers.Authorization ?? null,
    getActivityHeaders: async () => {
      const { Authorization: _authorization, ...activity } = (await prepare()).headers;
      return activity;
    },
  });
  return {
    auth,
    beforeDispatch: () => {
      if (!(owned?.identity ?? identity).isCurrent()) throw new AuthIdentityChangedError();
    },
  };
};

beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  localStorage.clear();
  await authStorage.setAuth(b); rawB = localStorage.getItem(AUTH_STORAGE_KEY)!;
  await authStorage.setAuth(a); rawA = localStorage.getItem(AUTH_STORAGE_KEY)!;
  Object.assign(honoApiConfig, { enabled: true, routingMode: 'client-preflight', origin: hostedDrClientRouting.primaryOrigin });
});
afterEach(() => {
  vi.restoreAllMocks();
  authStorage.clearAuth();
  Object.assign(honoApiConfig, originalConfig);
  vi.unstubAllGlobals();
});

describe('owned generation authentication', () => {
  it('returns one immutable credential snapshot without probing a stored bearer', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const identity = captureAuthIdentity();
    const owned = await authStorage.getOwnedAuthHeaders(identity);
    expect(owned.identity).toBe(identity);
    expect(Object.isFrozen(owned)).toBe(true);
    expect(Object.isFrozen(owned.identity)).toBe(true);
    expect(Object.isFrozen(owned.headers)).toBe(true);
    expect(owned.headers).toEqual({ Authorization: 'Bearer synthetic-a',
      'x-mahoshojo-user-id': '101', 'x-mahoshojo-activity-token': 'synthetic-activity-a' });
    expect(fetcher).not.toHaveBeenCalled();
    switchIdentity(rawB);
    expect(owned.identity.isCurrent()).toBe(false);
    expect(owned.headers.Authorization).toBe('Bearer synthetic-a');
    await expect(authStorage.getOwnedAuthHeaders(identity)).rejects.toBeInstanceOf(AuthIdentityChangedError);
  });

  it('allows its own cookie bootstrap and returns the renewed immutable identity', async () => {
    authStorage.clearAuth();
    const identity = captureAuthIdentity();
    const fetcher = vi.fn(async () => Response.json(verified())); vi.stubGlobal('fetch', fetcher);
    const owned = await authStorage.getOwnedAuthHeaders(identity);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(identity.isCurrent()).toBe(false);
    expect(owned.identity).not.toBe(identity);
    expect(owned.identity.isCurrent()).toBe(true);
    expect(Object.isFrozen(owned.identity)).toBe(true);
    expect(owned.headers).toMatchObject({ Authorization: 'Bearer synthetic-a', 'x-mahoshojo-user-id': '101' });
  });

  it('rejects a stale cookie bootstrap instead of returning anonymous or mixed-account headers', async () => {
    authStorage.clearAuth();
    const entered = deferred<void>(); const gate = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(async () => { entered.resolve(); return gate.promise; }));
    const pending = authStorage.getOwnedAuthHeaders(captureAuthIdentity());
    const rejected = expect(pending).rejects.toBeInstanceOf(AuthIdentityChangedError);
    await entered.promise;
    switchIdentity(rawB);
    gate.resolve(Response.json(verified()));
    await rejected;
    expect(await authStorage.getAuth()).toMatchObject(b);
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBe(rawB);
  });

  it('replaces bearer-less A activity identity with verified B for every owned header', async () => {
    await authStorage.setAuth({ username: a.username, userId: a.userId, activityToken: a.activityToken });
    const original = captureAuthIdentity();
    const verify = vi.fn(async () => Response.json({ success: true, authSource: 'better-auth-session',
      authKey: b.authKey, user: { id: b.userId, username: b.username }, activityToken: b.activityToken }));
    vi.stubGlobal('fetch', verify);
    const owned = await authStorage.getOwnedAuthHeaders(original);
    expect(verify).toHaveBeenCalledOnce();
    expect(original.isCurrent()).toBe(false);
    expect(owned.identity.isCurrent()).toBe(true);
    expect(owned.headers).toEqual({ Authorization: 'Bearer synthetic-b',
      'x-mahoshojo-user-id': '202', 'x-mahoshojo-activity-token': 'synthetic-activity-b' });
  });

  it('keeps anonymous headers when verification fails without an identity transition', async () => {
    authStorage.clearAuth();
    const identity = captureAuthIdentity();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: false }, { status: 401 })));
    const owned = await authStorage.getOwnedAuthHeaders(identity);
    expect(owned.identity).toBe(identity);
    expect(owned.identity.isCurrent()).toBe(true);
    expect(owned.headers).toEqual({});
  });
});

describe('owned auth through real generation dispatch', () => {
  it('switching during actual decryption sends no business request and releases the latch as not-dispatched', async () => {
    await authStorage.setAuth(b); switchIdentity(rawA);
    const entered = deferred<void>(); const gate = deferred<void>();
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'decrypt').mockImplementationOnce(async (...args) => {
      entered.resolve(); await gate.promise; return decrypt(...args);
    });
    const business = vi.fn(async () => new Response(null, { status: 204 }));
    const fetcher = vi.fn(async (input: string) => input.endsWith('/api/health/ready') ? ready() : business());
    const observe = vi.fn();
    const latch = createGenerationApiIntentLatch({ fetcher, observe });
    const intent = latch.tryAcquire(ownedDependencies())!;
    const pending = intent.dispatch('/api/arena/generate-stream', { method: 'POST' });
    const rejected = expect(pending).rejects.toBeInstanceOf(AuthIdentityChangedError);
    await entered.promise;
    switchIdentity(rawB); gate.resolve();
    await rejected;
    expect(business).not.toHaveBeenCalled();
    expect(observe.mock.calls.map(([event]) => event.terminalClass).filter(Boolean)).toEqual(['not-dispatched']);
    expect(latch.tryAcquire(ownedDependencies())).not.toBeNull();
  });

  it('checks after placement observers and preserves a guard error instead of wrapping it as ambiguous', async () => {
    const business = vi.fn(async () => new Response(null, { status: 204 }));
    const fetcher = vi.fn(async (input: string) => input.endsWith('/api/health/ready') ? ready() : business());
    const observe = vi.fn();
    const latch = createGenerationApiIntentLatch({ fetcher, observe });
    const intent = latch.tryAcquire(ownedDependencies())!;
    intent.subscribeRoutePinSelected(() => switchIdentity(rawB));
    await expect(intent.dispatch('/api/arena/generate-stream', { method: 'POST' }))
      .rejects.toBeInstanceOf(AuthIdentityChangedError);
    expect(intent.getRoutePin()).toEqual({ placement: 'hono-primary' });
    expect(business).not.toHaveBeenCalled();
    expect(observe.mock.calls.map(([event]) => event.terminalClass).filter(Boolean)).toEqual(['not-dispatched']);
    expect(latch.tryAcquire(ownedDependencies())).not.toBeNull();
  });

  it('freezes per-acquisition auth and guard without retaining the preceding account in a reusable latch', async () => {
    honoApiConfig.routingMode = 'static-next';
    const fetcher = vi.fn(async (_input: string, _init?: RequestInit) => new Response(null, { status: 204 }));
    const latch = createGenerationApiIntentLatch({ fetcher });
    const firstDependencies = ownedDependencies();
    const first = latch.tryAcquire(firstDependencies)!;
    const replacementGuard = vi.fn();
    firstDependencies.auth = { getAuthHeader: async () => 'Bearer replacement', getActivityHeaders: async () => ({}) };
    firstDependencies.beforeDispatch = replacementGuard;
    await first.dispatch('/api/generate-battle-story', { method: 'POST' });
    expect(replacementGuard).not.toHaveBeenCalled();
    switchIdentity(rawB);
    const second = latch.tryAcquire(ownedDependencies())!;
    await second.dispatch('/api/generate-battle-story', { method: 'POST' });
    expect(fetcher.mock.calls.map(([, init]) => new Headers(init?.headers).get('Authorization')))
      .toEqual(['Bearer synthetic-a', 'Bearer synthetic-b']);
  });

  it.each(['hono-primary', 'next-dr'] as const)('pinned %s reads guard immediately before fetch and do not reclassify ownership loss', async (placement) => {
    const dependencies = ownedDependencies();
    const readyHeaders = await dependencies.auth.getAuthHeader();
    expect(readyHeaders).toBe('Bearer synthetic-a');
    const fetcher = vi.fn();
    const pinned = createPinnedGenerationApiSafeReadDispatcher({ placement }, { ...dependencies, fetcher });
    switchIdentity(rawB);
    await expect(pinned.dispatch('/api/arena/generation-requests/request-owned-auth', { method: 'GET' }))
      .rejects.toBeInstanceOf(AuthIdentityChangedError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

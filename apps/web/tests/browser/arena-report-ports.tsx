import { useRef } from 'react';

import type { AuthIdentity } from '../../lib/auth-identity';
import type { GenerationApiIntentDependencies, GenerationApiIntentLatch } from '../../lib/hono-api-client';
import { getHarnessConfiguration } from './arena-report-fixtures.mjs';

const unexpected = (name: string): never => {
  throw new Error(`Arena harness does not permit this external port: ${name}`);
};
const allowedGenerationPaths = new Set([
  '/api/generate-battle-story',
  '/api/arena/generate-stream',
  '/api/arena/repair-combatant-meta',
]);

/** Real HTTP to this harness's server; never forward to a hosted API or use credentials. */
const dispatch = async (input: string, init: RequestInit = {}): Promise<Response> => {
  const url = new URL(input, window.location.origin);
  if (url.origin !== window.location.origin || !allowedGenerationPaths.has(url.pathname)) {
    return unexpected(`fetch ${url.origin}${url.pathname}`);
  }
  if ((init.method ?? 'GET').toUpperCase() !== 'POST') return unexpected(`method ${init.method}`);
  const fixture = getHarnessConfiguration(window.location.search);
  url.searchParams.set('harnessFormat', fixture.format);
  url.searchParams.set('generation', fixture.generation);
  url.searchParams.set('metadata', fixture.metadata);
  url.searchParams.set('fixture', fixture.fixture);
  const headers = new Headers(init.headers);
  if (headers.has('Authorization') || headers.has('Cookie')) return unexpected('credential headers');
  return fetch(`${url.pathname}${url.search}`, { ...init, headers, credentials: 'omit' });
};

export const useGenerationApiIntentLatch = (
  dependencies: GenerationApiIntentDependencies = {},
): GenerationApiIntentLatch => {
  const latch = useRef<GenerationApiIntentLatch | null>(null);
  if (!latch.current) {
    let active = false;
    latch.current = {
      tryAcquire(request = {}) {
        if (active) return null;
        active = true;
        let sent = false;
        return {
          getRoutePin: () => null,
          subscribeRoutePinSelected: () => () => undefined,
          async dispatch(input, init) {
            if (sent) return unexpected('duplicate intent dispatch');
            sent = true;
            try {
              (request.beforeDispatch ?? dependencies.beforeDispatch)?.();
              return await dispatch(input, init);
            } finally {
              active = false;
              dependencies.onSettled?.();
            }
          },
        };
      },
    };
  }
  return latch.current;
};

export class AuthIdentityChangedError extends Error {
  constructor() { super('登录身份已变化，已取消旧请求，请重新操作。'); this.name = 'AuthIdentityChangedError'; }
}
export const authStorage = {
  async getOwnedAuthHeaders(identity: AuthIdentity) { return { identity, headers: {} }; },
  async getAuthHeader() { return null; },
  async getActivityHeaders() { return {}; },
  async getAuth() { return null; },
};
// Fail closed if a newly imported production consumer tries a cloud mutation.
const unavailableApi = (name: string) => new Proxy({}, {
  get: (_target, operation) => () => unexpected(`${name}.${String(operation)}`),
});
export const authApi = unavailableApi('authApi');
export const dataCardApi = unavailableApi('dataCardApi');
export const favoritesApi = unavailableApi('favoritesApi');
export const deckApi = unavailableApi('deckApi');
export const deckFavoritesApi = unavailableApi('deckFavoritesApi');
export const deckStatsApi = unavailableApi('deckStatsApi');
// Display-only synthetic identity; no account storage, token or authenticated request exists.
export const useAuth = () => {
  const synthetic = getHarnessConfiguration(window.location.search).author === 'synthetic';
  return { isAuthenticated: synthetic, loading: false, user: synthetic ? { id: 42, username: '合成验收者小夜' } : null, userBadges: [] };
};
export const captureNarrativeDraftOwner = () => ({ scope: 'anonymous' as const, isCurrent: () => true });
export const useClientRouteAdapter = () => ({ push: () => unexpected('navigation') });
export const useProviderModeCooldown = () => ({
  isCooldown: false, startCooldown: () => undefined, remainingTime: 0, otherRemainingTime: 0,
});
export const quickCheck = async (text: string) => ({
  hasSensitiveWords: false, matchDetails: [], detectedWords: [], filteredText: text,
});
export const applyShieldWords = (text: string) => ({ filteredText: text });
export const persistArrestedBackup = async () => undefined;
export const useBattleActions = () => ({ handleResolveRandomPlaceholders: async () => undefined });
export const useStreamCombatantUpdater = () => ({
  updateFromMarkdown: async () => undefined,
  retryGenerationUpdate: async () => undefined,
});
export const useArenaRoomContext = () => null;
export const BattleIllustrationPanel = () => null;
export default function UnavailableCloudSave() { return null; }

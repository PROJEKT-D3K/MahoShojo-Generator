// @vitest-environment jsdom
import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NARRATIVE_DRAFT_FAILURE_CODES } from '@mahoshojo/domain/narrative-drafts';

const mocks = vi.hoisted(() => ({ requestId: '', dispatch: vi.fn(), quickCheck: vi.fn(), update: vi.fn(), appendHistory: vi.fn(), ranking: vi.fn(), cooldown: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ setQueryData: mocks.ranking }) }));
vi.mock('@/lib/client-route-adapter', () => ({ useClientRouteAdapter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/cooldown', () => ({ useProviderModeCooldown: () => ({ isCooldown: false, startCooldown: mocks.cooldown, remainingTime: 0, otherRemainingTime: 0 }) }));
vi.mock('@/lib/sensitive-word-filter', () => ({ quickCheck: mocks.quickCheck }));
vi.mock('@/lib/shield-word-filter', () => ({ applyShieldWords: (text: string) => ({ filteredText: text }) }));
vi.mock('@/lib/auth', () => ({ authStorage: { getAuthHeader: async () => null, getActivityHeaders: async () => ({}) } }));
vi.mock('@/components/arena/hooks/useBattleActions', () => ({ useBattleActions: () => ({ handleResolveRandomPlaceholders: async () => {} }) }));
vi.mock('@/components/arena/hooks/useStreamCombatantUpdater', () => ({ useStreamCombatantUpdater: () => ({ updateFromMarkdown: mocks.update, retryGenerationUpdate: vi.fn() }) }));
vi.mock('@/lib/arena-room/narrative-history-runtime', async (importOriginal) => ({ ...await importOriginal<typeof import('@/lib/arena-room/narrative-history-runtime')>(), appendArenaNarrativeHistoryResult: mocks.appendHistory }));
vi.mock('@/components/arena/multiplayer/useArenaRoom', () => ({ useArenaRoomContext: () => null }));
vi.mock('@/lib/hono-api-client', async (importOriginal) => ({ ...await importOriginal<typeof import('@/lib/hono-api-client')>(), createGenerationApiIntent: () => ({ dispatch: async () => new Response('', { headers: { 'Content-Type': 'text/event-stream', 'X-Mahoshojo-Generation-Id': 'generation-drafts', 'X-Mahoshojo-Generation-Request-Id': mocks.requestId } }) }) }));
vi.mock('@/lib/use-generation-api-intent-latch', () => ({ useGenerationApiIntentLatch: () => ({ tryAcquire: () => ({ dispatch: mocks.dispatch, getRoutePin: () => null, subscribeRoutePinSelected: () => () => {} }) }) }));

import { useBattleEngine } from '@/components/arena/hooks/useBattleEngine';
import { useBattleStore } from '@/components/arena/stores/useBattleStore';
import { useNarrativeHistoryStore } from '@/components/arena/stores/useNarrativeHistoryStore';
import { useNarrativeDraftsStore, NARRATIVE_DRAFTS_STORAGE_KEY } from '@/components/arena/stores/useNarrativeDraftsStore';
let current: ReturnType<typeof useBattleEngine>, root: Root, container: HTMLDivElement;
const Harness = () => { const engine = useBattleEngine(); useEffect(() => { current = engine; }); return null; };
const sse = (id: number, event: string, payload: unknown) => `id: ${id}-0\nevent: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
const markdown = '# 未完成的故事\n安全正文<!-- MAHOSHOJO_META {"input":"不应保存"} -->';
const failed = (code = 'AI_STREAM_INCOMPLETE') => sse(3, 'error', { status: 'failed', ok: false, code, error: 'upstream failed' });
const respond = (body: string, patch: Record<string, string> = {}) => mocks.dispatch.mockImplementation(async (_input: string, init: RequestInit) => {
  const request = JSON.parse(String(init.body));
  mocks.requestId = request.generationRequestId;
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'X-Mahoshojo-Generation-Id': 'generation-drafts', 'X-Mahoshojo-Generation-Request-Id': request.generationRequestId, ...patch } });
});
beforeEach(async () => {
  vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear();
  mocks.quickCheck.mockResolvedValue({ hasSensitiveWords: false, matchDetails: [], detectedWords: [] });
  useNarrativeDraftsStore.setState(useNarrativeDraftsStore.getInitialState());
  useNarrativeHistoryStore.setState(useNarrativeHistoryStore.getInitialState());
  const initial = useBattleStore.getInitialState();
  useBattleStore.setState({ ...initial, reportFormat: 'markdown', generationMode: 'stream', battleMode: 'daily', combatants: [{ type: 'general-character', filename: 'test.json', data: { name: '角色甲' }, isValid: false, isPreset: false }], settings: { ...initial.settings, writeArenaHistory: true, writeCurrentState: true, writeNarrativeHistory: true } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('real C0 → Web wrapper → battle hook draft retention', () => {
  it.each(NARRATIVE_DRAFT_FAILURE_CODES)('retains %s independently and never applies formal result side effects', async code => {
    const roster = useBattleStore.getState().combatants;
    respond(sse(1, 'reasoning', { chunk: 'private reasoning' }) + sse(2, 'markdown', { chunk: markdown }) + failed(code));
    await act(async () => current.handleGenerate());
    const state = useNarrativeDraftsStore.getState();
    expect(state.status).toBe('stored'); expect(state.drafts).toHaveLength(1);
    expect(state.drafts[0]).toMatchObject({ markdown: '# 未完成的故事\n安全正文', completion: { kind: 'server-failed', code }, source: 'hosted' });
    const raw = localStorage.getItem(NARRATIVE_DRAFTS_STORAGE_KEY)!;
    expect(raw).not.toContain('private reasoning'); expect(raw).not.toContain('不应保存'); expect(raw).not.toContain('角色甲'); expect(raw).not.toContain('upstream failed');
    expect(useNarrativeHistoryStore.getState().entries).toEqual([]); expect(useBattleStore.getState().combatants).toEqual(roster);
    expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.appendHistory).not.toHaveBeenCalled(); expect(mocks.ranking).not.toHaveBeenCalled();
  });
  it('offers explicit saving with writeNarrativeHistory disabled', async () => {
    await act(async () => useBattleStore.setState({ settings: { ...useBattleStore.getState().settings, writeNarrativeHistory: false } }));
    respond(sse(1, 'markdown', { chunk: markdown }) + failed()); await act(async () => current.handleGenerate());
    expect(useNarrativeDraftsStore.getState().status).toBe('available'); expect(localStorage.getItem(NARRATIVE_DRAFTS_STORAGE_KEY)).toBeNull();
    useNarrativeDraftsStore.getState().saveCandidate(); expect(useNarrativeDraftsStore.getState().status).toBe('stored');
  });
  it.each([
    ['malformed terminal boolean', sse(1, 'markdown', { chunk: markdown }) + sse(3, 'error', { status: 'failed', code: 'AI_STREAM_INCOMPLETE', ok: 'bad' })],
    ['duplicate SSE event field', sse(1, 'markdown', { chunk: markdown }).replace('event: markdown', 'event: ignored\nevent: markdown') + failed()],
    ['SSE event without data', sse(1, 'markdown', { chunk: markdown }) + 'id: 2-0\nevent: ignored\n\n' + failed()],
    ['unknown SSE event', sse(1, 'markdown', { chunk: markdown }) + sse(2, 'invented', {}) + failed()],
    ['unknown failure', sse(1, 'markdown', { chunk: markdown }) + failed('UNKNOWN')],
    ['safety failure', sse(1, 'markdown', { chunk: markdown }) + failed('CONTENT_FILTERED')],
    ['cancelled', sse(1, 'markdown', { chunk: markdown }) + sse(3, 'done', { status: 'cancelled' })],
    ['duplicate terminal', sse(1, 'markdown', { chunk: markdown }) + failed() + failed()],
    ['late data', sse(1, 'markdown', { chunk: markdown }) + failed() + sse(4, 'markdown', { chunk: 'late' })],
    ['partial buffered tail', sse(1, 'markdown', { chunk: markdown }) + failed() + 'event: done\nda'],
    ['sequence rejection', sse(2, 'markdown', { chunk: markdown }) + sse(1, 'markdown', { chunk: 'old' }) + failed()],
    ['unsafe keys', sse(1, 'markdown', { chunk: markdown }).replace('"chunk":', '"__proto__":{},"chunk":') + failed()],
    ['explicit empty request identity', sse(1, 'markdown', { chunk: markdown, generationRequestId: '' }) + failed()],
    ['explicit null generation identity', sse(1, 'markdown', { chunk: markdown, generationId: null }) + failed()],
    ['identity event mismatch', sse(1, 'markdown', { chunk: markdown, generationId: 'generation-other' }) + failed()],
  ])('rejects %s without upgrading to unconfirmed', async (_label, wire) => {
    respond(wire); await act(async () => current.handleGenerate());
    expect(useNarrativeDraftsStore.getState().candidate).toBeNull(); expect(useNarrativeDraftsStore.getState().drafts).toEqual([]);
  });
  it.each([false, true])('handles exhausted recovery with cursor rejection=%s without fabricating server failure', async badCursor => {
    vi.useFakeTimers();
    try {
      mocks.dispatch.mockImplementation(async (_input: string, init: RequestInit) => {
        const request = JSON.parse(String(init.body));
        mocks.requestId = request.generationRequestId;
        return new Response(sse(2, 'markdown', { chunk: markdown }) + (badCursor ? sse(1, 'markdown', { chunk: 'old' }) : ''), {
          headers: { 'Content-Type': 'text/event-stream', 'X-Mahoshojo-Generation-Id': 'generation-drafts', 'X-Mahoshojo-Generation-Request-Id': request.generationRequestId },
        });
      });
      // Resume uses a separate intent but still exercises the real wrapper and C0 recovery loop.
      await act(async () => {
        const task = current.handleGenerate();
        await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalled());
        await vi.advanceTimersByTimeAsync(500_000);
        await task;
      });
      const candidate = useNarrativeDraftsStore.getState().candidate;
      if (badCursor) expect(candidate).toBeNull();
      else expect(candidate?.completion.kind).toBe('unconfirmed');
      expect(useNarrativeDraftsStore.getState().drafts).toEqual([]);
      if (!badCursor) {
        useNarrativeDraftsStore.getState().saveCandidate();
        expect(useNarrativeDraftsStore.getState().status).toBe('stored');
        expect(useNarrativeDraftsStore.getState().drafts[0]?.completion.kind).toBe('unconfirmed');
      }
    } finally { vi.useRealTimers(); }
  });
  it('checks real upstream request identity even though C0 rewrites the returned header', async () => {
    respond(sse(1, 'markdown', { chunk: markdown }) + failed(), { 'X-Mahoshojo-Generation-Request-Id': 'request-wrong' });
    await act(async () => current.handleGenerate()); expect(useNarrativeDraftsStore.getState().candidate).toBeNull();
  });
  it.each(['web', 'non-stream'])('never retains %s output', async mode => {
    await act(async () => useBattleStore.setState(mode === 'web' ? { reportFormat: 'web' } : { generationMode: 'non-stream' }));
    respond(sse(1, 'markdown', { chunk: markdown }) + failed()); await act(async () => current.handleGenerate());
    expect(useNarrativeDraftsStore.getState().candidate).toBeNull();
  });
  it.each(['cancel', 'unmount'])('rejects late accepted text after %s changes the live scope', async action => {
    let release: (() => void) | undefined;
    mocks.quickCheck.mockImplementation(async (text: string) => {
      if (text.includes('安全正文')) await new Promise<void>(resolve => { release = resolve; });
      return { hasSensitiveWords: false, matchDetails: [], detectedWords: [] };
    });
    respond(sse(1, 'markdown', { chunk: markdown }) + failed());
    let task!: Promise<void>;
    await act(async () => {
      task = current.handleGenerate();
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    });
    await act(async () => {
      if (action === 'cancel') current.stopGeneration();
      else root.render(null);
    });
    await act(async () => { release!(); await task; });
    expect(useNarrativeDraftsStore.getState().candidate).toBeNull(); expect(useNarrativeDraftsStore.getState().drafts).toEqual([]);
  });
  it('rejects content-policy termination and leaves no draft', async () => {
    mocks.quickCheck.mockImplementation(async (text: string) => ({ hasSensitiveWords: text.includes('安全正文'), matchDetails: [{ startIndex: 0 }], detectedWords: ['安全正文'] }));
    respond(sse(1, 'markdown', { chunk: markdown }) + failed()); await act(async () => current.handleGenerate());
    expect(useNarrativeDraftsStore.getState().drafts).toEqual([]); expect(useNarrativeDraftsStore.getState().candidate).toBeNull();
  });
});

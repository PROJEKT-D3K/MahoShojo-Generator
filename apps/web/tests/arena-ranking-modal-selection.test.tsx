// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicRankingItem } from '@mahoshojo/contracts/public-ranking';
import type { CombatantData } from '@/components/arena/types';

const mocks = vi.hoisted(() => ({ items: [] as PublicRankingItem[], userId: null as number | null,
  read: vi.fn(), report: vi.fn(), used: vi.fn(), mark: vi.fn(), details: vi.fn(), requests: [] as unknown[] }));
vi.mock('next/link', () => ({ default: (props: ComponentProps<'a'>) => <a {...props} /> }));
vi.mock('@/lib/card-library-host', () => ({ useWebCardLibraryHost: () => ({ auth: { userId: mocks.userId }, online: { fetchPublicCardById: mocks.read, reportCardStat: mocks.report }, platform: { marks: { isUsed: mocks.used, markUsed: mocks.mark } } }) }));
vi.mock('@/components/ranking/use-ranking-query', () => ({
  useWebRankingQuery: ({ request, enabled }: { request: { kind: string }; enabled: boolean }) => {
    if (enabled) mocks.requests.push(request);
    return { data: request.kind === 'leaderboard' ? { success: true, items: mocks.items } : request.kind === 'tags' ? { success: true, tags: [] } : undefined, isLoading: false, isError: false, error: null, refetch: vi.fn() };
  }, webRankingCache: { isCanonicalQuery: () => false },
}));
vi.mock('@/components/ranking/LeaderboardEntityDetailsModal', () => ({ LeaderboardEntityDetailsModal: (props: unknown) => { mocks.details(props); return null; } }));
vi.mock('@/lib/arena/verify-origin', () => ({ verifyArenaContentOrigin: vi.fn(async () => false) }));
import { ArenaRankingModal, projectWebRankingRoster } from '@/components/arena/components/ArenaRankingModal';
import { useBattleStore } from '@/components/arena/stores/useBattleStore';
import { verifyArenaContentOrigin } from '@/lib/arena/verify-origin';

const item = (id: string, entityType: 'data_card' | 'preset' = 'data_card'): PublicRankingItem => ({ rank: 1, entityType, entityId: id, displayName: id, authorName: null, rating: 1300, games: 6, wins: 1, losses: 0, draws: 0, tier: '花牌', techScore: null, techLevel: null, isNative: null, tagIds: [] });
const raw = { templateId: '通用角色', name: '同名角色', content: '完整原件', _cardId: 'original-extension', cloudRef: { cardId: 'not-authority' }, adjudicationEvents: [{ id: 'cloud-event', description: 'cloud-event', type: 'binary', probability: 50 }] };
const row = (id = 'online') => ({ id, name: '同名角色', type: 'character', is_public: 1, review_status: 'approved', updated_at: 'observed-version', data: JSON.stringify(raw) });
const combatant = (extra: Partial<CombatantData> = {}): CombatantData => ({ type: 'general-character', data: raw, filename: '同名角色.json', isPreset: false, isValid: false, ...extra });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
let root: Root, container: HTMLDivElement;
let open: boolean;
const render = async () => { await act(async () => root.render(<ArenaRankingModal isOpen={open} onClose={() => { open = false; void render(); }} />)); };
const selected = () => useBattleStore.getState().combatants;
const rowButton = (id: string) => [...container.querySelectorAll('tbody tr')].find(tr => tr.textContent?.includes(id))?.querySelector<HTMLButtonElement>('td:last-child button');
const click = async (id: string) => { await act(async () => rowButton(id)!.click()); };
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); useBattleStore.setState(useBattleStore.getInitialState(), true);
  vi.mocked(verifyArenaContentOrigin).mockReset().mockResolvedValue(false);
  mocks.userId = null; mocks.items = [item('online')]; mocks.requests = [];
  mocks.read.mockImplementation(async (id: string) => ({ ok: true, status: 200, data: { success: true, card: row(id) } }));
  mocks.report.mockResolvedValue(true); mocks.used.mockReturnValue(false);
  open = true; container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe('Web shared quick ranking adapter', () => {
  it('awaits real admission, retains exact body and source observation, counts usage only after new commit', async () => {
    useBattleStore.setState({ combatants: [combatant({ cardLibrarySelectionId: 'local:other' })] });
    await render(); await click('online');
    expect(selected()).toHaveLength(2);
    expect(selected()[1]).toMatchObject({ cardLibrarySelectionId: 'cloud:online', sourceDataCardId: 'online', sourceDataCardUpdatedAt: 'observed-version', data: raw });
    expect(mocks.report).toHaveBeenCalledExactlyOnceWith('online', 'usage'); expect(mocks.mark).toHaveBeenCalledExactlyOnceWith('online');
    mocks.read.mockRejectedValue(new Error('withdrawn, must not read removal'));
    await click('online');
    expect(selected()).toMatchObject([{ cardLibrarySelectionId: 'local:other' }]);
    expect(useBattleStore.getState().adjudicationEvents).toEqual([]);
    expect(mocks.read).toHaveBeenCalledTimes(1); expect(mocks.report).toHaveBeenCalledTimes(1);
  });

  it('preserves a legacy-event warning from the actual successful host admission', async () => {
    mocks.read.mockResolvedValue({ ok: true, data: { success: true, card: { ...row(), data: JSON.stringify({ ...raw, adjudicationEvents: [{ event: 'legacy event', probability: 50 }] }) } } });
    await render(); await click('online');
    expect(selected()).toHaveLength(1);
    expect(useBattleStore.getState().error).toContain('旧版随机事件');
    expect(mocks.report).toHaveBeenCalledExactlyOnceWith('online', 'usage');
  });

  it.each(['close', 'account', 'unmount'] as const)('drops late public read on %s without granting source or usage', async reason => {
    const pending = deferred<unknown>(); mocks.read.mockReturnValue(pending.promise);
    await render(); await click('online');
    const signal = mocks.read.mock.calls[0]![1] as AbortSignal;
    if (reason === 'close') { open = false; await render(); }
    else if (reason === 'account') { mocks.userId = 2; await render(); }
    else await act(async () => root.render(null));
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve({ ok: true, data: { success: true, card: row() } }));
    expect(selected()).toHaveLength(0); expect(mocks.report).not.toHaveBeenCalled();
  });

  it('drops cancellation during real async validation and does not mark usage', async () => {
    const verification = deferred<boolean>(); vi.mocked(verifyArenaContentOrigin).mockReturnValue(verification.promise);
    await render(); await click('online');
    open = false; await render(); await act(async () => verification.resolve(false));
    expect(selected()).toHaveLength(0); expect(mocks.report).not.toHaveBeenCalled();
  });

  it('does not count a late no-op after another path has selected the same online UI row', async () => {
    const pending = deferred<unknown>(); mocks.read.mockReturnValue(pending.promise);
    await render(); await click('online');
    await act(async () => useBattleStore.setState({ combatants: [combatant({ cardLibrarySelectionId: 'cloud:online', sourceDataCardId: 'online' })] }));
    await act(async () => pending.resolve({ ok: true, data: { success: true, card: row() } }));
    expect(selected()).toHaveLength(1); expect(mocks.report).not.toHaveBeenCalled();
  });

  it.each([{ id: 'wrong' }, { type: 'scenario' }, { is_public: 0 }, { review_status: 'pending' }, { deleted_at: 'now' }, { storageLocation: 'cache' }])('rejects non-current public character facts %j', async patch => {
    mocks.read.mockResolvedValue({ ok: true, data: { success: true, card: { ...row(), ...patch } } });
    await render(); await click('online'); expect(selected()).toHaveLength(0); expect(mocks.report).not.toHaveBeenCalled();
  });

  it.each(['local', 'cache', 'cloud', 'upload'] as const)('selects packaged presets and precisely preserves same-filename %s input on removal', async source => {
    const filename = 'M01_centaurea.json'; mocks.items = [item(filename, 'preset')];
    const data = JSON.parse(readFileSync(resolve(process.cwd(), '../../content/presets', filename), 'utf8'));
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
    useBattleStore.setState({ combatants: [combatant({ filename, ...(source !== 'upload' ? { cardLibrarySelectionId: `${source}:${filename}`, ...(source === 'cloud' ? { sourceDataCardId: filename } : {}) } : {}) })] });
    await render(); await click(filename); expect(selected()).toHaveLength(2);
    expect(selected()[1]).toMatchObject({ filename, isPreset: true });
    await click(filename); expect(selected()).toHaveLength(1); expect(selected()[0]).toMatchObject({ filename, isPreset: false });
    if (source !== 'upload') expect(selected()[0]).toMatchObject({ cardLibrarySelectionId: `${source}:${filename}` });
    expect(mocks.report).not.toHaveBeenCalled();
  });

  it('keeps a same-filename upload, guidance and its events when removing a preset', async () => {
    const filename = 'M01_centaurea.json'; mocks.items = [item(filename, 'preset')];
    const data = JSON.parse(readFileSync(resolve(process.cwd(), '../../content/presets', filename), 'utf8'));
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
    const upload = combatant({ filename, characterGuidance: '上传行动', adjudicationSourceKey: `file:${filename}` });
    const event = { id: 'upload-event', description: '上传事件', type: 'binary' as const, probability: 50, sourceKey: `file:${filename}` };
    useBattleStore.setState({ combatants: [upload], adjudicationEvents: [event] });
    await render(); await click(filename); expect(selected()).toHaveLength(2);
    await click(filename);
    expect(selected()).toEqual([upload]);
    expect(useBattleStore.getState().adjudicationEvents).toEqual([event]);
  });

  it('cleans an explicit preset event source while retaining the same-filename upload source', async () => {
    const filename = 'M01_centaurea.json'; mocks.items = [item(filename, 'preset')];
    const upload = combatant({ filename, characterGuidance: '上传行动', adjudicationSourceKey: `file:${filename}` });
    const uploadEvent = { id: 'upload-event', description: '上传事件', type: 'binary' as const, probability: 50, sourceKey: `file:${filename}` };
    useBattleStore.setState({ combatants: [upload, combatant({ filename, isPreset: true, adjudicationSourceKey: `preset:${filename}` })],
      adjudicationEvents: [uploadEvent, { ...uploadEvent, id: 'preset-event', sourceKey: `preset:${filename}` }] });
    await render(); await click(filename);
    expect(selected()).toEqual([upload]); expect(useBattleStore.getState().adjudicationEvents).toEqual([uploadEvent]);
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.report).not.toHaveBeenCalled();
  });

  it('only grants pivots from host-owned online metadata or packaged presets, never raw or UI keys', () => {
    const inputs = [combatant({ cardLibrarySelectionId: 'cloud:forged' }), combatant({ cardLibrarySelectionId: 'cache:offline' }), combatant({ cardLibrarySelectionId: 'local:x', sourceDataCardId: 'forged' }), combatant({ isPreset: true, filename: 'unpackaged.json' })];
    expect(projectWebRankingRoster(inputs).rankableRosterEntities).toEqual([]);
    expect(projectWebRankingRoster([combatant({ sourceDataCardId: 'actual', cardLibrarySelectionId: 'cache:actual' })])).toEqual({ rankableRosterEntities: [{ entityType: 'data_card', entityId: 'actual' }], selectedEntityKeys: new Set() });
  });

  it('keeps cached revalidation and cloud-row UI identities distinct when removing the quick row', async () => {
    useBattleStore.setState({ combatants: [combatant({ sourceDataCardId: 'online', cardLibrarySelectionId: 'cache:online' })] });
    await render(); await click('online'); expect(selected()).toHaveLength(2);
    await click('online'); expect(selected()).toMatchObject([{ cardLibrarySelectionId: 'cache:online' }]);
  });
});

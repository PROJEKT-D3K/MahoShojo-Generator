import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARENA_ROOM_PRESET_CATALOG } from '@mahoshojo/multiplayer-core/preset-catalog';
import { DesktopCardLibraryRequestSchema, type DesktopCardLibraryRequest } from '@mahoshojo/contracts/desktop-cloud';
import type { CardLibraryHost, CardLibrarySelectionContext } from '@mahoshojo/ui-web/card-library';
import { createDesktopCardLibraryOnlinePort } from '../src/platform/card-library-host';
import {
  createDesktopMemberPublicLibraryHost, desktopMemberPresetHref, desktopMemberSelectionId,
  loadDesktopMemberReferenceDetails, parseDesktopMemberPublicCard, readDesktopMemberPublicCard, readDesktopMemberRandomCharacter,
} from '../src/features/arena/room-member-source-data';

const card = (patch: Record<string, unknown> = {}) => ({ id: 'card-1', type: 'character', name: '公开角色', is_public: 1,
  review_status: 'approved', updated_at: '2026-10-15T00:00:00Z', data: '{"codename":"公开角色"}', ...patch });
const signal = () => new AbortController().signal;
const response = (value: unknown = card()) => ({ status: 200, body: { success: true, card: value } });
afterEach(() => vi.unstubAllGlobals());

describe('Desktop member cloud reference boundary', () => {
  it('trusts only the cloud selection context, never rawSourceData or the battle body', () => {
    expect(desktopMemberSelectionId({ storageLocation: 'cloud', cloudCardId: 'card-1', selectionId: 'cloud:card-1', rawSourceData: { _cardId: 'poison', id: 'poison' } })).toBe('card-1');
    for (const context of [
      { storageLocation: 'local', selectionId: 'local:card-1', cloudCardId: 'card-1' },
      { storageLocation: 'cache', selectionId: 'cache:card-1', cloudCardId: 'card-1' },
      { storageLocation: 'cloud', selectionId: 'local:card-1', cloudCardId: 'card-1' },
      { storageLocation: 'cloud', selectionId: 'cloud:card-1', rawSourceData: { _cardId: 'card-1' } },
    ]) expect(() => desktopMemberSelectionId(context as CardLibrarySelectionContext)).toThrow('当前在线公开');
  });

  it.each([
    { id: 'other' }, { id: ' card-1 ' }, { type: 'scenario' }, { type: 'not-a-card' }, { is_public: 0 }, { is_public: -1 },
    { review_status: 'pending' }, { review_status: undefined }, { deleted_at: 'deleted' }, { updated_at: '' },
    { storageLocation: 'local' }, { storageLocation: 'cache' },
  ])('rejects unreadable or mismatched fresh public rows: %j', patch => {
    expect(() => parseDesktopMemberPublicCard(card(patch), 'character', 'card-1')).toThrow();
  });

  it('keeps material-kind references across all supported online card types', () => {
    for (const type of ['character', 'scenario', 'history', 'questionnaire']) {
      expect(parseDesktopMemberPublicCard(card({ type }), 'material', 'card-1').ref.kind).toBe('material');
    }
  });

  it('uses the actual fixed public bridge and latest observed token, without body upload or CAS', async () => {
    const invoke = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
      expect(DesktopCardLibraryRequestSchema.parse(args?.request)).toEqual({ routeId: 'public-data-cards.query', query: { id: 'card-1' } });
      return response(card({ updated_at: '2026-10-15T01:00:00Z' }));
    });
    const loaded = await readDesktopMemberPublicCard(createDesktopCardLibraryOnlinePort(invoke), 'card-1', 'character', signal());
    expect(loaded.ref).toEqual({ id: 'card-1', kind: 'character', versionToken: '2026-10-15T01:00:00Z' });
    const detail = await loadDesktopMemberReferenceDetails({ source: 'data-card', id: 'card-1', kind: 'character', versionToken: 'old-observation' }, createDesktopCardLibraryOnlinePort(invoke), signal());
    expect(detail.card.name).toBe('公开角色');
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('revalidates a truly random server identity exactly once and never samples a list page', async () => {
    const requests: DesktopCardLibraryRequest[] = [];
    const invoke = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
      const request = DesktopCardLibraryRequestSchema.parse(args?.request); requests.push(request);
      return response(card({ updated_at: request.routeId === 'random-public-card.query' ? 'observed-first' : 'latest' }));
    });
    const loaded = await readDesktopMemberRandomCharacter(invoke, createDesktopCardLibraryOnlinePort(invoke), signal());
    expect(requests).toEqual([{ routeId: 'random-public-card.query', query: { type: 'character' } }, { routeId: 'public-data-cards.query', query: { id: 'card-1' } }]);
    expect(loaded.ref.versionToken).toBe('latest');
  });

  it('does not silently rerandomize when the chosen card was withdrawn during fresh read', async () => {
    const invoke = vi.fn(async (_command: string, args?: Record<string, unknown>) => DesktopCardLibraryRequestSchema.parse(args?.request).routeId === 'random-public-card.query'
      ? response() : { status: 404, body: { success: false } });
    await expect(readDesktopMemberRandomCharacter(invoke, createDesktopCardLibraryOnlinePort(invoke), signal())).rejects.toThrow('已撤回');
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('rejects a random payload with forged type before the public read', async () => {
    const invoke = vi.fn(async () => response(card({ type: 'scenario' })));
    await expect(readDesktopMemberRandomCharacter(invoke, createDesktopCardLibraryOnlinePort(invoke), signal())).rejects.toThrow('类型');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('stops an old-owner random result before starting another public read', async () => {
    let current = true;
    const invoke = vi.fn(async () => { current = false; return response(); });
    await expect(readDesktopMemberRandomCharacter(invoke, createDesktopCardLibraryOnlinePort(invoke), signal(), () => current)).rejects.toThrow('作用域');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('ignores a late public read after abort', async () => {
    let finish!: (value: ReturnType<typeof response>) => void;
    const invoke = vi.fn(() => new Promise<ReturnType<typeof response>>(resolve => { finish = resolve; }));
    const controller = new AbortController();
    const read = readDesktopMemberPublicCard(createDesktopCardLibraryOnlinePort(invoke), 'card-1', 'character', controller.signal);
    controller.abort(); finish(response());
    await expect(read).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('removes real local/cache/private/deck/import capabilities from the public picker host', async () => {
    const unavailable = vi.fn(async () => { throw new Error('device repository must not be used'); });
    const original = { auth: { status: 'authenticated', userId: 7, userBadges: [] }, online: createDesktopCardLibraryOnlinePort(vi.fn()),
      platform: {}, slots: { DecksModal: () => null }, publicCache: {}, local: { repository: { get: unavailable, list: unavailable, put: unavailable } } } as unknown as CardLibraryHost;
    const host = createDesktopMemberPublicLibraryHost(original);
    expect(host.publicCache).toBeUndefined(); expect(host.online.uploadLocalRecord).toBeUndefined(); expect(host.slots).toEqual({});
    await expect(host.local.repository.list({ limit: 10 })).rejects.toThrow('仅支持在线公开');
    await expect(host.online.fetchSummaryPage('my', { limit: 10, offset: 0 }, signal())).rejects.toThrow('仅支持在线公开');
    await expect(host.online.getDeckCards('deck')).rejects.toThrow('仅支持在线公开');
    expect(unavailable).not.toHaveBeenCalled();
  });
});

describe('curated preset details', () => {
  it.each(['C01_egg.json', 'M01_centaurea_legacy.json'])('reads bundled preset %s and checks the exact shared catalog digest', async id => {
    vi.stubGlobal('crypto', webcrypto);
    const entry = ARENA_ROOM_PRESET_CATALOG.find(item => item.kind === 'character' && item.id === id)!;
    const body = readFileSync(resolve(import.meta.dirname, '../../../content/presets', entry.id), 'utf8');
    const fetch = vi.fn(async () => ({ ok: true, text: async () => body })); vi.stubGlobal('fetch', fetch);
    const online = createDesktopCardLibraryOnlinePort(vi.fn());
    const loaded = await loadDesktopMemberReferenceDetails({ source: 'preset', kind: entry.kind, id: entry.id, versionToken: entry.versionToken }, online, signal());
    expect(loaded.card.name).toBe(entry.displayName); expect(loaded.source.kind).toBe('preset');
    expect(fetch).toHaveBeenCalledWith(desktopMemberPresetHref(entry.kind, entry.id), expect.objectContaining({ credentials: 'omit', redirect: 'error' }));
    await expect(loadDesktopMemberReferenceDetails({ source: 'preset', kind: entry.kind, id: entry.id, versionToken: 'wrong-digest' }, online, signal())).rejects.toThrow('版本');
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValue({ ok: true, text: async () => '{"name":"tampered"}' });
    await expect(loadDesktopMemberReferenceDetails({ source: 'preset', kind: entry.kind, id: entry.id }, online, signal())).rejects.toThrow('摘要不一致');
  });
  it('rejects unknown/path-like presets before any fetch', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(() => desktopMemberPresetHref('character', '../private.json')).toThrow('策展目录');
    await expect(loadDesktopMemberReferenceDetails({ source: 'preset', kind: 'material', id: 'private.json' }, createDesktopCardLibraryOnlinePort(vi.fn()), signal())).rejects.toThrow('策展目录');
    expect(fetch).not.toHaveBeenCalled();
  });
});

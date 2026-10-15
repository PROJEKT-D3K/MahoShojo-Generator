import { describe, expect, it, vi } from 'vitest';
import { OwnedRecycleBinDetailResponseSchema, OwnedRecycleBinPageSchema } from '@mahoshojo/contracts/data-cards';
import { DesktopCardLibraryRequestSchema } from '@mahoshojo/contracts/desktop-cloud';
import fixture from '@mahoshojo/contracts/fixtures/desktop-cloud.json';
import { createDesktopRecycleBinPort } from '../src/platform/cloud-recycle';

const page = fixture.cardLibrary.recycleResponses.valid[0].body;
const detail = fixture.cardLibrary.recycleResponses.valid[1].body;
const signal = () => new AbortController().signal;
const query = { limit: 12, offset: 0 };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};

describe('Desktop owned recycle read port', () => {
  it('shares golden request validation with Native, including null body and canonical numbers', () => {
    for (const request of fixture.cardLibrary.recycleRequests.valid) {
      expect(DesktopCardLibraryRequestSchema.safeParse(request).success, JSON.stringify(request)).toBe(true);
    }
    for (const request of fixture.cardLibrary.recycleRequests.invalid) {
      expect(DesktopCardLibraryRequestSchema.safeParse(request).success, JSON.stringify(request)).toBe(false);
    }
  });
  it('reads exactly the fixed summary route with owner and canonical paging, without body or credentials', async () => {
    const invoke = vi.fn().mockResolvedValue({ status: 200, body: page });
    const port = createDesktopRecycleBinPort(invoke, 7, () => true);
    expect(port.isCurrent()).toBe(true);
    expect(await port.readPage({ ...query, type: 'character' }, signal())).toEqual(page);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('cloud_card_library_request', { request: {
      routeId: 'data-cards.recycle.query', expectedUserId: 7, query: { limit: '12', offset: '0', type: 'character' },
    } });
    expect(OwnedRecycleBinPageSchema.parse(page).cards[0]).not.toHaveProperty('data');
  });
  it('reads only a selected tombstone, preserving original data and normalized ID', async () => {
    const invoke = vi.fn().mockResolvedValue({ status: 200, body: detail });
    const card = await createDesktopRecycleBinPort(invoke, 7, () => true).readDetail('\ufeff owned-card \ufeff', signal());
    expect(card).toEqual(OwnedRecycleBinDetailResponseSchema.parse(detail).card);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('cloud_card_library_request', { request: {
      routeId: 'data-cards.recycle-detail.query', expectedUserId: 7, query: { id: 'owned-card' },
    } });
  });
  it('rejects invalid owner, query and ID before dispatch', async () => {
    const invoke = vi.fn();
    for (const owner of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const port = createDesktopRecycleBinPort(invoke, owner, () => true);
      expect(port.isCurrent()).toBe(false);
      await expect(port.readPage(query, signal())).rejects.toThrow();
    }
    const port = createDesktopRecycleBinPort(invoke, 7, () => true);
    for (const value of [{ limit: 25, offset: 0 }, { limit: 12, offset: -1 }, { limit: 1, offset: 0, type: 'unknown' }, { ...query, body: null }]) {
      await expect(port.readPage(value as never, signal())).rejects.toThrow();
    }
    for (const id of ['', ' ', 'x'.repeat(201)]) await expect(port.readDetail(id, signal())).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
  it.each(fixture.cardLibrary.recycleResponses.invalid)('rejects unsafe golden acknowledgement %#', async wire => {
    const invoke = vi.fn().mockResolvedValue({ status: wire.status, body: wire.body });
    const port = createDesktopRecycleBinPort(invoke, 7, () => true);
    const request = wire.request as { routeId: string; query?: Record<string, string> };
    const read = request.routeId === 'data-cards.recycle-detail.query'
      ? port.readDetail('owned-card', signal())
      : port.readPage({ limit: Number(request.query?.limit ?? 12), offset: 0,
        ...(request.query?.type ? { type: request.query.type as 'character' } : {}) }, signal());
    await expect(read).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('accepts only legacy character questionnaires in the questionnaire filter', async () => {
    const parsed = OwnedRecycleBinPageSchema.parse(page);
    const legacy = { ...parsed.cards[0], isLegacyQuestionnaire: true };
    const invoke = vi.fn().mockResolvedValue({ status: 200, body: { ...parsed, cards: [legacy] } });
    const port = createDesktopRecycleBinPort(invoke, 7, () => true);
    expect((await port.readPage({ ...query, type: 'questionnaire' }, signal())).cards[0]).toEqual(legacy);
    await expect(port.readPage({ ...query, type: 'scenario' }, signal())).rejects.toThrow();
    invoke.mockResolvedValue({ status: 200, body: { ...parsed, cards: [{ ...legacy, type: 'questionnaire' }] } });
    await expect(port.readPage(query, signal())).rejects.toThrow();
  });
  it.each([
    { total: 0 }, { filteredCount: 0 }, { filteredCount: 2 }, { nextOffset: 0 },
    { nextOffset: 1 }, { total: 4, filteredCount: 4, nextOffset: 2 },
  ])('rejects inconsistent counts and pagination %j', async patch => {
    const invoke = vi.fn().mockResolvedValue({ status: 200, body: { ...page, ...patch } });
    await expect(createDesktopRecycleBinPort(invoke, 7, () => true).readPage(query, signal())).rejects.toThrow();
  });
  it.each([301, 307, 308, 400, 401, 403, 404, 405, 409, 429, 500, 503])('does not retry or fallback on HTTP %s', async status => {
    const invoke = vi.fn().mockResolvedValue({ status, body: { error: 'private server detail' } });
    const port = createDesktopRecycleBinPort(invoke, 7, () => true);
    await expect(port.readPage(query, signal())).rejects.toThrow();
    await expect(port.readDetail('owned-card', signal())).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls.map(call => call[1].request.routeId)).toEqual(['data-cards.recycle.query', 'data-cards.recycle-detail.query']);
  });
  it('keeps empty success distinct from network failure and hides transport secrets', async () => {
    const invoke = vi.fn().mockRejectedValue({ code: 'network-error', message: 'Cookie: secret' });
    const port = createDesktopRecycleBinPort(invoke, 7, () => true);
    await expect(port.readPage(query, signal())).rejects.toThrow('网络连接失败');
    invoke.mockResolvedValue({ status: 200, body: { ...page, cards: [], total: 0, filteredCount: 0 } });
    expect((await port.readPage(query, signal())).cards).toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it.each(['page', 'detail'])('drops late %s success after account or same-owner epoch change', async route => {
    const pending = deferred<unknown>();
    const invoke = vi.fn(() => pending.promise);
    let current = true;
    const port = createDesktopRecycleBinPort(invoke, 7, () => current);
    const result = route === 'page' ? port.readPage(query, signal()) : port.readDetail('owned-card', signal());
    current = false;
    pending.resolve({ status: 200, body: route === 'page' ? page : detail });
    await expect(result).rejects.toThrow('账号会话已改变');
    expect(port.isCurrent()).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it.each(['page', 'detail'])('settles aborted %s reads immediately and ignores a late IPC response', async route => {
    const pending = deferred<unknown>();
    const invoke = vi.fn(() => pending.promise);
    const port = createDesktopRecycleBinPort(invoke, 7, () => true);
    const controller = new AbortController();
    const result = route === 'page' ? port.readPage(query, controller.signal) : port.readDetail('owned-card', controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    pending.resolve({ status: 200, body: route === 'page' ? page : detail });
    await expect(port.readPage(query, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('enforces UTF-8 data budget while accepting worst-case JSON string escaping', async () => {
    const parsed = OwnedRecycleBinDetailResponseSchema.parse(detail);
    const invoke = vi.fn().mockResolvedValue({ status: 200, body: { ...parsed, card: { ...parsed.card, data: '\u0000'.repeat(1024 * 1024) } } });
    const port = createDesktopRecycleBinPort(invoke, 7, () => true);
    expect((await port.readDetail('owned-card', signal())).data.length).toBe(1024 * 1024);
    for (const data of ['x'.repeat(1024 * 1024 + 1), '字'.repeat(350000)]) {
      invoke.mockResolvedValue({ status: 200, body: { ...parsed, card: { ...parsed.card, data } } });
      await expect(port.readDetail('owned-card', signal())).rejects.toThrow();
    }
  });
});

import { execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { SCENARIOS, SYNTHETIC_CARD, startTavernMock } from '../scripts/desktop-tavern-acceptance-mock.mjs';
import { buildTavernAiAttachment } from '../packages/domain/src/tavern-card/ai';
import { normalizeTavernCard } from '../packages/domain/src/tavern-card/normalize';

const PATH = '/api/tavern/convert-stream';
const HEADER = 'x-mahoshojo-tavern-completion';
const headers = { 'content-type': 'application/json', [HEADER]: 'v1' };
const body = () => {
  const { normalized } = normalizeTavernCard({ keyword: 'json', chunkType: 'tEXt', parseMethod: 'json', parsed: SYNTHETIC_CARD });
  return { template: 'general', language: 'zh-CN', sourceName: normalized.name,
    attachments: [buildTavernAiAttachment(normalized).attachment] };
};
const mocks: Awaited<ReturnType<typeof startTavernMock>>[] = [];
afterEach(async () => { await Promise.all(mocks.splice(0).map(mock => mock.close())); });
async function open(options: { scenario?: string; streamDelayMs?: number; slowDelayMs?: number } = {}) {
  const mock = await startTavernMock({ port: 0, streamDelayMs: 0, slowDelayMs: 0, ...options });
  mocks.push(mock);
  return mock;
}
function raw(origin: string, options: { path?: string; method?: string; headers?: Record<string, string>; chunks?: string[] } = {}) {
  return new Promise<{ status: number; wire: string; headers: Record<string, unknown> }>((resolve, reject) => {
    const request = httpRequest(origin, { path: options.path ?? PATH, method: options.method ?? 'GET', headers: options.headers }, response => {
      let wire = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { wire += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, wire, headers: response.headers }));
      response.on('error', reject);
    });
    request.on('error', reject);
    for (const chunk of options.chunks ?? []) request.write(chunk);
    request.end();
  });
}
async function post(mock: Awaited<ReturnType<typeof open>>, input: unknown = body()) {
  return raw(mock.origin, { method: 'POST', headers, chunks: [JSON.stringify(input)] });
}
function events(wire: string) {
  return wire.trim().split('\n\n').map(frame => {
    const [event, data] = frame.split('\n');
    return { event: event.slice(7), data: JSON.parse(data.slice(6)) };
  });
}
async function closed(mock: Awaited<ReturnType<typeof open>>, index = 0) {
  await expect.poll(() => mock.trace().requests[index]?.responseClosed).toBe(true);
  return mock.trace().requests[index];
}

// A raw HTTP client observes the server trace's ServerResponse close, not merely fetch rejection.
function interruptible(mock: Awaited<ReturnType<typeof open>>) {
  let release: () => void = () => {};
  const firstChunk = new Promise<void>((resolve, reject) => {
    const request = httpRequest(mock.origin + PATH, { method: 'POST', headers }, response => {
      release = () => response.destroy();
      response.once('data', () => resolve());
      response.on('error', () => {});
      response.resume();
    });
    request.on('error', reject);
    request.end(JSON.stringify(body()));
  });
  return { firstChunk, release: () => release() };
}

describe('isolated Tavern acceptance mock', () => {
  it('keeps a request scenario snapshot while its bounded body is arriving', async () => {
    const mock = await open();
    let request: ReturnType<typeof httpRequest>;
    const result = new Promise<string>((resolve, reject) => {
      request = httpRequest(mock.origin + PATH, { method: 'POST', headers }, response => {
        let wire = ''; response.setEncoding('utf8');
        response.on('data', chunk => { wire += chunk; });
        response.on('end', () => resolve(wire)); response.on('error', reject);
      });
      request.on('error', reject); request.flushHeaders();
    });
    await expect.poll(() => mock.trace().requests.length).toBe(1);
    mock.setScenario('length');
    request!.end(JSON.stringify(body()));
    expect(events(await result).at(-1)?.data.tavernCompletion.finishReason).toBe('stop');
    expect((await closed(mock)).scenario).toBe('stop');
  });

  it('pins the public synthetic attachment and stop completion contract', async () => {
    const mock = await open();
    expect(SYNTHETIC_CARD).toEqual({ name: '合成旅人', description: '仅用于本机酒馆流式验收的虚构角色。' });
    const response = await post(mock);
    expect(response.status).toBe(200);
    expect(response.headers[HEADER]).toBe('v1');
    const frames = events(response.wire);
    expect(frames.slice(0, -1).every(frame => frame.event === 'markdown')).toBe(true);
    expect(frames.map(frame => frame.data.chunk ?? '').join('')).toContain('合成旅人是一位温和的虚构角色');
    expect(frames.at(-1)).toEqual({ event: 'done', data: { ok: true, tavernCompletion: { version: 1, finishReason: 'stop' } } });
    expect(await closed(mock)).toMatchObject({ status: 200, eventsSent: 5, responseFinished: true, responseClosedEarly: false });
  });
  it('serves only readiness, anonymous session, announcements and exact capability', async () => {
    const mock = await open();
    for (const [path, value] of [
      ['/api/hosted/dr-readiness', { ok: true, contractVersion: 'g25e1-v1' }],
      ['/api/auth/get-session', { session: null, user: null }], ['/announcements.json', []],
      [PATH, { protocol: 'tavern-completion', version: 1 }],
    ] as const) {
      const response = await raw(mock.origin, { path });
      expect(response.status).toBe(200); expect(JSON.parse(response.wire)).toEqual(value);
    }
    expect((await raw(mock.origin)).headers[HEADER]).toBe('v1');
    for (const path of ['/api/tavern/convert', `${PATH}?token=private`, '/api/arena/generate-stream', '/constructor', '/api/tavern/../convert-stream']) {
      expect((await raw(mock.origin, { path })).status).toBe(404);
    }
    expect((await raw(mock.origin, { method: 'DELETE' })).status).toBe(405);
    expect((await raw(mock.origin, { headers: { 'content-length': '1' }, chunks: ['x'] })).status).toBe(400);
  });
  it.each(['cookie', 'authorization', 'proxy-authorization', 'x-api-key', 'api_key', 'x-auth-token', 'x-mahoshojo-arena-expected-user-id'])(
    'rejects %s without retaining credentials', async header => {
      const mock = await open();
      expect((await raw(mock.origin, { headers: { [header]: 'private-test-marker' } })).status).toBe(403);
      expect(JSON.stringify(mock.trace())).not.toContain('private-test-marker');
    });
  it('requires the exact loopback Host and an optional valid loopback Origin', async () => {
    const mock = await open();
    for (const host of ['localhost:1234', 'example.org', '127.0.0.1:1']) expect((await raw(mock.origin, { headers: { host } })).status).toBe(403);
    for (const origin of ['null', 'https://evil.invalid', 'http://localhost:1234', 'http://127.0.0.1:65536', 'http://127.0.0.1:1234/path']) {
      expect((await raw(mock.origin, { headers: { origin } })).status).toBe(403);
    }
    expect((await raw(mock.origin, { headers: { origin: 'http://127.0.0.1:1420' } })).status).toBe(200);
  });
  it('requires v1, JSON and the closed fixed synthetic body', async () => {
    const mock = await open();
    expect((await raw(mock.origin, { method: 'POST', chunks: [JSON.stringify(body())] })).status).toBe(409);
    expect((await raw(mock.origin, { method: 'POST', headers: { [HEADER]: 'v1' }, chunks: ['{}'] })).status).toBe(415);
    for (const input of [null, [], { ...body(), template: 'scenario' }, { ...body(), language: '' }, { ...body(), language: 'x'.repeat(33) },
      { ...body(), sourceName: 'private-test-marker' }, { ...body(), attachments: [] }, { ...body(), extra: 'private-test-marker' },
      { ...body(), attachments: [{ ...body().attachments[0], content: 'private-test-marker' }] },
      { ...body(), attachments: [{ ...body().attachments[0], size: 5 }] },
      { ...body(), attachments: [{ ...body().attachments[0], extra: 'private-test-marker' }] }]) {
      expect((await post(mock, input)).status).toBe(400);
    }
    expect(JSON.stringify(mock.trace())).not.toContain('private-test-marker');
  });
  it('permits only absent or empty-key default system provider', async () => {
    const mock = await open();
    for (const customProvider of [{ providerId: 'system', apiKey: '' }, { providerId: 'system', apiKey: '', modelId: 'default' }]) {
      expect((await post(mock, { ...body(), customProvider })).status).toBe(200);
    }
    for (const customProvider of [null, {}, { providerId: 'other', apiKey: '' }, { providerId: 'system', apiKey: 'private-test-marker' },
      { providerId: 'system', apiKey: '', modelId: 'arbitrary-model' }, { providerId: 'system', apiKey: '', baseUrl: 'https://example.org' }]) {
      expect((await post(mock, { ...body(), customProvider })).status).toBe(403);
    }
    expect(JSON.stringify(mock.trace())).not.toContain('private-test-marker');
  });
  it('bounds declared and chunked bodies and rejects malformed JSON', async () => {
    const mock = await open();
    for (const extra of [{ 'content-length': '16385' }, {}]) {
      expect((await raw(mock.origin, { method: 'POST', headers: { ...headers, ...extra }, chunks: ['x'.repeat(16385)] })).status).toBe(413);
    }
    expect((await raw(mock.origin, { method: 'POST', headers, chunks: ['{'] })).status).toBe(400);
  });
  it('returns version 2 only for the incompatible probe and refuses its POST', async () => {
    const mock = await open({ scenario: 'probe-mismatch' });
    const probe = await raw(mock.origin);
    expect(probe.headers[HEADER]).toBe('v2');
    expect(JSON.parse(probe.wire)).toEqual({ protocol: 'tavern-completion', version: 2 });
    expect((await post(mock)).status).toBe(409);
    expect(mock.trace().requests.every(entry => entry.eventsSent === 0)).toBe(true);
  });
  it('snapshots each request scenario across stop and probe-mismatch', async () => {
    const mock = await open();
    await post(mock);
    await closed(mock);
    mock.setScenario('probe-mismatch');
    await raw(mock.origin);
    await closed(mock, 1);
    expect(mock.trace().requests.map(({ scenario, method }) => ({ scenario, method }))).toEqual([
      { scenario: 'stop', method: 'POST' },
      { scenario: 'probe-mismatch', method: 'GET' },
    ]);
    expect(mock.trace().requests.filter(entry => entry.scenario === 'probe-mismatch' && entry.method === 'POST')).toHaveLength(0);
  });
  it('returns bounded HTTP 429 retry metadata', async () => {
    const mock = await open({ scenario: 'rate-limit' });
    const response = await post(mock);
    expect(response.status).toBe(429); expect(response.headers['retry-after']).toBe('5');
    expect(JSON.parse(response.wire).retryAfterSeconds).toBe(5);
    expect(await closed(mock)).toMatchObject({ fault: 'rate-limit', eventsSent: 0, responseClosedEarly: false });
  });
  it('distinguishes length completion and EOF without done', async () => {
    const mock = await open({ scenario: 'length' });
    expect(events((await post(mock)).wire).at(-1)?.data.tavernCompletion.finishReason).toBe('length');
    await closed(mock);
    mock.setScenario('eof');
    expect(events((await post(mock)).wire).map(frame => frame.event)).toEqual(['markdown', 'markdown']);
    expect(await closed(mock, 1)).toMatchObject({ fault: 'eof', eventsSent: 2, responseFinished: true, responseClosedEarly: false });
  });
  it('records server-side disconnect through ServerResponse close', async () => {
    const mock = await open({ scenario: 'disconnect' });
    await post(mock).catch(() => undefined);
    expect(await closed(mock)).toMatchObject({ status: 200, fault: 'disconnect', eventsSent: 2, responseFinished: false, responseClosedEarly: true });
  });
  it('records an actual early client close, without claiming Native cancellation', async () => {
    const mock = await open({ scenario: 'slow', slowDelayMs: 20 });
    const stream = interruptible(mock);
    await stream.firstChunk;
    expect(() => mock.setScenario('stop')).toThrow('idle');
    stream.release();
    const entry = await closed(mock);
    expect(entry).toMatchObject({ status: 200, fault: null, responseClosedEarly: true, responseFinished: false });
    const sent = entry.eventsSent;
    expect(sent).toBeGreaterThan(0); expect(sent).toBeLessThan(60);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(mock.trace().requests[0].eventsSent).toBe(sent);
    expect(JSON.stringify(mock.trace())).not.toMatch(/cancel|body|hash|header|requestId/iu);
    mock.setScenario('stop');
    expect(mock.trace().activeStreams).toBe(0);
  });
  it('slow mode is finite and terminates after 60 markdown chunks', async () => {
    const mock = await open({ scenario: 'slow' });
    const frames = events((await post(mock)).wire);
    expect(frames).toHaveLength(61); expect(frames.at(-1)?.event).toBe('done');
    expect(await closed(mock)).toMatchObject({ eventsSent: 61, responseClosedEarly: false });
  });
  it('shutdown closes active responses, drains handlers and is idempotent', async () => {
    const mock = await open({ scenario: 'slow', slowDelayMs: 20 });
    const stream = interruptible(mock);
    await stream.firstChunk;
    const shutdown = mock.close();
    expect(mock.close()).toBe(shutdown);
    await shutdown;
    expect(mock.trace()).toMatchObject({ activeStreams: 0, closed: true });
    expect(mock.trace().requests[0]).toMatchObject({ responseClosed: true, responseClosedEarly: true });
    expect(() => mock.setScenario('stop')).toThrow('idle');
  });
  it('bounds simultaneous streams and releases all on shutdown', async () => {
    const mock = await open({ scenario: 'slow', slowDelayMs: 20 });
    const streams = Array.from({ length: 8 }, () => interruptible(mock));
    await Promise.all(streams.map(stream => stream.firstChunk));
    expect(mock.trace().activeStreams).toBe(8);
    expect((await post(mock)).status).toBe(429);
    await mock.close();
    expect(mock.trace().activeStreams).toBe(0);
    expect(mock.trace().requests.every(entry => entry.responseClosed)).toBe(true);
  });
  it('shutdown also releases an incomplete request body', async () => {
    const mock = await open();
    const request = httpRequest(mock.origin + PATH, { method: 'POST', headers: { ...headers, 'content-length': '1000' } });
    request.on('error', () => {}); request.write('{');
    await expect.poll(() => mock.trace().requests.length).toBe(1);
    await mock.close(); request.destroy();
    expect(mock.trace().requests[0]).toMatchObject({ responseClosed: true, responseClosedEarly: true });
  });
  it('bounds sanitized trace snapshots and never keeps arbitrary routes', async () => {
    const mock = await open();
    for (let index = 0; index < 260; index += 10) await Promise.all(Array.from({ length: 10 }, () => raw(mock.origin, { path: '/private-test-marker?secret=private-test-marker' })));
    const snapshot = mock.trace();
    expect(snapshot.requests).toHaveLength(256); expect(snapshot.droppedTraceEntries).toBe(4);
    expect(snapshot.requests.every(entry => entry.route === 'unknown')).toBe(true);
    snapshot.requests[0].route = 'changed';
    expect(mock.trace().requests[0].route).toBe('unknown');
    expect(JSON.stringify(mock.trace())).not.toContain('private-test-marker');
  });
  it('validates closed scenarios and bounded configuration, including CLI port 0', async () => {
    expect(SCENARIOS).toEqual(['stop', 'slow', 'eof', 'disconnect', 'length', 'rate-limit', 'probe-mismatch']);
    for (const options of [{}, { port: -1 }, { port: 65536 }, { port: 0, scenario: 'other' }, { port: 0, streamDelayMs: -1 }, { port: 0, slowDelayMs: 10001 }]) {
      await expect(startTavernMock(options)).rejects.toThrow();
    }
    const mock = await open();
    expect(() => mock.setScenario('other')).toThrow('Invalid');
    expect(() => execFileSync(process.execPath, ['scripts/desktop-tavern-acceptance-mock.mjs', '--port', '0'], { stdio: 'pipe' })).toThrow();
  });
});

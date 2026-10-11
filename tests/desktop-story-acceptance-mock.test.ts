import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startStoryMocks } from '../scripts/desktop-story-acceptance-mock.mjs';
import { AnnouncementListSchema } from '../packages/contracts/src/announcements';
import { parseArenaReconciliationResponse } from '../packages/contracts/src/arena-reconciliation';
import { ArenaStoryCreateRequestSchema } from '../packages/contracts/src/arena-story';
import { applyArenaReconciliationUpdates } from '../packages/domain/src/arena-reconciliation';

const fixture = JSON.parse(readFileSync(new URL('../packages/contracts/fixtures/desktop-arena-hosted.json', import.meta.url), 'utf8'));
const CREATE = '/api/arena/session/generate-next';
const ROLE = '/api/arena/update-combatants-after-stream';
const ACTOR = 'x-mahoshojo-generation-actor-token';
const STORY = 'x-mahoshojo-arena-story-protocol';
const RECONCILIATION = 'x-mahoshojo-arena-reconciliation-protocol';
const BOOTSTRAP = 'bootstrap.11111111-1111-4111-8111-111111111111';
const otherActor = 'bootstrap.22222222-2222-4222-8222-222222222222';
const combatants = fixture.validOperations[0].body.combatants;
const story = (requestId = 'synthetic_request_0001', chapterIndex = 1) => ArenaStoryCreateRequestSchema.parse({
  version: 1, sessionId: 'synthetic-session', generationRequestId: requestId,
  action: chapterIndex === 1 ? 'start' : 'continue', chapterIndex,
  ...(chapterIndex > 1 ? { sourceChapterId: `synthetic_chapter_${chapterIndex - 1}` } : {}),
  chapterContext: { recentWindow: chapterIndex === 1 ? [] : [{ chapterId: `synthetic_chapter_${chapterIndex - 1}`,
    chapterIndex: chapterIndex - 1, title: '合成上一章', mode: 'full', text: '合成已提交故事正文', truncated: false }], workingCombatants: combatants },
  seed: { combatants, mode: 'daily', storyLength: 'default', language: 'zh-CN',
    settings: { readArenaHistory: false, writeArenaHistory: true, readCurrentState: false,
      writeCurrentState: false, readNarrativeHistory: false, writeNarrativeHistory: false } },
});
const headers = { 'content-type': 'application/json', [ACTOR]: BOOTSTRAP, [STORY]: 'arena-story-v1' };
const stops: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(stops.splice(0).map((stop) => stop())); });

async function open(options: { streamDelayMs?: number; maxBodyBytes?: number } = {}) {
  const mocks = await startStoryMocks({ honoPort: 0, nextPort: 0, streamDelayMs: 0, ...options });
  stops.push(mocks.close);
  return mocks;
}

async function create(mocks: Awaited<ReturnType<typeof open>>, input = story()) {
  const body = JSON.stringify(input);
  const response = await fetch(mocks.honoOrigin + CREATE, { method: 'POST', headers, body });
  const wire = await response.text();
  return { response, wire, body, id: response.headers.get('x-mahoshojo-generation-id')!,
    token: response.headers.get(ACTOR)! };
}

function raw(origin: string, path: string, options: { method?: string; headers?: Record<string, string>; chunks?: string[] } = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(origin + path, { method: options.method ?? 'GET', headers: options.headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, body }));
      response.on('error', reject);
    });
    request.on('error', reject);
    for (const chunk of options.chunks ?? []) request.write(chunk);
    request.end();
  });
}

async function listen(server: Server, port = 0) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return (server.address() as AddressInfo).port;
}
const closeServer = (server: Server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });

describe('isolated W01 story mock HTTP contracts', () => {
  it('serves fixture capability, anonymous startup and empty valid announcements on their fixed service', async () => {
    const mocks = await open();
    expect(mocks.honoOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(mocks.nextOrigin).not.toBe(mocks.honoOrigin);
    const readiness = await fetch(mocks.honoOrigin + '/api/hosted/dr-readiness');
    expect(readiness.headers.get(STORY)).toBe('arena-story-v1');
    expect(await readiness.json()).toEqual(fixture.capability);
    const cloudReadiness = await fetch(mocks.nextOrigin + '/api/hosted/dr-readiness');
    expect(await cloudReadiness.json()).toEqual({ ok: true, contractVersion: fixture.capability.contractVersion });
    expect(cloudReadiness.headers.has(STORY)).toBe(false);
    expect(await (await fetch(mocks.nextOrigin + '/api/auth/get-session')).json()).toEqual({ session: null, user: null });
    const announcements = await (await fetch(mocks.nextOrigin + '/announcements.json')).json();
    expect(AnnouncementListSchema.parse(announcements)).toEqual([]);
    expect(await (await fetch(mocks.nextOrigin + ROLE)).json()).toEqual({ ok: true,
      contractVersion: 'arena-reconciliation-v1', expectedUserIdAssertion: 'v1', ownership: 'generation-actor', effects: 'frozen-manifest-v1' });
    expect((await fetch(mocks.honoOrigin + ROLE)).status).toBe(404);
    expect((await fetch(mocks.nextOrigin + CREATE, { method: 'POST' })).status).toBe(404);
  });

  it('creates start/continue, echoes identities, serves original lookup/status/replay and reconciles roles', async () => {
    const mocks = await open();
    const first = await create(mocks);
    expect(first.response.status).toBe(200);
    expect(first.response.headers.get('content-type')).toBe('text/event-stream');
    expect(first.response.headers.get(STORY)).toBe('arena-story-v1');
    expect(first.response.headers.get('x-mahoshojo-generation-request-id')).toBe(story().generationRequestId);
    expect(first.response.headers.get('x-mahoshojo-generation-payload-hash')).toBe(createHash('sha256').update(first.body).digest('hex'));
    expect(first.id).toMatch(/^arena_[a-f0-9]{64}$/u);
    const token = JSON.parse(Buffer.from(first.token, 'base64url').toString());
    expect(token.anonymousId).toBe(BOOTSTRAP.slice('bootstrap.'.length));
    expect(token.signature).toContain('SYNTHETIC');
    expect(Date.parse(token.expiresAt)).toBeGreaterThan(Date.now());
    expect(first.wire).toContain('合成第1章');
    const events = first.wire.trim().split('\n\n').map((event) => ({
      id: event.split('\n')[0].slice(4), event: event.split('\n')[1].slice(7), data: JSON.parse(event.split('\n')[2].slice(6)),
    }));
    expect(events.map((event) => event.event)).toEqual(['markdown', 'reasoning', 'reasoning_done', 'telemetry', 'done']);
    expect(events.at(-1)?.data).toEqual(fixture.validSseEvents.find((event: { event: string }) => event.event === 'done').data);
    for (const path of [`/api/arena/generation-requests/${story().generationRequestId}`, `/api/arena/generations/${first.id}`]) {
      const response = await fetch(mocks.honoOrigin + path, { headers: { [ACTOR]: first.token } });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ generationId: first.id, generationRequestId: story().generationRequestId,
        status: 'completed', resumable: false, lastEventId: '5-0' });
    }
    const recovered = await fetch(mocks.honoOrigin + `/api/arena/generation-requests/${story().generationRequestId}`, { headers: { [ACTOR]: BOOTSTRAP } });
    expect(recovered.headers.get(ACTOR)).toBe(first.token);
    await recovered.text();
    const replay = await fetch(mocks.honoOrigin + `/api/arena/generations/${first.id}/stream?after=2-0`, { headers: { [ACTOR]: first.token } });
    expect(await replay.text()).toBe(first.wire.slice(first.wire.indexOf('id: 3-0')));
    const role = await fetch(mocks.nextOrigin + ROLE, { method: 'POST', headers: { 'content-type': 'application/json',
      [ACTOR]: first.token, [RECONCILIATION]: 'arena-reconciliation-v1' }, body: JSON.stringify({ generationId: first.id, combatants }) });
    expect(role.status).toBe(200);
    expect(role.headers.get(RECONCILIATION)).toBe('arena-reconciliation-v1');
    expect(await role.json()).toMatchObject({ version: 'arena-reconciliation-v1', generationId: first.id, success: true,
      updatedCombatants: [{ combatantIndex: 0, data: { name: 'Synthetic' }, isNative: false }], warnings: [] });
    const second = await create(mocks, story('synthetic_request_0002', 2));
    expect(second.wire).toContain('合成第2章');
    expect(second.id).not.toBe(first.id);
    const duplicate = await create(mocks);
    expect(duplicate.response.status).toBe(409);
    expect(mocks.trace().generationCount).toBe(2);
    expect(mocks.trace().counts[`hono POST ${CREATE}`]).toBe(3);
  });

  it('projects frozen role matching hints exactly and rejects altered rosters/actors', async () => {
    const mocks = await open();
    const input = story();
    input.chapterContext.workingCombatants = [{ ...combatants[0], filename: ' fixture.json ', sourceDataCardId: ' source-id ',
      dataCardId: 'ignored-id', arenaRoomKey: ' room-key ', characterGuidance: 'not-a-role-field' }];
    const created = await create(mocks, input);
    const projected = [{ ...combatants[0], filename: 'fixture.json', sourceDataCardId: 'source-id', roomCombatantKey: 'room-key' }];
    const reconcile = (actor: string, roster: unknown) => fetch(mocks.nextOrigin + ROLE, { method: 'POST', headers: {
      'content-type': 'application/json', [ACTOR]: actor, [RECONCILIATION]: 'arena-reconciliation-v1',
    }, body: JSON.stringify({ generationId: created.id, combatants: roster }) });
    expect((await reconcile(BOOTSTRAP, projected)).status).toBe(403);
    expect((await reconcile(created.token, combatants)).status).toBe(409);
    expect((await reconcile(created.token, projected)).status).toBe(200);
    expect((await fetch(mocks.honoOrigin + `/api/arena/generations/${created.id}`, { headers: { [ACTOR]: otherActor } })).status).toBe(403);
    expect((await fetch(mocks.honoOrigin + `/api/arena/generations/${created.id}/stream?after=99-0`, { headers: { [ACTOR]: created.token } })).status).toBe(400);
  });

  it('passes the real reconciliation parser without granting native authority or retaining an old signature', async () => {
    const mocks = await open();
    const input = story();
    const roster = [{ ...combatants[0], isValid: true, data: { ...combatants[0].data, signature: 'inherited-signature-canary' } }];
    input.chapterContext.workingCombatants = roster;
    const created = await create(mocks, input);
    const response = await fetch(mocks.nextOrigin + ROLE, { method: 'POST', headers: {
      'content-type': 'application/json', [ACTOR]: created.token, [RECONCILIATION]: 'arena-reconciliation-v1',
    }, body: JSON.stringify({ generationId: created.id, combatants: roster.map(({ type, data }) => ({ type, data })) }) });
    expect(response.status).toBe(200);
    const parsed = parseArenaReconciliationResponse(await response.text(), created.id, roster.length);
    expect('success' in parsed && parsed.success).toBe(true);
    if (!('success' in parsed)) throw new Error('Expected a synthetic reconciliation success');
    expect(parsed.updatedCombatants[0].isNative).toBe(false);
    expect(parsed.updatedCombatants[0].data).not.toHaveProperty('signature');
    const projected = applyArenaReconciliationUpdates(roster, parsed.updatedCombatants);
    expect(projected.combatants[0].isValid).toBe(false);
    expect(projected.combatants[0].data).not.toHaveProperty('signature');
    expect(projected.combatants[0].data).toMatchObject({ name: 'Synthetic', content: '合成验收角色更新' });
    expect(roster[0].data.signature).toBe('inherited-signature-canary');
  });

  it('keeps headers responsive while the bounded synthetic stream remains in progress', async () => {
    const mocks = await open({ streamDelayMs: 80 });
    const response = await fetch(mocks.honoOrigin + CREATE, { method: 'POST', headers, body: JSON.stringify(story()) });
    const id = response.headers.get('x-mahoshojo-generation-id');
    const status = await fetch(mocks.honoOrigin + `/api/arena/generations/${id}`, { headers: { [ACTOR]: response.headers.get(ACTOR)! } });
    expect(await status.json()).toMatchObject({ status: 'running', resumable: true });
    expect(await response.text()).toContain('event: done');
  });

  it('accepts schema-valid safe-integer chapters without an invented chapter ceiling', async () => {
    const mocks = await open();
    const input = story('synthetic_safe_integer', Number.MAX_SAFE_INTEGER);
    expect(ArenaStoryCreateRequestSchema.parse(input).chapterIndex).toBe(Number.MAX_SAFE_INTEGER);
    const created = await create(mocks, input);
    expect(created.response.status).toBe(200);
    expect(created.wire).toContain(`合成第${Number.MAX_SAFE_INTEGER}章`);
  });
});

describe('isolated W01 mock failure and privacy boundaries', () => {
  it('rejects external Host/Origin, ambient credentials, unknown paths/methods and unsupported funding', async () => {
    const mocks = await open();
    const rejectedHeaders: Record<string, string>[] = [ { host: 'evil.example' }, { origin: 'https://evil.example' }, { origin: 'null' },
      { origin: 'http://127.0.0.1:99999' }, { cookie: 'secret-cookie-canary' }, { authorization: 'Bearer secret-token-canary' },
      { 'x-api-key': 'secret-key-canary' }, { 'x-mahoshojo-arena-expected-user-id': 'v1:42' }];
    for (const extra of rejectedHeaders) {
      expect((await raw(mocks.honoOrigin, '/api/hosted/dr-readiness', { headers: extra })).status).toBe(403);
    }
    expect((await raw(mocks.honoOrigin, '/api/hosted/dr-readiness', { headers: { origin: 'http://127.0.0.1:31337' } })).status).toBe(200);
    expect((await raw(mocks.honoOrigin, '/unknown/secret-path-canary?apiKey=secret-query-canary')).status).toBe(404);
    expect((await raw(mocks.honoOrigin, '/api/hosted/dr-readiness', { method: 'POST' })).status).toBe(405);
    expect((await raw(mocks.honoOrigin, '/api/hosted/dr-readiness?url=https://evil.example')).status).toBe(404);
    expect((await raw(mocks.honoOrigin, '/api/hosted/dr-readiness', { headers: { 'content-length': '2' }, chunks: ['{}'] })).status).toBe(400);
    const input = { ...story(), customProvider: { providerId: 'custom', apiKey: 'secret-body-canary' } };
    const rejected = await fetch(mocks.honoOrigin + CREATE, { method: 'POST', headers, body: JSON.stringify(input) });
    expect(rejected.status).toBe(403);
    const serialized = JSON.stringify(mocks.trace());
    for (const secret of ['secret-cookie-canary', 'secret-token-canary', 'secret-key-canary', 'secret-path-canary', 'secret-query-canary', 'secret-body-canary']) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain(BOOTSTRAP);
    expect(mocks.trace().generationCount).toBe(0);
  });

  it('rejects invalid JSON, protocol/body errors and bounds chunked as well as declared bodies', async () => {
    const mocks = await open({ maxBodyBytes: 1024 });
    expect((await raw(mocks.honoOrigin, CREATE, { method: 'POST', headers, chunks: ['{not-json'] })).status).toBe(400);
    expect((await raw(mocks.honoOrigin, CREATE, { method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, chunks: ['{}'] })).status).toBe(415);
    expect((await raw(mocks.honoOrigin, CREATE, { method: 'POST', headers: { ...headers, [STORY]: 'unknown-version' }, chunks: ['{}'] })).status).toBe(409);
    expect((await raw(mocks.honoOrigin, CREATE, { method: 'POST', headers: { ...headers, 'content-length': '1025' }, chunks: ['x'.repeat(1025)] })).status).toBe(413);
    expect((await raw(mocks.honoOrigin, CREATE, { method: 'POST', headers, chunks: ['x'.repeat(700), 'x'.repeat(700)] })).status).toBe(413);
    expect((await raw(mocks.honoOrigin, CREATE, { method: 'POST', headers, chunks: [JSON.stringify({ ...story(), action: 'branch' })] })).status).toBe(400);
    expect(mocks.trace().requests.filter((entry: { status: number }) => entry.status === 413)).toHaveLength(2);
  });

  it('rejects the real schema\'s invalid start/continue linear contexts before any generation', async () => {
    const mocks = await open();
    const continuation = story('synthetic_continuation', 2);
    const previous = continuation.chapterContext.recentWindow[0];
    const invalid = [
      { ...story(), sourceChapterId: previous.chapterId },
      { ...story(), chapterContext: continuation.chapterContext },
      { ...continuation, sourceChapterId: undefined },
      { ...continuation, sourceChapterId: 'wrong_previous_chapter' },
      { ...continuation, chapterContext: { ...continuation.chapterContext, recentWindow: [] } },
      { ...continuation, chapterIndex: 3 },
      { ...continuation, chapterIndex: Number.MAX_SAFE_INTEGER + 1 },
      { ...continuation, chapterPlan: { totalChapters: 1 } },
      { ...continuation, chapterContext: { ...continuation.chapterContext, recentWindow: [previous, previous] } },
      { ...continuation, chapterContext: { ...continuation.chapterContext, recentWindow: [
        { ...previous, chapterId: 'out_of_order', chapterIndex: 2 }, previous,
      ] } },
    ];
    for (const input of invalid) {
      expect(ArenaStoryCreateRequestSchema.safeParse(input).success).toBe(false);
      const response = await fetch(mocks.honoOrigin + CREATE, { method: 'POST', headers, body: JSON.stringify(input) });
      expect(response.status).toBe(400);
      await response.text();
    }
    expect(mocks.trace().generationCount).toBe(0);
  });

  it('never exposes body/header/requestId secrets in trace snapshots and keeps them immutable', async () => {
    const mocks = await open();
    const input = { ...story('request_identity_canary'), userGuidance: 'payload-text-canary' };
    const created = await create(mocks, input);
    const lookup = await fetch(mocks.honoOrigin + '/api/arena/generation-requests/request_identity_canary', { headers: { [ACTOR]: created.token } });
    await lookup.text();
    const snapshot = mocks.trace();
    expect(snapshot.requests[0]).toMatchObject({ service: 'hono', method: 'POST', path: CREATE, status: 200,
      generationId: created.id, chapterIndex: 1, action: 'start', bodySha256: createHash('sha256').update(created.body).digest('hex') });
    for (const value of ['request_identity_canary', 'payload-text-canary', BOOTSTRAP, created.token, 'Synthetic']) {
      expect(JSON.stringify(snapshot)).not.toContain(value);
    }
    snapshot.requests[0].path = 'mutated';
    expect(mocks.trace().requests[0].path).toBe(CREATE);
    await mocks.close();
    await mocks.close();
    expect(mocks.trace().generationCount).toBe(1);
    await expect(fetch(mocks.honoOrigin + '/api/hosted/dr-readiness')).rejects.toThrow();
  });

  it('cleans the first listener if the second port is occupied', async () => {
    const occupied = createServer();
    const occupiedPort = await listen(occupied);
    stops.push(() => closeServer(occupied));
    const reservation = createServer();
    const firstPort = await listen(reservation);
    await closeServer(reservation);
    await expect(startStoryMocks({ honoPort: firstPort, nextPort: occupiedPort })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    const probe = createServer();
    expect(await listen(probe, firstPort)).toBe(firstPort);
    await closeServer(probe);
  });

  it('closes in-flight streams without leaving a delay timer or occupied ports', async () => {
    const mocks = await open({ streamDelayMs: 10_000 });
    const response = await fetch(mocks.honoOrigin + CREATE, { method: 'POST', headers, body: JSON.stringify(story()) });
    expect(response.status).toBe(200);
    const began = Date.now();
    await mocks.close();
    expect(Date.now() - began).toBeLessThan(1000);
    await expect(response.text()).rejects.toThrow();
    expect(mocks.trace().requests[0].responseAborted).toBe(true);
    const probe = createServer();
    expect(await listen(probe, Number(new URL(mocks.honoOrigin).port))).toBe(Number(new URL(mocks.honoOrigin).port));
    await closeServer(probe);
  });

  it('validates explicit module options and disallows zero/duplicate/missing CLI ports without binding', async () => {
    await expect(startStoryMocks()).rejects.toThrow('Explicit loopback ports');
    await expect(startStoryMocks({ honoPort: 32101, nextPort: 32101 })).rejects.toThrow('must differ');
    await expect(startStoryMocks({ honoPort: 0, nextPort: 0, maxBodyBytes: fixture.limits.requestBodyBytes + 1 })).rejects.toThrow('body limit');
    const script = fileURLToPath(new URL('../scripts/desktop-story-acceptance-mock.mjs', import.meta.url));
    for (const args of [[], ['--hono-port', '0', '--next-port', '32102'], ['--hono-port', '32102', '--next-port', '32102'],
      ['--hono-port', '32102', '--next-port', '32103', '--unknown', '1']]) {
      expect(() => execFileSync(process.execPath, [script, ...args], { cwd: tmpdir(), stdio: 'pipe', timeout: 3000 })).toThrow();
    }
  });
});

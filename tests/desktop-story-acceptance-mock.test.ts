import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startStoryMocks, validateStoryMockFaults } from '../scripts/desktop-story-acceptance-mock.mjs';
import { AnnouncementListSchema } from '../packages/contracts/src/announcements';
import { parseArenaReconciliationResponse } from '../packages/contracts/src/arena-reconciliation';
import { ArenaStoryCreateRequestSchema } from '../packages/contracts/src/arena-story';
import { openArenaGenerationStreamClient, type ArenaGenerationConnectionState, type PersistedArenaGeneration } from '../packages/hosted-api/src/arena-generation/client';
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

async function open(options: { streamDelayMs?: number; maxBodyBytes?: number; faults?: Record<string, unknown> } = {}) {
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
    // Fetch rejection and server.close() can precede ServerResponse's close event.
    // Wait for that actual server-side cancellation signal, never a guessed delay.
    await expect.poll(() => mocks.trace().requests[0].responseAborted, { timeout: 1000 }).toBe(true);
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


// Real HTTP plus the shared recovery core, not Native IPC or Windows acceptance.
async function recoveringClient(mocks: Awaited<ReturnType<typeof open>>) {
  const states: ArenaGenerationConnectionState[] = [], saved: PersistedArenaGeneration[] = [];
  const response = await openArenaGenerationStreamClient({ endpoint: CREATE, bodyHash: 'synthetic-body',
    onStateChange: state => { states.push(state); } }, {
    loadState: () => null, saveState: state => { saved.push(state); }, createRequestId: () => story().generationRequestId,
    encodeUtf8: value => new TextEncoder().encode(value), waitForReconnectOpportunity: async () => undefined,
    isInitialCreateOutcomeAmbiguous: error => error instanceof TypeError, classifyExplicitAbort: () => null,
    prepareCreate: () => undefined, observeResponse: () => undefined,
    transport: {
      create: ({ signal, onRoutePinSelected }) => {
        onRoutePinSelected({ placement: 'hono-primary' });
        return fetch(mocks.honoOrigin + CREATE, { method: 'POST', headers, body: JSON.stringify(story()), signal });
      },
      lookup: ({ generationRequestId, signal }) => fetch(mocks.honoOrigin + `/api/arena/generation-requests/${generationRequestId}`, { headers: { [ACTOR]: BOOTSTRAP }, signal }),
      resume: ({ generationId, lastEventId, signal }) => fetch(mocks.honoOrigin + `/api/arena/generations/${generationId}/stream${lastEventId ? `?after=${lastEventId}` : ''}`, { headers: { [ACTOR]: BOOTSTRAP }, signal }),
      cancel: async () => { throw new Error('Unexpected cancel in recovery-only probe'); },
    },
  });
  return { wire: await response.text(), states, saved };
}
const parsedEvents = (wire: string) => wire.trim().split('\n\n').filter(Boolean).map(block => ({
  id: block.split('\n')[0].slice(4), event: block.split('\n')[1].slice(7), data: JSON.parse(block.split('\n')[2].slice(6)),
}));

describe('explicit synthetic HTTP fault controls', () => {
  it('rejects unknown, unsafe, malformed or inert-cutoff fault settings before binding', async () => {
    for (const faults of [null, [], { version: 2 }, { apiKey: 'never-log-this' }, { streamDelayMs: 10_001 },
      { markdownChunks: 0 }, { wireChunkBytes: 4097 }, { createDelayMs: -1 }, { lookupHideFirst: 101 },
      { statusDelayMs: 1.5 }, { createDisconnectBeforeHeaders: 'true' },
      { streamFault: { kind: 'unknown', attempts: 1, afterEvents: 1 } },
      { streamFault: { kind: 'eof', attempts: 1, afterEvents: 5 } },
      { streamFault: { kind: 'eof', attempts: 0, afterEvents: 1 } },
      { roleFault: { kind: 'disconnect', attempts: 1, response: 'secret-canary' } },
    ]) {
      // Deliberately cross the typed boundary with malformed external JSON.
      const invalid = faults as Record<string, unknown>;
      expect(() => validateStoryMockFaults(invalid)).toThrow('Invalid synthetic fault');
      await expect(startStoryMocks({ honoPort: 0, nextPort: 0, faults: invalid })).rejects.toThrow('Invalid synthetic fault');
    }
  });

  it('splits markdown events and multibyte wire chunks without changing the full text', async () => {
    const baseline = await create(await open());
    const mocks = await open({ faults: { markdownChunks: 4, wireChunkBytes: 7 } });
    const split = await create(mocks);
    const events = parsedEvents(split.wire);
    expect(events.filter(event => event.event === 'markdown')).toHaveLength(4);
    expect(events.filter(event => event.event === 'markdown').map(event => event.data.chunk).join(''))
      .toBe(parsedEvents(baseline.wire)[0].data.chunk);
    expect(events.at(-1)?.data.status).toBe('completed');
    expect(mocks.trace().requests[0].faults).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'wire-chunks' })]));
    const snapshot = mocks.trace(); snapshot.faultConfig.markdownChunks = 99;
    expect(mocks.trace().faultConfig.markdownChunks).toBe(4);
  });

  it.each(['eof', 'disconnect'])('recovers a one-shot %s through the original cursor with no second create', async (kind) => {
    const mocks = await open({ faults: { streamFault: { kind, afterEvents: 2, attempts: 1 } } });
    const result = await recoveringClient(mocks);
    expect(result.states.at(-1)).toBe('completed');
    expect(parsedEvents(result.wire).map(event => event.id)).toEqual(['1-0', '2-0', '3-0', '4-0', '5-0']);
    expect(mocks.trace().generationCount).toBe(1);
    expect(mocks.trace().counts[`hono POST ${CREATE}`]).toBe(1);
    expect(mocks.trace().counts['hono GET /api/arena/generations/:generationId/stream']).toBe(1);
    expect(mocks.trace().requests[0].faults).toEqual(expect.arrayContaining([expect.objectContaining({ name: `stream-${kind}` })]));
  });

  it.each(['eof', 'disconnect'])('keeps a persistent %s at the same boundary until the shared retry budget is exhausted', async (kind) => {
    const mocks = await open({ faults: { streamFault: { kind, afterEvents: 2, attempts: 100 } } });
    const result = await recoveringClient(mocks);
    expect(result.states.at(-1)).toBe('interrupted');
    expect(parsedEvents(result.wire).map(event => event.id)).toEqual(['1-0', '2-0']);
    expect(result.wire).not.toContain('event: done');
    expect(mocks.trace().counts[`hono POST ${CREATE}`]).toBe(1);
    expect(mocks.trace().counts['hono GET /api/arena/generations/:generationId/stream']).toBe(8);
    const role = await fetch(mocks.nextOrigin + ROLE, { method: 'POST', headers: { ...headers, [ACTOR]:
      (await fetch(mocks.honoOrigin + `/api/arena/generation-requests/${story().generationRequestId}`, { headers })).headers.get(ACTOR)!,
      [RECONCILIATION]: 'arena-reconciliation-v1' }, body: JSON.stringify({ generationId: result.saved.at(-1)?.generationId, combatants }) });
    expect(role.status).toBe(409);
  });

  it('recovers lost create headers through hidden then delayed lookup while new-create capability is withdrawn', async () => {
    const mocks = await open({ faults: { createDisconnectBeforeHeaders: true, lookupHideFirst: 1,
      lookupDelayMs: 20, withdrawStoryAfterCreate: true } });
    const before = await fetch(mocks.honoOrigin + '/api/hosted/dr-readiness');
    expect(before.headers.get(STORY)).toBe('arena-story-v1'); await before.text();
    const result = await recoveringClient(mocks);
    expect(result.states.at(-1)).toBe('completed');
    expect(mocks.trace().generationCount).toBe(1);
    expect(mocks.trace().counts[`hono POST ${CREATE}`]).toBe(1);
    const lookups = mocks.trace().requests.filter((entry: { path: string }) => entry.path.includes('generation-requests'));
    expect(lookups.map((entry: { status: number }) => entry.status)).toEqual([404, 200]);
    expect(lookups[0].faults.map((fault: { name: string }) => fault.name)).toEqual(['lookup-delay', 'lookup-hidden']);
    const after = await fetch(mocks.honoOrigin + '/api/hosted/dr-readiness');
    expect(after.headers.has(STORY)).toBe(false);
    expect(await after.json()).toEqual(fixture.capability);
    const trace = JSON.stringify(mocks.trace());
    expect(trace).not.toContain(BOOTSTRAP);
    expect(trace).not.toContain(story().generationRequestId);
  });

  it('hides only authenticated status reads, then returns the original completed generation', async () => {
    const mocks = await open({ faults: { statusHideFirst: 1, statusDelayMs: 20 } });
    const created = await create(mocks);
    const url = mocks.honoOrigin + `/api/arena/generations/${created.id}`;
    expect((await fetch(url, { headers: { [ACTOR]: otherActor } })).status).toBe(403);
    expect((await fetch(url, { headers: { [ACTOR]: created.token } })).status).toBe(404);
    const response = await fetch(url, { headers: { [ACTOR]: created.token } });
    expect(await response.json()).toMatchObject({ generationId: created.id, status: 'completed' });
    expect(mocks.trace().generationCount).toBe(1);
  });

  it.each(['disconnect', 'malformed', 'http-error'])('injects a bounded role %s and lets an explicit same-generation retry succeed', async (kind) => {
    const mocks = await open({ faults: { roleDelayMs: 20, roleFault: { kind, attempts: 1 } } });
    const created = await create(mocks);
    const role = () => fetch(mocks.nextOrigin + ROLE, { method: 'POST', headers: { 'content-type': 'application/json',
      [ACTOR]: created.token, [RECONCILIATION]: 'arena-reconciliation-v1' }, body: JSON.stringify({ generationId: created.id, combatants }) });
    if (kind === 'disconnect') await expect(role()).rejects.toThrow();
    else {
      const first = await role();
      expect(first.status).toBe(kind === 'malformed' ? 200 : 503);
      const wire = await first.text();
      if (kind === 'malformed') expect(() => parseArenaReconciliationResponse(wire, created.id, combatants.length)).toThrow();
      else expect(parseArenaReconciliationResponse(wire, created.id, combatants.length)).toMatchObject({ generationId: created.id, code: 'ARENA_RECONCILIATION_UNAVAILABLE' });
    }
    const second = await role();
    expect(parseArenaReconciliationResponse(await second.text(), created.id, combatants.length)).toMatchObject({ success: true });
    expect(mocks.trace().counts[`next POST ${ROLE}`]).toBe(2);
    expect(mocks.trace().counts[`hono POST ${CREATE}`]).toBe(1);
    expect(mocks.trace().requests.find((entry: { path: string }) => entry.path === ROLE).faults)
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: `role-${kind}` })]));
    expect(JSON.stringify(mocks.trace())).not.toContain(created.token);
  });

  it('accepts stop once during a slow stream and replays a single cancelled terminal, never completed', async () => {
    const mocks = await open({ streamDelayMs: 50, faults: { markdownChunks: 4, wireChunkBytes: 3 } });
    const response = await fetch(mocks.honoOrigin + CREATE, { method: 'POST', headers, body: JSON.stringify(story()) });
    const id = response.headers.get('x-mahoshojo-generation-id')!, token = response.headers.get(ACTOR)!;
    const wirePromise = response.text();
    await expect.poll(() => mocks.trace().requests[0].eventsSent).toBeGreaterThanOrEqual(1);
    const stop = (reason: string) => fetch(mocks.honoOrigin + `/api/arena/generations/${id}/cancel`, {
      method: 'POST', headers: { 'content-type': 'application/json', [ACTOR]: token }, body: JSON.stringify({ reason }) });
    const accepted = await stop('user');
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ generationId: id, status: 'cancelling', cancelled: true });
    const duplicate = await stop('content_policy');
    expect(duplicate.status).toBe(200); expect(await duplicate.json()).toMatchObject({ status: 'cancelled' });
    const wire = await wirePromise;
    const terminals = parsedEvents(wire).filter(event => event.event === 'done');
    expect(terminals).toHaveLength(1);
    expect(terminals[0].data).toEqual({ ok: false, status: 'cancelled', code: 'USER_CANCELLED' });
    expect(wire).not.toContain('"completed"');
    const replay = await fetch(mocks.honoOrigin + `/api/arena/generations/${id}/stream`, { headers: { [ACTOR]: token } });
    expect(await replay.text()).toBe(wire);
    expect(mocks.trace().generationCount).toBe(1);
    expect(mocks.trace().requests.filter((entry: { cancelAccepted?: boolean }) => entry.cancelAccepted)).toHaveLength(1);
  });

  it('stops only the selected request while another generation under the same actor completes', async () => {
    const mocks = await open({ streamDelayMs: 25 });
    const first = await fetch(mocks.honoOrigin + CREATE, { method: 'POST', headers, body: JSON.stringify(story('request_product_battle')) });
    const second = await fetch(mocks.honoOrigin + CREATE, { method: 'POST', headers, body: JSON.stringify({ ...story('request_product_arena'), sessionId: 'other-session' }) });
    const firstWire = first.text(), secondWire = second.text();
    const stopped = await fetch(mocks.honoOrigin + '/api/arena/generate-stream', { method: 'DELETE', headers,
      body: JSON.stringify({ generationRequestId: 'request_product_battle', reason: 'user' }) });
    expect(stopped.status).toBe(202);
    expect(await stopped.json()).toMatchObject({ generationId: first.headers.get('x-mahoshojo-generation-id') });
    expect(await firstWire).toContain('"status":"cancelled"');
    expect(await secondWire).toContain('"status":"completed"');
    expect(mocks.trace().generationCount).toBe(2);
    expect(mocks.trace().requests.filter((entry: { cancelAccepted?: boolean }) => entry.cancelAccepted))
      .toEqual([expect.objectContaining({ generationId: first.headers.get('x-mahoshojo-generation-id') })]);
  });

  it('uses the real Native request-id DELETE before headers, rejects wrong actors/reasons/budgets and keeps completed terminal', async () => {
    const mocks = await open({ faults: { createDelayMs: 200 } });
    const pending = fetch(mocks.honoOrigin + CREATE, { method: 'POST', headers, body: JSON.stringify(story()) });
    await expect.poll(() => mocks.trace().generationCount).toBe(1);
    const cancel = (actor: string, reason = 'content_policy') => fetch(mocks.honoOrigin + '/api/arena/generate-stream', {
      method: 'DELETE', headers: { 'content-type': 'application/json', [ACTOR]: actor },
      body: JSON.stringify({ generationRequestId: story().generationRequestId, reason }) });
    expect((await cancel(otherActor)).status).toBe(403);
    const invalid = await cancel(BOOTSTRAP, 'invented');
    expect(await invalid.json()).toMatchObject({ code: 'GENERATION_CANCEL_REASON_INVALID' });
    const accepted = await cancel(BOOTSTRAP);
    expect(accepted.status).toBe(202);
    const first = await pending;
    expect(parsedEvents(await first.text())).toEqual([expect.objectContaining({ data: { ok: false, status: 'cancelled', code: 'CONTENT_POLICY_CANCELLED' } })]);
    const id = first.headers.get('x-mahoshojo-generation-id')!;
    const tooLarge = await raw(mocks.honoOrigin, `/api/arena/generations/${id}/cancel`, { method: 'POST', headers,
      chunks: [JSON.stringify({ reason: 'user', extra: 'x'.repeat(1024) })] });
    expect(tooLarge.status).toBe(413); expect(JSON.parse(tooLarge.body).code).toBe('GENERATION_CANCEL_REQUEST_TOO_LARGE');
    expect((await raw(mocks.honoOrigin, CREATE, { method: 'DELETE', headers, chunks: ['{}'] })).status).toBe(405);
    const completed = await create(mocks, story('synthetic_request_complete'));
    const late = await fetch(mocks.honoOrigin + `/api/arena/generations/${completed.id}/cancel`, { method: 'POST', headers: { [ACTOR]: completed.token } });
    expect(late.status).toBe(200); expect(await late.json()).toEqual({ generationId: completed.id, status: 'completed', cancelled: false });
    expect(mocks.trace().counts[`hono POST ${CREATE}`]).toBe(2);
  });
});

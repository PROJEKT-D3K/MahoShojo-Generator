import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

// Acceptance-only services. No proxy, provider SDK, account login or durable storage.
const HOST = '127.0.0.1';
const STORY_HEADER = 'x-mahoshojo-arena-story-protocol';
const ACTOR_HEADER = 'x-mahoshojo-generation-actor-token';
const ROLE_HEADER = 'x-mahoshojo-arena-reconciliation-protocol';
const STORY_VERSION = 'arena-story-v1';
const ROLE_VERSION = 'arena-reconciliation-v1';
const CREATE = '/api/arena/session/generate-next';
const ROLE = '/api/arena/update-combatants-after-stream';
const READINESS = '/api/hosted/dr-readiness';
const REQUEST_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/u;
const STORY_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const GENERATION_ID = /^arena_[0-9a-f]{64}$/u;
const BOOTSTRAP = /^bootstrap\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu;
const CURSOR = /^\d{1,20}-\d{1,20}$/u;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Closed, bounded knobs only; never accept URLs, credentials, response bodies or code.
export function validateStoryMockFaults(input = {}) {
  const defaults = { streamDelayMs: 600, markdownChunks: 1, wireChunkBytes: 0,
    createDisconnectBeforeHeaders: false, createDelayMs: 0, lookupHideFirst: 0, lookupDelayMs: 0,
    statusHideFirst: 0, statusDelayMs: 0, roleDelayMs: 0, withdrawStoryAfterCreate: false };
  const fail = () => { throw new Error('Invalid synthetic fault configuration'); };
  if (!object(input) || Object.keys(input).some(key => !Object.hasOwn(defaults, key)
      && !['version', 'streamFault', 'roleFault'].includes(key)) || (input.version !== undefined && input.version !== 1)) fail();
  const result = { version: 1, ...defaults, ...input };
  for (const [key, maximum] of Object.entries({ streamDelayMs: 10_000, markdownChunks: 16, wireChunkBytes: 4096,
    createDelayMs: 10_000, lookupHideFirst: 100, lookupDelayMs: 10_000, statusHideFirst: 100, statusDelayMs: 10_000, roleDelayMs: 10_000 })) {
    if (!Number.isInteger(result[key]) || result[key] < (key === 'markdownChunks' ? 1 : 0) || result[key] > maximum) fail();
  }
  for (const key of ['createDisconnectBeforeHeaders', 'withdrawStoryAfterCreate']) if (typeof result[key] !== 'boolean') fail();
  const fault = (value, kinds, stream = false) => {
    if (value === undefined) return undefined;
    if (!object(value) || Object.keys(value).some(key => !['kind', 'attempts', ...(stream ? ['afterEvents'] : [])].includes(key))
        || !kinds.includes(value.kind) || !Number.isInteger(value.attempts) || value.attempts < 1 || value.attempts > 100) fail();
    if (stream && (!Number.isInteger(value.afterEvents) || value.afterEvents < 1 || value.afterEvents >= result.markdownChunks + 4)) fail();
    return { kind: value.kind, attempts: value.attempts, ...(stream ? { afterEvents: value.afterEvents } : {}) };
  };
  const streamFault = fault(input.streamFault, ['eof', 'disconnect'], true);
  const roleFault = fault(input.roleFault, ['disconnect', 'malformed', 'http-error']);
  delete result.streamFault; delete result.roleFault;
  return { ...result, ...(streamFault ? { streamFault } : {}), ...(roleFault ? { roleFault } : {}) };
}

export async function readStoryMockFaults(file) {
  if (!path.isAbsolute(file)) throw new Error('Fault configuration path must be absolute');
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw new Error('Invalid synthetic fault file');
  try { return validateStoryMockFaults(JSON.parse(await readFile(file, 'utf8'))); }
  catch { throw new Error('Invalid synthetic fault configuration'); }
}

class RequestError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const reject = (status, code) => { throw new RequestError(status, code); };
const json = (response, status, value, headers = {}) => {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  response.end(JSON.stringify(value));
};

function route(service, rawTarget) {
  // Do not normalize dot segments or log unrecognized paths/query strings.
  if (typeof rawTarget !== 'string' || !rawTarget.startsWith('/') || rawTarget.startsWith('//')) return null;
  const [path, query, extra] = rawTarget.split('?');
  if (extra !== undefined) return null;
  if (service === 'next' && query === undefined) {
    if (path === READINESS) return { name: path, kind: 'cloud-readiness', methods: ['GET'] };
    if (path === '/api/auth/get-session') return { name: path, kind: 'session', methods: ['GET'] };
    if (path === '/announcements.json') return { name: path, kind: 'announcements', methods: ['GET'] };
    if (path === ROLE) return { name: path, kind: 'role', methods: ['GET', 'POST'] };
  }
  if (service !== 'hono') return null;
  if (path === READINESS && query === undefined) return { name: path, kind: 'readiness', methods: ['GET'] };
  if (path === CREATE && query === undefined) return { name: path, kind: 'create', methods: ['POST'] };
  // Native stop-before-headers uses the existing generic create route, not story POST.
  if (path === '/api/arena/generate-stream' && query === undefined) return { name: path, kind: 'cancel-request', methods: ['DELETE'] };
  const lookup = path.match(/^\/api\/arena\/generation-requests\/([^/]+)$/u);
  if (lookup && REQUEST_ID.test(lookup[1]) && query === undefined) {
    return { name: '/api/arena/generation-requests/:requestId', kind: 'lookup', id: lookup[1], methods: ['GET'] };
  }
  const generation = path.match(/^\/api\/arena\/generations\/([^/]+)(\/(?:stream|cancel))?$/u);
  if (!generation || !GENERATION_ID.test(generation[1])) return null;
  if (!generation[2] && query === undefined) {
    return { name: '/api/arena/generations/:generationId', kind: 'status', id: generation[1], methods: ['GET'] };
  }
  if (generation[2] === '/cancel' && query === undefined) {
    return { name: '/api/arena/generations/:generationId/cancel', kind: 'cancel', id: generation[1], methods: ['POST'] };
  }
  if (generation[2] !== '/stream') return null;
  const after = query?.startsWith('after=') ? query.slice(6) : undefined;
  if (query !== undefined && (after === undefined || !CURSOR.test(after))) return null;
  return { name: '/api/arena/generations/:generationId/stream', kind: 'replay', id: generation[1], after, methods: ['GET'] };
}

function checkTransport(request, port) {
  if (request.headers.host !== `${HOST}:${port}`) reject(403, 'LOOPBACK_HOST_REQUIRED');
  const origin = request.headers.origin;
  if (origin !== undefined && (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/u.test(origin)
      || Number(origin.slice(origin.lastIndexOf(':') + 1)) > 65535)) reject(403, 'LOOPBACK_ORIGIN_REQUIRED');
  // Real account/provider credentials have no place in this isolated anonymous drill.
  for (const header of ['cookie', 'authorization', 'proxy-authorization', 'x-api-key', 'x-mahoshojo-arena-expected-user-id']) {
    if (request.headers[header] !== undefined) reject(403, 'ANONYMOUS_SYSTEM_ONLY');
  }
}

async function readBody(request, limit, entry) {
  const declared = request.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > limit)) reject(413, 'BODY_TOO_LARGE');
  const chunks = [];
  let size = 0;
  // Use events, not a breaking async iterator (which destroys the socket before 413).
  await new Promise((resolve, rejectBody) => {
    const clean = () => { request.off('data', data); request.off('end', end); request.off('error', fail); request.off('aborted', abort); };
    const fail = () => { clean(); rejectBody(new RequestError(400, 'INCOMPLETE_BODY')); };
    const abort = () => fail();
    const data = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        clean(); request.resume(); rejectBody(new RequestError(413, 'BODY_TOO_LARGE')); return;
      }
      chunks.push(chunk);
    };
    const end = () => { clean(); resolve(); };
    request.on('data', data); request.once('end', end); request.once('error', fail); request.once('aborted', abort);
  });
  const bytes = Buffer.concat(chunks, size);
  entry.bodyBytes = size;
  if (size) entry.bodySha256 = sha256(bytes);
  return bytes;
}

function parseBody(bytes, request) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') reject(415, 'JSON_REQUIRED');
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!object(value)) reject(400, 'INVALID_JSON_OBJECT');
    return value;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    reject(400, 'INVALID_JSON_OBJECT');
  }
}

function bootstrap(request) {
  const match = typeof request.headers[ACTOR_HEADER] === 'string' && request.headers[ACTOR_HEADER].match(BOOTSTRAP);
  if (!match) reject(403, 'SYNTHETIC_ANONYMOUS_BOOTSTRAP_REQUIRED');
  const now = Date.now();
  const token = Buffer.from(JSON.stringify({ v: 1, anonymousId: match[1], issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(), signature: 'SYNTHETIC-ACCEPTANCE-NOT-A-REAL-SIGNATURE' })).toString('base64url');
  return { bootstrapHash: sha256(match[0]), token, tokenHash: sha256(token) };
}

function authorize(request, generation, requireToken = false) {
  const token = request.headers[ACTOR_HEADER];
  const digest = typeof token === 'string' ? sha256(token) : null;
  if (digest !== generation.tokenHash && (requireToken || digest !== generation.bootstrapHash)) reject(403, 'ACTOR_MISMATCH');
}

function validateStory(input) {
  if (input.version !== 1 || !REQUEST_ID.test(input.generationRequestId ?? '')
      || !STORY_ID.test(input.sessionId ?? '')
      || !['start', 'continue'].includes(input.action) || !Number.isSafeInteger(input.chapterIndex)
      || input.chapterIndex < 1
      || !object(input.seed) || !object(input.chapterContext)
      || !Array.isArray(input.chapterContext.workingCombatants) || !input.chapterContext.workingCombatants.length
      || input.chapterContext.workingCombatants.length > 32
      || input.chapterContext.workingCombatants.some((combatant) => !object(combatant)
        || typeof combatant.type !== 'string' || !object(combatant.data))) reject(400, 'INVALID_STORY_REQUEST');
  // Keep the server DTO's linear context gate; an impossible continuation is not W01 evidence.
  const recent = input.chapterContext.recentWindow;
  if (!Array.isArray(recent) || recent.length > 12 || recent.some((chapter) => !object(chapter)
      || !STORY_ID.test(chapter.chapterId ?? '') || !Number.isSafeInteger(chapter.chapterIndex) || chapter.chapterIndex < 1
      || typeof chapter.title !== 'string' || !['full', 'digest'].includes(chapter.mode)
      || typeof chapter.text !== 'string' || typeof chapter.truncated !== 'boolean')) reject(400, 'INVALID_STORY_REQUEST');
  const latest = recent.at(-1);
  if (new Set(recent.map((chapter) => chapter.chapterId)).size !== recent.length
      || recent.some((chapter, index) => index > 0 && chapter.chapterIndex <= recent[index - 1].chapterIndex)
      || (input.action === 'start'
        ? recent.length !== 0 || input.sourceChapterId !== undefined || input.chapterIndex !== 1
        : !latest || input.sourceChapterId !== latest.chapterId || input.chapterIndex !== latest.chapterIndex + 1)
      || (input.chapterPlan !== undefined && (!object(input.chapterPlan)
        || !Number.isInteger(input.chapterPlan.totalChapters) || input.chapterPlan.totalChapters < 1
        || input.chapterPlan.totalChapters > 20 || input.chapterIndex > input.chapterPlan.totalChapters))) {
    reject(400, 'INCONSISTENT_LINEAR_STORY_CONTEXT');
  }
  if (input.customProvider !== undefined && (!object(input.customProvider)
      || input.customProvider.providerId !== 'system' || input.customProvider.apiKey !== ''
      || Object.keys(input.customProvider).some((key) => !['providerId', 'modelId', 'apiKey', 'generationOverrides'].includes(key)))) {
    reject(403, 'ANONYMOUS_SYSTEM_ONLY');
  }
}

// Mirrors the existing public matching hints; opaque card data is not logged/stored.
function projectRoster(combatants) {
  const hint = (value) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
  return combatants.map((combatant) => {
    const result = { type: combatant.type, data: combatant.data };
    if (combatant.isPreset !== undefined) result.isPreset = combatant.isPreset;
    if (hint(combatant.filename)) result.filename = hint(combatant.filename);
    if (hint(combatant.sourceDataCardId)) result.sourceDataCardId = hint(combatant.sourceDataCardId);
    else if (hint(combatant.dataCardId)) result.dataCardId = hint(combatant.dataCardId);
    const room = hint(combatant.roomCombatantKey) ?? hint(combatant.arenaRoomKey);
    if (room) result.roomCombatantKey = room;
    return result;
  });
}

function rosterHash(combatants) {
  return sha256(JSON.stringify(projectRoster(combatants), (_key, value) =>
    object(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value));
}

function waitForStream(response, milliseconds) {
  if (response.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); response.off('close', finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    response.once('close', finish);
  });
}

/** Both services bind only 127.0.0.1. Port 0 is reserved for module-level tests.
 * trace() returns sanitized snapshots; callers own any persistence/evidence export.
 * Synthetic HTTP faults never stand in for Native receipt/SecretStore/invoke faults.
 * beforeCreateHeaders is a module-only test barrier; callers must release it in finally.
 * @param {{ honoPort?: number, nextPort?: number, streamDelayMs?: number, maxBodyBytes?: number, faults?: Record<string, unknown>, beforeCreateHeaders?: () => Promise<void> }} [options]
 */
export async function startStoryMocks({ honoPort, nextPort, streamDelayMs = 600, maxBodyBytes, faults = {}, beforeCreateHeaders } = {}) {
  for (const port of [honoPort, nextPort]) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Explicit loopback ports are required');
  }
  if (honoPort !== 0 && honoPort === nextPort) throw new Error('Hono and Next ports must differ');
  if (!Number.isInteger(streamDelayMs) || streamDelayMs < 0 || streamDelayMs > 10_000) throw new Error('Invalid stream delay');
  if (beforeCreateHeaders !== undefined && typeof beforeCreateHeaders !== 'function') throw new Error('Invalid create headers barrier');
  const config = validateStoryMockFaults(faults);
  if (!Object.hasOwn(faults, 'streamDelayMs')) config.streamDelayMs = streamDelayMs;
  const fixture = JSON.parse(await readFile(new URL('../packages/contracts/fixtures/desktop-arena-hosted.json', import.meta.url), 'utf8'));
  const limit = maxBodyBytes ?? fixture.limits.requestBodyBytes;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > fixture.limits.requestBodyBytes) throw new Error('Invalid body limit');
  const requests = [], counts = new Map(), generations = new Map(), requestIds = new Map(), servers = [];
  let droppedTraceEntries = 0, createdCount = 0, closed = false, closePromise;
  const eventData = (name) => structuredClone(fixture.validSseEvents.find((entry) => entry.event === name).data);
  const trace = () => ({ requests: structuredClone(requests), counts: Object.fromEntries(counts),
    generationCount: createdCount, droppedTraceEntries, scope: 'anonymous-system-synthetic-http', faultConfig: structuredClone(config) });
  const started = performance.now();
  const applied = (entry, name) => { (entry.faults ??= []).push({ name, atMs: Math.round(performance.now() - started) }); };
  const close = () => closePromise ??= (async () => {
    closed = true;
    await Promise.all(servers.map((server) => new Promise((resolve) => {
      server.close(resolve); server.closeAllConnections();
    })));
    // Recovery is deliberately scoped to the lifetime of this synthetic drill.
    generations.clear(); requestIds.clear();
  })();
  const status = (generation) => ({ generationId: generation.id, generationRequestId: generation.requestId,
    status: generation.cancelled ? 'cancelled' : generation.completed ? 'completed' : 'running',
    resumable: !generation.completed && !generation.cancelled,
    lastEventId: generation.lastEventId, updatedAt: generation.updatedAt });
  const writeEvent = async (response, generation, event, entry) => {
    const bytes = Buffer.from(`id: ${event.id}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
    const size = config.wireChunkBytes || bytes.length;
    generation.publishedIndex = Math.max(generation.publishedIndex, Number(event.id.split('-')[0]));
    for (let offset = 0; offset < bytes.length; offset += size) {
      if (response.destroyed || closed) return false;
      response.write(bytes.subarray(offset, offset + size));
      // Yield between transport chunks, including split multibyte UTF-8 characters.
      if (offset + size < bytes.length) await waitForStream(response, 0);
    }
    entry.eventsSent = (entry.eventsSent ?? 0) + 1;
    entry.lastEventId = event.id;
    if (!generation.lastEventId || Number(event.id.split('-')[0]) > Number(generation.lastEventId.split('-')[0])) generation.lastEventId = event.id;
    return true;
  };
  const sse = async (response, generation, entry, after) => {
    let offset = 0;
    if (after !== undefined && after !== '0-0') {
      offset = generation.events.findIndex((event) => event.id === after) + 1;
      if (offset === 0) reject(400, 'UNKNOWN_REPLAY_CURSOR');
    }
    const attempt = ++generation.streamAttempts;
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store',
      [STORY_HEADER]: STORY_VERSION, [ACTOR_HEADER]: generation.token,
      'x-mahoshojo-generation-id': generation.id,
      'x-mahoshojo-generation-request-id': generation.requestId,
      'x-mahoshojo-generation-payload-hash': generation.bodyHash });
    response.flushHeaders();
    if (config.streamDelayMs) applied(entry, 'stream-delay');
    if (config.wireChunkBytes) applied(entry, 'wire-chunks');
    const fault = config.streamFault && attempt <= config.streamFault.attempts ? config.streamFault : undefined;
    const interrupt = async () => {
      applied(entry, `stream-${fault.kind}`);
      if (fault.kind === 'eof') response.end();
      else { await waitForStream(response, 10); response.destroy(); }
    };
    // The cutoff is generation-relative, so persistent faults also stop replay at
    // the same boundary instead of slowly advancing to a false completed result.
    if (fault && !generation.cancelled && offset >= fault.afterEvents) { await interrupt(); return; }
    for (let index = offset; index < generation.events.length; index++) {
      await waitForStream(response, config.streamDelayMs);
      if (response.destroyed || closed) return;
      // Re-read after every wait: cancel may have replaced the unsent suffix.
      const event = generation.events[index];
      if (!event) break;
      if (event.event === 'done' && event.data.status === 'completed') generation.completed = true;
      if (!await writeEvent(response, generation, event, entry)) return;
      if (fault && !generation.cancelled && index + 1 >= fault.afterEvents) { await interrupt(); return; }
    }
    if (!generation.cancelled) generation.completed = true;
    generation.updatedAt = new Date().toISOString();
    response.end();
  };
  const cancel = (request, response, generation, input, entry) => {
    authorize(request, generation);
    if (input.reason !== undefined && !['user', 'content_policy'].includes(input.reason)) reject(400, 'GENERATION_CANCEL_REASON_INVALID');
    entry.generationId = generation.id;
    if (generation.completed || generation.cancelled) return json(response, 200, {
      generationId: generation.id, status: generation.cancelled ? 'cancelled' : 'completed', cancelled: generation.cancelled,
    }, { [ACTOR_HEADER]: generation.token });
    const index = generation.publishedIndex;
    generation.cancelEvent = { id: `${index + 1}-0`, event: 'done', data: { ok: false, status: 'cancelled',
      code: input.reason === 'content_policy' ? 'CONTENT_POLICY_CANCELLED' : 'USER_CANCELLED' } };
    generation.events = generation.events.filter(event => Number(event.id.split('-')[0]) <= index).concat(generation.cancelEvent);
    generation.cancelled = true;
    generation.updatedAt = new Date().toISOString();
    entry.cancelAccepted = true;
    return json(response, 202, { generationId: generation.id, status: 'cancelling', cancelled: true }, { [ACTOR_HEADER]: generation.token });
  };

  const handle = async (request, response, selected, bytes, entry) => {
    if (selected.kind === 'readiness') {
      const withdrawn = config.withdrawStoryAfterCreate && createdCount > 0;
      if (withdrawn) applied(entry, 'withdraw-story-capability');
      return json(response, 200, fixture.capability, withdrawn ? {} : { [STORY_HEADER]: STORY_VERSION });
    }
    if (selected.kind === 'cloud-readiness') return json(response, 200, { ok: true, contractVersion: fixture.capability.contractVersion });
    if (selected.kind === 'session') return json(response, 200, { session: null, user: null });
    if (selected.kind === 'announcements') return json(response, 200, []);
    if (selected.kind === 'role' && request.method === 'GET') {
      return json(response, 200, { ok: true, contractVersion: ROLE_VERSION, expectedUserIdAssertion: 'v1',
        ownership: 'generation-actor', effects: 'frozen-manifest-v1' });
    }
    if (selected.kind === 'create') {
      if (request.headers[STORY_HEADER] !== STORY_VERSION) reject(409, 'STORY_PROTOCOL_REQUIRED');
      const input = parseBody(bytes, request);
      validateStory(input);
      if (requestIds.has(input.generationRequestId)) reject(409, 'DUPLICATE_STORY_CREATE');
      if (generations.size >= 128) reject(429, 'SYNTHETIC_GENERATION_LIMIT');
      const actor = bootstrap(request);
      const id = `arena_${(++createdCount).toString(16).padStart(64, '0')}`;
      const markdown = `# 合成第${input.chapterIndex}章\n\n${eventData('markdown').chunk}合成角色继续前行。\n`;
      const characters = [...markdown];
      const events = [
        ...Array.from({ length: config.markdownChunks }, (_, index) => ({ event: 'markdown', data: { chunk: characters.slice(Math.floor(index * characters.length / config.markdownChunks), Math.floor((index + 1) * characters.length / config.markdownChunks)).join('') } })),
        { event: 'reasoning', data: eventData('reasoning') },
        { event: 'reasoning_done', data: eventData('reasoning_done') },
        { event: 'telemetry', data: eventData('telemetry') },
        { event: 'done', data: eventData('done') },
      ].map((value, index) => ({ ...value, id: `${index + 1}-0` }));
      const generation = { ...actor, id, requestId: input.generationRequestId, bodyHash: entry.bodySha256,
        combatantsHash: rosterHash(input.chapterContext.workingCombatants),
        events, completed: false, cancelled: false, publishedIndex: 0, streamAttempts: 0, roleAttempts: 0, lookupAttempts: 0, statusAttempts: 0,
        lastEventId: null, updatedAt: new Date().toISOString() };
      generations.set(id, generation); requestIds.set(input.generationRequestId, id);
      entry.generationId = id; entry.chapterIndex = input.chapterIndex; entry.action = input.action;
      if (beforeCreateHeaders) await beforeCreateHeaders();
      if (config.createDelayMs) { applied(entry, 'create-delay'); await waitForStream(response, config.createDelayMs); }
      if (response.destroyed || closed) return;
      if (config.createDisconnectBeforeHeaders) { applied(entry, 'create-disconnect-before-headers'); response.destroy(); return; }
      return sse(response, generation, entry);
    }
    if (selected.kind === 'role') {
      if (request.headers[ROLE_HEADER] !== ROLE_VERSION) reject(409, 'RECONCILIATION_PROTOCOL_REQUIRED');
      const input = parseBody(bytes, request);
      const generation = generations.get(input.generationId);
      if (!generation) reject(404, 'GENERATION_NOT_FOUND');
      authorize(request, generation, true);
      if (!generation.completed) reject(409, 'GENERATION_NOT_COMPLETED');
      if (!Array.isArray(input.combatants) || input.combatants.length < 1 || input.combatants.length > 32
          || input.combatants.some((combatant) => !object(combatant) || !object(combatant.data))) reject(400, 'INVALID_COMBATANTS');
      if (rosterHash(input.combatants) !== generation.combatantsHash) reject(409, 'COMBATANTS_MISMATCH');
      entry.generationId = generation.id;
      const attempt = ++generation.roleAttempts;
      if (config.roleDelayMs) { applied(entry, 'role-delay'); await waitForStream(response, config.roleDelayMs); }
      if (response.destroyed || closed) return;
      const fault = config.roleFault;
      if (fault && attempt <= fault.attempts) {
        applied(entry, `role-${fault.kind}`);
        if (fault.kind === 'disconnect') { response.destroy(); return; }
        if (fault.kind === 'malformed') return json(response, 200, { invalidSyntheticRole: true }, { [ROLE_HEADER]: ROLE_VERSION });
        return json(response, 503, { version: ROLE_VERSION, generationId: generation.id,
          code: 'ARENA_RECONCILIATION_UNAVAILABLE', error: 'Synthetic reconciliation unavailable' }, { [ROLE_HEADER]: ROLE_VERSION });
      }
      return json(response, 200, { version: ROLE_VERSION, generationId: generation.id, success: true, warnings: [],
        updatedCombatants: input.combatants.map((combatant, combatantIndex) => {
          const data = { ...combatant.data, content: '合成验收角色更新' };
          // This mock cannot verify or issue real character signatures/authority.
          delete data.signature;
          return { combatantIndex, data, isNative: false };
        }) },
      { [ROLE_HEADER]: ROLE_VERSION });
    }
    let input;
    if (['cancel', 'cancel-request'].includes(selected.kind)) {
      try { input = bytes.length ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) : {}; }
      catch { reject(400, 'INVALID_JSON'); }
      if (input == null) input = {};
      if (!object(input)) reject(400, 'GENERATION_CANCEL_REASON_INVALID');
    }
    if (selected.kind === 'cancel-request' && !REQUEST_ID.test(input.generationRequestId ?? '')) reject(400, 'GENERATION_REQUEST_ID_INVALID');
    const generation = generations.get(selected.kind === 'lookup' ? requestIds.get(selected.id)
      : selected.kind === 'cancel-request' ? requestIds.get(input.generationRequestId) : selected.id);
    if (!generation) reject(404, 'GENERATION_NOT_FOUND');
    authorize(request, generation);
    entry.generationId = generation.id;
    if (input) return cancel(request, response, generation, input, entry);
    if (selected.kind === 'replay') return sse(response, generation, entry, selected.after);
    const kind = selected.kind;
    const attempt = ++generation[`${kind}Attempts`];
    if (config[`${kind}DelayMs`]) { applied(entry, `${kind}-delay`); await waitForStream(response, config[`${kind}DelayMs`]); }
    if (response.destroyed || closed) return;
    if (attempt <= config[`${kind}HideFirst`]) { applied(entry, `${kind}-hidden`); reject(404, 'GENERATION_NOT_FOUND'); }
    return json(response, 200, status(generation), { [ACTOR_HEADER]: generation.token });
  };

  const listen = async (service, port) => {
    const server = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 15_000, headersTimeout: 10_000 }, async (request, response) => {
      const selected = route(service, request.url);
      const method = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'].includes(request.method) ? request.method : 'OTHER';
      const entry = { service, method, path: selected?.name ?? '<unmatched>' };
      const key = `${service} ${method} ${entry.path}`;
      entry.count = (counts.get(key) ?? 0) + 1; counts.set(key, entry.count);
      if (requests.length < 4096) requests.push(entry); else droppedTraceEntries++;
      response.once('finish', () => { entry.status = response.statusCode; });
      response.once('close', () => { if (!response.writableFinished) entry.responseAborted = true; });
      try {
        checkTransport(request, server.address().port);
        if (!selected) reject(404, 'UNKNOWN_ROUTE');
        if (!selected.methods.includes(request.method)) reject(405, 'METHOD_NOT_ALLOWED');
        const bytes = await readBody(request, ['cancel', 'cancel-request'].includes(selected.kind) ? 1024 : limit, entry);
        if (request.method === 'GET' && bytes.length) reject(400, 'GET_BODY_NOT_ALLOWED');
        await handle(request, response, selected, bytes, entry);
      } catch (error) {
        const status = error instanceof RequestError ? error.status : 500;
        let code = error instanceof RequestError ? error.code : 'SYNTHETIC_INTERNAL_ERROR';
        if (['cancel', 'cancel-request'].includes(selected?.kind) && code === 'BODY_TOO_LARGE') code = 'GENERATION_CANCEL_REQUEST_TOO_LARGE';
        entry.error = code;
        if (!response.headersSent && !response.destroyed) json(response, status, { ok: false, code });
        else response.destroy();
        // Drain rejected bodies without retaining or logging them.
        request.resume();
      }
    });
    servers.push(server);
    await new Promise((resolve, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(port, HOST, () => { server.off('error', rejectListen); resolve(); });
    });
    return `http://${HOST}:${server.address().port}`;
  };
  try {
    const honoOrigin = await listen('hono', honoPort);
    const nextOrigin = await listen('next', nextPort);
    return { honoOrigin, nextOrigin, trace, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function main() {
  const options = {};
  const names = { '--hono-port': 'honoPort', '--next-port': 'nextPort', '--stream-delay-ms': 'streamDelayMs', '--fault-config': 'faults' };
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = names[process.argv[index]], value = process.argv[index + 1];
    if (!name || Object.hasOwn(options, name) || (name !== 'faults' && !/^\d+$/u.test(value ?? ''))) throw new Error('Use --hono-port N --next-port N [--stream-delay-ms N] [--fault-config absolute.json]');
    options[name] = name === 'faults' ? await readStoryMockFaults(value) : Number(value);
  }
  if (!options.honoPort || !options.nextPort) throw new Error('CLI requires two explicit, distinct nonzero loopback ports');
  const mocks = await startStoryMocks(options);
  process.stdout.write(`${JSON.stringify({ event: 'listening', honoOrigin: mocks.honoOrigin, nextOrigin: mocks.nextOrigin,
    scope: 'anonymous-system-synthetic-http' })}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    await mocks.close();
    process.stdout.write(`${JSON.stringify({ event: 'closed', trace: mocks.trace() })}\n`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Bind errors may carry filesystem/host details; never print arbitrary error objects.
    process.stderr.write('Synthetic story mock failed: check distinct loopback ports, bounded options and fault configuration\n');
    process.exitCode = 1;
  });
}

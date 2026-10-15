import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

// Acceptance-only, synthetic and anonymous. No proxy, provider, account or persistence.
export const SYNTHETIC_CARD = Object.freeze({ name: '合成旅人', description: '仅用于本机酒馆流式验收的虚构角色。' });
export const SCENARIOS = Object.freeze(['stop', 'slow', 'eof', 'disconnect', 'length', 'rate-limit', 'probe-mismatch']);
const HOST = '127.0.0.1';
const STREAM = '/api/tavern/convert-stream';
const HEADER = 'x-mahoshojo-tavern-completion';
const BODY_LIMIT = 16 * 1024;
// Public output of buildTavernAiAttachment(SYNTHETIC_CARD); the test pins this contract.
const ATTACHMENT = Object.freeze({ name: 'tavern-card.json', type: 'application/json',
  content: JSON.stringify({ ...SYNTHETIC_CARD, personality: '', scenario: '', first_mes: '', mes_example: '', creator_notes: '' }) });
const MARKDOWN = ['# 合成旅人\n\n', '名字：合成旅人\n\n', '合成旅人是一位温和的虚构角色，背着行囊走进灯火明亮的酒馆。\n\n',
  '他愿意倾听来客的故事，也会为迷路的人指明方向。这段文字仅用于本机流式验收。\n'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
class RequestError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const reject = (status, code) => { throw new RequestError(status, code); };
const json = (response, status, value, headers = {}) => {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  response.end(JSON.stringify(value));
};
function transport(request, port) {
  if (request.headers.host !== `${HOST}:${port}`) reject(403, 'LOOPBACK_HOST_REQUIRED');
  const origin = request.headers.origin;
  if (origin !== undefined && (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/u.test(origin)
    || Number(origin.slice(origin.lastIndexOf(':') + 1)) > 65535)) reject(403, 'LOOPBACK_ORIGIN_REQUIRED');
  if (Object.keys(request.headers).some(name => /cookie|authorization|api[-_]?key|token|secret|credential|expected-user-id/iu.test(name))) {
    reject(403, 'ANONYMOUS_SYSTEM_ONLY');
  }
}
function readBody(request) {
  const declared = request.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > BODY_LIMIT)) reject(413, 'BODY_TOO_LARGE');
  return new Promise((resolve, rejectBody) => {
    const chunks = [];
    let size = 0;
    const clean = () => { clearTimeout(timer); request.off('data', data); request.off('end', end); request.off('error', fail); request.off('aborted', fail); };
    const fail = () => { clean(); rejectBody(new RequestError(400, 'INCOMPLETE_BODY')); };
    const data = chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) { clean(); request.resume(); rejectBody(new RequestError(413, 'BODY_TOO_LARGE')); return; }
      chunks.push(chunk);
    };
    const end = () => { clean(); resolve(Buffer.concat(chunks, size)); };
    const timer = setTimeout(() => { clean(); request.resume(); rejectBody(new RequestError(408, 'BODY_TIMEOUT')); }, 5000);
    request.on('data', data); request.once('end', end); request.once('error', fail); request.once('aborted', fail);
  });
}
function validate(bytes, request) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') reject(415, 'JSON_REQUIRED');
  let input;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { reject(400, 'INVALID_SYNTHETIC_REQUEST'); }
  if (!keys(input, ['template', 'language', 'sourceName', 'attachments', 'customProvider'])
    || input.template !== 'general' || typeof input.language !== 'string' || !input.language.trim()
    || input.language.length > 32 || input.sourceName !== SYNTHETIC_CARD.name
    || !Array.isArray(input.attachments) || input.attachments.length !== 1) reject(400, 'INVALID_SYNTHETIC_REQUEST');
  const attachment = input.attachments[0];
  if (!keys(attachment, Object.keys(ATTACHMENT)) || Object.keys(ATTACHMENT).some(key => attachment[key] !== ATTACHMENT[key])) {
    reject(400, 'SYNTHETIC_ATTACHMENT_REQUIRED');
  }
  const provider = input.customProvider;
  if (provider !== undefined && (!keys(provider, ['providerId', 'apiKey', 'modelId'])
    || provider.providerId !== 'system' || provider.apiKey !== ''
    || (provider.modelId !== undefined && provider.modelId !== 'default'))) reject(403, 'ANONYMOUS_SYSTEM_ONLY');
}
function delay(response, milliseconds) {
  if (response.destroyed) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); response.off('close', finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    response.once('close', finish);
  });
}
function classify(target) {
  const routes = { [STREAM]: 'tavern-stream', '/api/hosted/dr-readiness': 'readiness',
    '/announcements.json': 'announcements', '/api/auth/get-session': 'session' };
  return Object.hasOwn(routes, target) ? routes[target] : 'unknown';
}

/** Bind only to 127.0.0.1; port 0 is reserved for module tests. No arbitrary body/config files. */
export async function startTavernMock({ port, scenario = 'stop', streamDelayMs = 200, slowDelayMs = 1000 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Explicit loopback port required');
  if (!SCENARIOS.includes(scenario)) throw new Error('Invalid synthetic scenario');
  for (const value of [streamDelayMs, slowDelayMs]) {
    if (!Number.isInteger(value) || value < 0 || value > 10_000) throw new Error('Invalid bounded delay');
  }
  const requests = [], tasks = new Set(), sockets = new Set();
  let droppedTraceEntries = 0, activeStreams = 0, closed = false, closePromise;
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 5000 }, (request, response) => {
    const route = classify(request.url);
    const entry = { route, scenario, method: ['GET', 'POST'].includes(request.method) ? request.method : 'OTHER',
      status: null, eventsSent: 0, fault: null, responseClosed: false, responseFinished: false, responseClosedEarly: false };
    if (requests.length < 256) requests.push(entry); else droppedTraceEntries++;
    const responseClosed = new Promise(resolve => response.once('close', () => {
      entry.responseClosed = true;
      entry.responseFinished = response.writableFinished;
      entry.responseClosedEarly = !response.writableFinished;
      if (response.headersSent) entry.status = response.statusCode;
      resolve();
    }));
    response.on('error', () => {});
    const task = (async () => {
      let streaming = false;
      try {
        transport(request, server.address()?.port);
        if (route === 'unknown') reject(404, 'UNKNOWN_ROUTE');
        if (request.method !== 'GET' && !(route === 'tavern-stream' && request.method === 'POST')) reject(405, 'METHOD_NOT_ALLOWED');
        const bytes = await readBody(request);
        if (closed || response.destroyed) return;
        if (request.method === 'GET') {
          if (bytes.length) reject(400, 'GET_BODY_NOT_ALLOWED');
          if (route === 'readiness') return json(response, 200, { ok: true, contractVersion: 'g25e1-v1' });
          if (route === 'announcements') return json(response, 200, []);
          if (route === 'session') return json(response, 200, { session: null, user: null });
          const version = entry.scenario === 'probe-mismatch' ? 2 : 1;
          if (version === 2) entry.fault = 'probe-mismatch';
          return json(response, 200, { protocol: 'tavern-completion', version }, { [HEADER]: `v${version}` });
        }
        if (request.headers[HEADER] !== 'v1') reject(409, 'TAVERN_PROTOCOL_REQUIRED');
        validate(bytes, request);
        if (activeStreams >= 8) reject(429, 'STREAM_LIMIT');
        const selected = entry.scenario;
        if (selected === 'probe-mismatch') reject(409, 'TAVERN_PROTOCOL_MISMATCH');
        if (selected === 'rate-limit') {
          entry.fault = selected;
          return json(response, 429, { error: '合成限流，请稍后重试', retryAfterSeconds: 5 }, { 'retry-after': '5', [HEADER]: 'v1' });
        }
        streaming = true; activeStreams++;
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', [HEADER]: 'v1' });
        response.flushHeaders();
        const emit = (event, data) => { response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); entry.eventsSent++; };
        const chunks = selected === 'slow' ? 60 : selected === 'eof' || selected === 'disconnect' ? 2 : MARKDOWN.length;
        for (let index = 0; index < chunks; index++) {
          await delay(response, selected === 'slow' ? slowDelayMs : streamDelayMs);
          if (closed || response.destroyed) return;
          emit('markdown', { chunk: MARKDOWN[index % MARKDOWN.length] });
        }
        if (selected === 'eof' || selected === 'disconnect') {
          entry.fault = selected;
          if (selected === 'eof') response.end();
          else { await delay(response, 10); response.destroy(); }
          return;
        }
        emit('done', { ok: true, tavernCompletion: { version: 1, finishReason: selected === 'length' ? 'length' : 'stop' } });
        response.end();
      } catch (error) {
        entry.fault = error instanceof RequestError ? error.code : 'SYNTHETIC_INTERNAL_ERROR';
        if (!response.headersSent && !response.destroyed) {
          json(response, error instanceof RequestError ? error.status : 500, { ok: false, code: entry.fault }, { connection: 'close' });
        } else response.destroy();
        request.resume();
      } finally {
        await responseClosed;
        if (streaming) activeStreams--;
      }
    })();
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  });
  server.maxConnections = 32;
  server.maxRequestsPerSocket = 128;
  server.keepAliveTimeout = 1000;
  server.setTimeout(15_000, socket => socket.destroy());
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, HOST, () => { server.off('error', rejectListen); resolve(); });
  });
  const origin = `http://${HOST}:${server.address().port}`;
  return {
    origin,
    setScenario(next) {
      if (!SCENARIOS.includes(next)) throw new Error('Invalid synthetic scenario');
      if (closed || activeStreams) throw new Error('Scenario change requires an idle open mock');
      scenario = next;
    },
    trace: () => ({ requests: structuredClone(requests), droppedTraceEntries, activeStreams, closed }),
    close: () => closePromise ??= (async () => {
      closed = true;
      await new Promise(resolve => { server.close(resolve); for (const socket of sockets) socket.destroy(); });
      await Promise.all(tasks);
    })(),
  };
}

async function main() {
  const options = {};
  const names = { '--port': 'port', '--scenario': 'scenario', '--stream-delay-ms': 'streamDelayMs', '--slow-delay-ms': 'slowDelayMs' };
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = names[process.argv[index]], value = process.argv[index + 1];
    if (!name || Object.hasOwn(options, name) || value === undefined || (name !== 'scenario' && !/^\d+$/u.test(value))) throw new Error('Invalid CLI options');
    options[name] = name === 'scenario' ? value : Number(value);
  }
  if (!options.port) throw new Error('CLI requires an explicit nonzero loopback port');
  const mock = await startTavernMock(options);
  process.stdout.write(`${JSON.stringify({ event: 'listening', origin: mock.origin, scenario: options.scenario ?? 'stop' })}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    await mock.close();
    process.stdout.write(`${JSON.stringify({ event: 'closed', trace: mock.trace() })}\n`);
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write('Synthetic Tavern mock failed: check loopback port and bounded options\n'); process.exitCode = 1; });
}

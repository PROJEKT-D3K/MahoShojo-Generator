import { describe, expect, it, vi } from 'vitest';
import { openArenaGenerationStreamClient, type ArenaGenerationTerminalBoundary } from '@mahoshojo/hosted-api/arena-generation/client';
const terminal = 'id: 3-0\nevent: error\ndata: {"status":"failed","code":"AI_STREAM_INCOMPLETE"}\n\n';
const create = async (body: ReadableStream<Uint8Array>, observe: (_boundary: ArenaGenerationTerminalBoundary) => void) => openArenaGenerationStreamClient({ endpoint: 'arena', bodyHash: 'hash', maxReconnectAttempts: 0, onTerminalBoundary: observe }, {
  loadState: () => null, saveState: () => {}, createRequestId: () => 'request-boundary', encodeUtf8: text => new TextEncoder().encode(text),
  waitForReconnectOpportunity: async () => {}, isInitialCreateOutcomeAmbiguous: () => false, classifyExplicitAbort: () => null,
  prepareCreate: () => {}, observeResponse: () => {}, transport: {
    create: async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'X-Mahoshojo-Generation-Id': 'generation-boundary' } }),
    lookup: vi.fn(), resume: vi.fn(), cancel: vi.fn(),
  },
});
describe('read-only terminal boundary observation', () => {
  it('observes only already read tail and never waits for EOF or reads another chunk', async () => {
    const read = vi.fn(), observe = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull(controller) { read(); controller.enqueue(new TextEncoder().encode(terminal + 'event: done\ndata: partial')); } }, { highWaterMark: 0 });
    const response = await create(body, observe);
    expect(await response.text()).toBe(terminal); expect(read).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledExactlyOnceWith({ kind: 'terminal', bufferedTail: 'event: done\ndata: partial', rejectedEvent: false });
  });
  it('records rejected cursor evidence without altering established dedup or terminal delivery', async () => {
    const observe = vi.fn();
    const markdown = 'id: 2-0\nevent: markdown\ndata: {"chunk":"text"}\n\n';
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(markdown + markdown + terminal)); controller.close(); } });
    const response = await create(body, observe);
    expect(await response.text()).toBe(markdown + terminal);
    expect(observe).toHaveBeenCalledExactlyOnceWith({ kind: 'terminal', bufferedTail: '', rejectedEvent: true });
  });
  it('observer exceptions do not change successful transport completion', async () => {
    const observe = vi.fn(() => { throw new Error('observer'); });
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(terminal)); } });
    expect(await (await create(body, observe)).text()).toBe(terminal);
  });
});

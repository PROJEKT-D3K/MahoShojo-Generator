import { describe, expect, it, vi } from 'vitest';
import { openArenaGenerationStream } from '@/lib/arena/resumable-generation-client';

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
const response = (body: string) => new Response(body, { headers: {
  'Content-Type': 'text/event-stream', 'X-Mahoshojo-Generation-Id': 'generation-partial',
} });

describe('terminal-only failed replay keeps delivered content', () => {
  it.each(['failed', 'cancelled', 'producer_lost'] as const)('passes partial body and reasoning through one terminal-only %s without retry', async status => {
    const event = status === 'cancelled' ? 'done' : 'error';
    const wire = 'id: 1-0\nevent: markdown\ndata: {"chunk":"部分正文"}\n\n'
      + 'id: 2-0\nevent: reasoning\ndata: {"chunk":"部分推理"}\n\n'
      + `id: 3-0\nevent: ${event}\ndata: ${JSON.stringify({ status, ok: false })}\n\n`;
    const fetcher = vi.fn(async () => response(wire));
    const states: string[] = [];
    const opened = await openArenaGenerationStream({
      endpoint: '/api/arena/generate-stream', body: { mode: 'classic' }, headers: {}, fetcher,
      storage: new MemoryStorage(), generationRequestId: 'request-failure-partial',
      getInitialRoutePin: () => ({ placement: 'hono-primary' }), onStateChange: value => states.push(value),
    });
    const body = await opened.text();
    expect(body).toContain('部分正文'); expect(body).toContain('部分推理');
    expect(body).not.toContain('event: snapshot');
    expect(body.match(/event: (done|error)/gu)).toHaveLength(1);
    expect(states.at(-1)).toBe(status);
    expect(fetcher).toHaveBeenCalledOnce();
  });

});

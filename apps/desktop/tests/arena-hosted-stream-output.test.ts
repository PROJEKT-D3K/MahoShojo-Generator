import { describe, expect, it, vi } from 'vitest';
import { collectArenaHostedStreamOutput, createArenaHostedStreamOutput } from '../src/features/arena/hosted-stream-output';
import { readFileSync } from 'node:fs';
const ranking = JSON.parse(readFileSync(new URL('../../../packages/contracts/fixtures/arena-generation-ranking.json', import.meta.url), 'utf8'));

// Exercise the real budget branches with tiny in-memory inputs, without large output fixtures.
vi.mock('@mahoshojo/contracts/desktop-arena-hosted', async importOriginal => {
  const actual = await importOriginal<typeof import('@mahoshojo/contracts/desktop-arena-hosted')>();
  return { ...actual, DESKTOP_ARENA_HOSTED_LIMITS: { ...actual.DESKTOP_ARENA_HOSTED_LIMITS, outputContentBytes: 64, eventWireBytes: 512 } };
});
const wire = (event: string, data: unknown, id = '1-0') => `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const options = () => ({ signal: new AbortController().signal, userStopReason: 'stop' });
const snapshot = (telemetry?: unknown) => ({ markdown: '替换正文', reasoning: '独立推理', status: 'running',
  lastEventId: '1-0', updatedAt: '2026-10-10T00:00:00.000Z', ...(telemetry !== undefined ? { telemetry } : {}) });

describe('shared Hosted C0 output collector', () => {
  it('binds ranking to the response generation, ignores late feedback and keeps report authority independent', async () => {
    const pending = { success: true, generationId: ranking.generationId, state: 'pending', message: '等待' };
    const response = (text: string) => new Response(text, { headers: { 'X-Mahoshojo-Generation-Id': ranking.generationId } });
    // Use small pending/failed DTOs because this suite intentionally has a tiny wire budget.
    const output = await collectArenaHostedStreamOutput(response(wire('ranking', pending)
      + wire('markdown', { chunk: '正文' }, '2-0') + wire('done', { status: 'completed', ok: true }, '3-0')
      + wire('ranking', { success: false, generationId: ranking.generationId, error: 'late' }, '4-0')), options());
    expect(output.ranking).toEqual(pending); expect(output.terminal?.event).toBe('done');
    expect((await collectArenaHostedStreamOutput(response(wire('ranking', { ...pending, generationId: 'foreign' })), options())).ranking).toBeNull();
    const feedbackOnly = await collectArenaHostedStreamOutput(response(wire('ranking', pending)), options());
    expect(feedbackOnly.terminal).toBeNull(); expect(feedbackOnly.serverStatus).toBeNull();
    const cold = await collectArenaHostedStreamOutput(response(wire('snapshot', snapshot()) + wire('done', { status: 'completed', ok: true }, '2-0')), options());
    expect(cold.ranking).toBeNull();
  });
  it('retains nullable and boolean telemetry separately from the existing numeric usage projection', async () => {
    const telemetry = { version: 1, usage: { promptTokens: null, completionTokens: 8, completionTokensIncludesReasoning: false } };
    const meta = { parseOk: true, meta: { report: { headline: '标题' } }, raw: '原元数据', rawTruncated: false };
    const onEvent = vi.fn();
    const output = await collectArenaHostedStreamOutput(new Response(
      wire('markdown', { chunk: '被快照替换' }) + wire('snapshot', snapshot(telemetry), '2-0')
      + wire('markdown', { chunk: '尾' }, '3-0') + wire('reasoning', { chunk: '想' }, '4-0')
      + wire('meta', meta, '5-0') + wire('done', { status: 'completed', ok: true }, '6-0'),
    ), { ...options(), onEvent });
    expect(output).toMatchObject({ markdown: '替换正文尾', reasoning: '独立推理想', telemetry,
      usage: { completionTokens: 8 }, metaEvent: { event: 'meta', data: meta }, serverStatus: 'completed',
      terminal: { event: 'done', data: { status: 'completed', ok: true } } });
    expect(output.usage).not.toHaveProperty('promptTokens'); expect(output.usage).not.toHaveProperty('completionTokensIncludesReasoning');
    expect(onEvent).toHaveBeenCalledTimes(6);
  });
  it.each([null, undefined])('a snapshot with %s telemetry clears previous usage exactly', async telemetry => {
    const output = await collectArenaHostedStreamOutput(new Response(
      wire('telemetry', { usage: { totalTokens: 10, completionTokensIncludesReasoning: true } }) + wire('snapshot', snapshot(telemetry), '2-0'),
    ), options());
    expect(output.telemetry).toBeNull(); expect(output.usage).toBeUndefined();
  });
  it('decodes fragmented UTF-8 and preserves failed terminal/meta originals without declaring success', async () => {
    const bytes = new TextEncoder().encode(wire('markdown', { chunk: '😀完整' })
      + wire('meta_error', { parseOk: false, error: '无元数据', raw: '原件' }, '2-0')
      + wire('error', { status: 'failed', error: '生成失败' }, '3-0'));
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (offset === bytes.length) controller.close(); else controller.enqueue(bytes.slice(offset, ++offset));
    } });
    expect(await collectArenaHostedStreamOutput(new Response(body), options())).toMatchObject({
      markdown: '😀完整', metaEvent: { event: 'meta_error', data: { raw: '原件' } }, terminal: { event: 'error' }, serverStatus: 'failed',
    });
  });
  it.each(['failed', 'cancelled', 'producer_lost'] as const)('preserves partial body and reasoning with a terminal-only %s', async status => {
    const terminalEvent = status === 'cancelled' ? 'done' : 'error';
    const onEvent = vi.fn();
    const output = await collectArenaHostedStreamOutput(new Response(
      wire('markdown', { chunk: '部分正文' }) + wire('reasoning', { chunk: '部分推理' }, '2-0')
      + wire(terminalEvent, { status, ok: false, error: '未完成' }, '3-0'),
    ), { ...options(), onEvent });
    expect(output).toMatchObject({ markdown: '部分正文', reasoning: '部分推理', serverStatus: status,
      terminal: { event: terminalEvent, data: { status, ok: false } } });
    expect(onEvent.mock.calls.filter(([event]) => event.event === 'done' || event.event === 'error')).toHaveLength(1);
    expect(onEvent.mock.calls.some(([event]) => event.event === 'snapshot')).toBe(false);
  });
  it('keeps caller-owned originals after a later read failure and releases the reader lock', async () => {
    const output = createArenaHostedStreamOutput(); let reads = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (reads++ === 0) controller.enqueue(new TextEncoder().encode(wire('markdown', { chunk: '可导出原文' })));
      else controller.error(new Error('read failed'));
    } });
    await expect(collectArenaHostedStreamOutput(new Response(body), { ...options(), output })).rejects.toThrow('read failed');
    expect(output.markdown).toBe('可导出原文'); expect(body.locked).toBe(false);
  });
  it('enforces combined decoded markdown/reasoning bytes and the pending event wire budget', async () => {
    await expect(collectArenaHostedStreamOutput(new Response(wire('markdown', { chunk: 'm'.repeat(40) })
      + wire('reasoning', { chunk: 'r'.repeat(25) }, '2-0')), options())).rejects.toThrow('4 MiB');
    await expect(collectArenaHostedStreamOutput(new Response('x'.repeat(513)), options())).rejects.toThrow('事件超过');
  });
  it('drains a user stop through C0 without accepting late output events', async () => {
    const abort = new AbortController(), onEvent = vi.fn(); abort.abort('stop');
    const output = await collectArenaHostedStreamOutput(new Response(wire('markdown', { chunk: '迟到正文' })
      + wire('done', { status: 'completed', ok: true }, '2-0')), { signal: abort.signal, userStopReason: 'stop', onEvent });
    expect(output).toEqual(createArenaHostedStreamOutput()); expect(onEvent).not.toHaveBeenCalled();
  });
});

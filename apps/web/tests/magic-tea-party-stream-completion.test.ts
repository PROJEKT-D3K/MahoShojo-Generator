import { describe, expect, it } from 'vitest';
import { resolveMagicTeaPartyFinishReason, withMagicTeaPartyCompletionEvidence } from '@/lib/magic-tea-party/stream-completion';
const source = 'event: markdown\ndata: {"chunk":"茶😀"}\n\nevent: done\ndata: {"ok":true}\n\n';
const response = (text = source, size = 1) => {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (let index = 0; index < bytes.length; index += size) controller.enqueue(bytes.slice(index, index + size));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
};
describe('Tea terminal evidence adapter', () => {
  it.each([1, 2, 7, 1000])('preserves exact original UTF-8/event bytes for chunks of %s bytes', async size => {
    const output = await withMagicTeaPartyCompletionEvidence(response(source, size), Promise.resolve('stop')).text();
    expect(output).toBe(source.replace('event: done', 'event: tea_completion\ndata: {"finishReason":"stop"}\n\nevent: done'));
  });
  it.each(['length', 'unknown'])('does not upgrade %s to normal success', async reason => {
    expect(await withMagicTeaPartyCompletionEvidence(response(), Promise.resolve(reason)).text()).toContain(`"finishReason":"${reason}"`);
  });
  it('rejection, absence, timeout and abort fail closed', async () => {
    expect(await resolveMagicTeaPartyFinishReason(Promise.reject(new Error('failed')))).toBeNull();
    expect(await resolveMagicTeaPartyFinishReason(undefined)).toBeNull();
    expect(await resolveMagicTeaPartyFinishReason(new Promise(() => {}), undefined, 1)).toBeNull();
    const controller = new AbortController();
    const pending = resolveMagicTeaPartyFinishReason(new Promise(() => {}), controller.signal);
    controller.abort(); expect(await pending).toBeNull();
    expect(await withMagicTeaPartyCompletionEvidence(response(), Promise.resolve('stop'), controller.signal).text()).toContain('"finishReason":null');
  });
  it('EOF and error without done never manufacture terminal evidence', async () => {
    for (const text of ['event: markdown\ndata: {"chunk":"片段"}\n\n', 'event: error\ndata: {"error":"失败"}\n\n']) {
      expect(await withMagicTeaPartyCompletionEvidence(response(text), Promise.resolve('stop')).text()).toBe(text);
    }
  });
});

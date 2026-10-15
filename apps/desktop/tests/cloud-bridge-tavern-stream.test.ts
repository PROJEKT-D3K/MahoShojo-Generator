import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { DesktopHostedGenerateRequest, HostedGenerationEvent } from '@mahoshojo/contracts/desktop-cloud';
import {
  CANCEL_HOSTED_AI_COMMAND,
  DesktopCloudError,
  DesktopTavernStreamError,
  STREAM_HOSTED_AI_COMMAND,
  streamHostedAi,
  cancelHostedAi,
  type HostedAiChannel,
} from '../src/platform/cloud-bridge';

const fixture = JSON.parse(readFileSync(new URL('../../../packages/contracts/fixtures/desktop-hosted-tavern-stream.json', import.meta.url), 'utf8')) as {
  validMarkdown: unknown[]; invalidMarkdown: unknown[];
  validDone: unknown[]; invalidDone: unknown[];
  validErrors: unknown[]; invalidErrors: unknown[];
  preDispatchCodes: string[];
  rateLimited: { expected: unknown };
};
const request: DesktopHostedGenerateRequest = {
  requestId: 'tavern-stream', routeId: 'tavern-convert-stream',
  body: { template: 'general', language: 'zh-CN', sourceName: 'Alice', attachments: [] },
};
const done = { event: 'done', data: fixture.validDone[0] };
const markdown: HostedGenerationEvent = { event: 'markdown', data: { chunk: '正文' } };
const run = (events: unknown[], rejection?: unknown) => {
  const channel: HostedAiChannel = {};
  const seen: HostedGenerationEvent[] = [];
  const invoke = vi.fn(async () => {
    for (const event of events) channel.onmessage?.(event as never);
    if (rejection !== undefined) throw rejection;
  });
  const promise = streamHostedAi(invoke, request, event => seen.push(event), { createChannel: () => channel });
  return { promise, invoke, channel, seen };
};

const expectBridgeInvalid = async (events: unknown[], rejection?: unknown) => {
  const result = run(events, rejection);
  await expect(result.promise).rejects.toMatchObject({
    name: 'DesktopTavernStreamError', code: 'bridge-invalid', phase: 'possible-dispatch',
  });
  expect(result.seen.filter(event => event.event === 'error')).toEqual([{
    event: 'error', data: {
      ok: false, code: 'bridge-invalid', error: expect.any(String),
    },
  }]);
  expect(result.seen.some(event => event.event === 'done')).toBe(false);
  result.channel.onmessage?.(done as never);
  result.channel.onmessage?.(markdown);
  expect(result.seen.at(-1)?.event).toBe('error');
  expect(result.invoke).toHaveBeenCalledTimes(1);
  return result;
};

describe('Tavern Hosted stream bridge', () => {
  it('passes only the validated fixed route request to Native', async () => {
    const result = run([markdown, done]);
    await expect(result.promise).resolves.toBeUndefined();
    expect(result.invoke).toHaveBeenCalledExactlyOnceWith(STREAM_HOSTED_AI_COMMAND, {
      request, onEvent: result.channel,
    });
    expect(result.seen).toEqual([markdown, done]);
  });
  it.each(fixture.validDone.map(data => ({ data })))('preserves terminal evidence %j without deciding product success', async ({ data }) => {
    const terminal = { event: 'done', data };
    const result = run([terminal, markdown, done, { event: 'error', data: fixture.validErrors[0] }]);
    await expect(result.promise).resolves.toBeUndefined();
    result.channel.onmessage?.(markdown);
    expect(result.seen).toEqual([terminal]);
  });
  it.each(fixture.validErrors.map(data => ({ data })))('keeps the first valid failure %j terminal', async ({ data }) => {
    const terminal = { event: 'error', data };
    const result = run([markdown, terminal, done, markdown]);
    await expect(result.promise).resolves.toBeUndefined();
    expect(result.seen).toEqual([markdown, terminal]);
  });
  it('preserves bounded 429 retry diagnostics', async () => {
    const terminal = { event: 'error', data: fixture.rateLimited.expected };
    const result = run([terminal, done]);
    await expect(result.promise).resolves.toBeUndefined();
    expect(result.seen).toEqual([terminal]);
  });
  it.each(fixture.validMarkdown.map(data => ({ data })))('accepts exact markdown %j', async ({ data }) => {
    const event = { event: 'markdown', data };
    const result = run([event, done]);
    await expect(result.promise).resolves.toBeUndefined();
    expect(result.seen).toEqual([event, done]);
  });
  it.each(fixture.invalidMarkdown.map(data => ({ data })))('locks after malformed markdown %j', async ({ data }) => {
    await expectBridgeInvalid([{ event: 'markdown', data }, done]);
  });
  it.each(fixture.invalidDone.map(data => ({ data })))('locks after malformed completion %j', async ({ data }) => {
    await expectBridgeInvalid([{ event: 'done', data }, done]);
  });
  it.each(fixture.invalidErrors.map(data => ({ data })))('locks after malformed failure %j', async ({ data }) => {
    await expectBridgeInvalid([{ event: 'error', data }, done]);
  });
  it.each([null, [], {}, { event: 1, data: {} }, { ...markdown, extra: true }].map(event => ({ event })))('rejects malformed IPC envelope %j', async ({ event }) => {
    await expectBridgeInvalid([event, done]);
  });
  it('does not convert reasoning, reasoning_done or telemetry into body text', async () => {
    const nonBody = ['reasoning', 'reasoning_done', 'telemetry'].map(event => ({ event, data: { chunk: '非正文', text: '非正文' } }));
    const result = run([...nonBody, markdown, done]);
    await expect(result.promise).resolves.toBeUndefined();
    expect(result.seen).toEqual([...nonBody, markdown, done]);
    expect(result.seen.filter(event => event.event === 'markdown')).toEqual([markdown]);
  });
  it('ignores unknown events without weakening later completion validation', async () => {
    const result = run([{ event: 'future_extension', data: { chunk: '非正文' } }, done]);
    await expect(result.promise).resolves.toBeUndefined();
    expect(result.seen).toEqual([done]);
  });
  it.each([
    [], [markdown], [{ event: 'reasoning', data: { text: 'thought' } }],
    [{ event: 'telemetry', data: { done: true } }], [{ event: 'future_extension', data: {} }],
  ].map(events => ({ events })))('does not treat invoke void resolution as a terminal: %j', async ({ events }) => {
    await expectBridgeInvalid(events);
  });
  it.each(['done', 'error'])('does not swallow invoke failure after a valid %s terminal', async event => {
    const terminal = event === 'done' ? done : { event, data: fixture.validErrors[0] };
    const cause = { code: 'invalid-request', message: 'late IPC failure' };
    const result = run([terminal, done], cause);
    await expect(result.promise).rejects.toMatchObject({ code: cause.code, phase: 'possible-dispatch', cause });
    expect(result.seen).toEqual([terminal]);
  });
  it('never downgrades malformed IPC to a later pre-dispatch invoke error', async () => {
    await expectBridgeInvalid([{ event: 'markdown', data: { chunk: 1 } }, done], { code: 'invalid-request', message: 'late rejection' });
  });
  it.each(fixture.preDispatchCodes)('proves only event-free invoke %s rejection is pre-dispatch', async code => {
    const cause = { code, message: 'native rejected before dispatch' };
    const result = run([], cause);
    await expect(result.promise).rejects.toBeInstanceOf(DesktopCloudError);
    await expect(result.promise).rejects.toBeInstanceOf(DesktopTavernStreamError);
    await expect(result.promise).rejects.toMatchObject({
      command: STREAM_HOSTED_AI_COMMAND, code, message: cause.message, cause, phase: 'pre-dispatch',
    });
    result.channel.onmessage?.(done as never);
    expect(result.seen).toEqual([]);
    expect(result.invoke).toHaveBeenCalledTimes(1);
  });
  it.each(fixture.preDispatchCodes)('any observed event prevents %s from reverting to pre-dispatch', async code => {
    for (const event of [markdown, { event: 'reasoning', data: {} }, { event: 'telemetry', data: {} }, { event: 'future_extension', data: {} }]) {
      const result = run([event], { code, message: 'late rejection' });
      await expect(result.promise).rejects.toMatchObject({ code, phase: 'possible-dispatch' });
      result.channel.onmessage?.(done as never);
      expect(result.seen.some(item => item.event === 'done')).toBe(false);
    }
  });
  it.each(['network-error', 'timeout', 'cancelled', 'not-authenticated', 'state-mismatch', 'internal-error', 'future-native-code'])('keeps ambiguous invoke %s failure possible', async code => {
    const result = run([], { code, message: 'native failed' });
    await expect(result.promise).rejects.toMatchObject({ phase: 'possible-dispatch' });
  });
  it('submits stream invoke before cancellation in the same turn', async () => {
    const channel: HostedAiChannel = {};
    const seen: HostedGenerationEvent[] = [];
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const invoke = vi.fn((command: string) => {
      if (command === STREAM_HOSTED_AI_COMMAND) return pending;
      if (command === CANCEL_HOSTED_AI_COMMAND) {
        channel.onmessage?.({ event: 'error', data: { ok: false, error: 'cancelled', code: 'cancelled' } });
        release();
        return Promise.resolve(true);
      }
      throw new Error('unexpected command');
    });
    const stream = streamHostedAi(invoke, request, event => seen.push(event), { createChannel: () => channel });
    const cancelled = cancelHostedAi(invoke, request.requestId);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([STREAM_HOSTED_AI_COMMAND, CANCEL_HOSTED_AI_COMMAND]);
    await expect(cancelled).resolves.toBe(true);
    await expect(stream).resolves.toBeUndefined();
    expect(seen).toEqual([{ event: 'error', data: { ok: false, error: 'cancelled', code: 'cancelled' } }]);
  });
  it('classifies synchronous invoke throws without dropping the original cause', async () => {
    const cause = { code: 'storage-unavailable', message: 'native unavailable before dispatch' };
    const invoke = vi.fn(() => { throw cause; });
    await expect(streamHostedAi(invoke, request, () => {}, { createChannel: () => ({}) })).rejects.toMatchObject({
      name: 'DesktopTavernStreamError', code: cause.code, phase: 'pre-dispatch', cause,
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('preserves an unstructured invoke cause without inventing a pre-dispatch phase', async () => {
    const cause = new Error('ipc unavailable');
    const result = run([], cause);
    await expect(result.promise).rejects.toMatchObject({ code: 'internal-error', phase: 'possible-dispatch', cause });
  });
  it('reports invalid local Tavern input as pre-dispatch without invoking or creating a channel', async () => {
    const invoke = vi.fn(async () => undefined);
    const createChannel = vi.fn(() => ({}));
    await expect(streamHostedAi(invoke, { ...request, body: { ...(request.body as object), customProvider: {} } }, () => {}, { createChannel })).rejects.toMatchObject({
      name: 'DesktopTavernStreamError', code: 'invalid-request', phase: 'pre-dispatch',
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(createChannel).not.toHaveBeenCalled();
  });
});

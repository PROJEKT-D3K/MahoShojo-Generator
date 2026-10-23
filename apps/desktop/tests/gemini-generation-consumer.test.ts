import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import fixtureData from '@mahoshojo/contracts/fixtures/gemini-generate-content-stream.json';
import { AiExecutionRequestSchema, type AiExecutionRequest } from '@mahoshojo/contracts/ai-execution';
import { AiStreamEventSchema, type AiStreamEvent } from '@mahoshojo/ai-core/stream-events';
import { executeFreeGeneration, type FreeGenerationInput } from '../src/features/free/generation';
import { STREAM_DIRECT_AI_COMMAND } from '../src/platform/direct-ai-bridge';
import { withFixtureStreamReceipt } from './helpers/stream-receipt-fixture';

const fixture = fixtureData as {
  cases: Array<{ name: string; request: unknown; events: unknown[] }>;
  failureCases: Array<{ name: string; expectedCode: string }>;
};
const nativeDirectory = process.env.MAHO_NATIVE_EVENT_FIXTURE_DIR;
const input: FreeGenerationInput = { prompt: '生成一位火系魔法少女', schema: 'magical-girl', language: '简体中文', attachments: [] };

const replayNormalized = (rawEvents: unknown[], beforeTerminal?: Promise<void>) => {
  let sent: AiExecutionRequest | undefined;
  const events = rawEvents.map(event => AiStreamEventSchema.parse(event));
  const invoke = vi.fn(withFixtureStreamReceipt(async (command: string, args?: Record<string, unknown>) => {
    if (command !== STREAM_DIRECT_AI_COMMAND) throw new Error(`unexpected command: ${command}`);
    sent = args!.request as AiExecutionRequest;
    const channel = args!.onEvent as { onmessage: (event: AiStreamEvent) => void };
    for (const event of events) {
      if (event.type === 'result') await beforeTerminal;
      channel.onmessage(event);
    }
  }));
  return { invoke, options: { invoke, profileId: 'google-fixture', createChannel: () => ({}) }, request: () => sent };
};

const assertFamilyConsumer = async (name: string, rawEvents: unknown[]) => {
  const testCase = fixture.cases.find(testCase => testCase.name === name)!;
  const request = AiExecutionRequestSchema.parse(testCase.request);
  const native = replayNormalized(rawEvents);
  const streaming = name === 'tea-text';
  const outcome = await executeFreeGeneration(native.options, streaming ? { ...input, schema: 'general' } : input,
    { requestId: request.requestId, mode: 'direct-local', modelId: request.modelId,
      generationMode: streaming ? 'stream' : 'non-stream', overrides: { temperature: 0.25, maxOutputTokens: 256 } },
    new AbortController().signal);
  expect(native.invoke).toHaveBeenCalledOnce();
  expect(native.request()).toMatchObject({ modelId: 'fixture-model', responseFormat: 'text', temperature: 0.25, maxOutputTokens: 256 });
  expect(native.request()).not.toHaveProperty('thinking');
  const expected = AiStreamEventSchema.parse(testCase.events.at(-1));
  if (expected.type !== 'result' || expected.result.status !== 'completed') throw new Error('Expected completed fixture');
  expect(outcome.rawText).toBe(expected.result.output.text);
  expect(JSON.stringify(outcome)).not.toContain('synthetic-opaque');
  if (name === 'incomplete-card-json') {
    expect(outcome.status).toBe('invalid-output');
    expect(outcome).not.toHaveProperty('card');
  } else {
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') throw new Error('Expected generated card');
    expect(outcome.reasoning).toMatchObject({ source: 'provider', text: expected.result.output.reasoning });
    expect(JSON.stringify(outcome.card)).not.toContain(expected.result.output.reasoning!);
    if (streaming) {
      expect(outcome.cardKind).toBe('general');
      expect(outcome.card).toMatchObject({ name: '茶会来客', content: expected.result.output.text });
    } else {
      expect(outcome.cardKind).toBe('magical-girl');
      expect(outcome.card).toMatchObject({ codename: '焰汐', templateId: '魔法少女/心之花/魔法少女（自由生成）' });
      expect(native.request()!.messages[0]!.content).toContain('JSON');
    }
  }
};

describe('Gemini normalized events enter the shared Desktop generation family', () => {
  it.each(['card-json', 'incomplete-card-json', 'tea-text'])('%s preserves local schema/Markdown projection and isolated thoughts', async name => {
    await assertFamilyConsumer(name, fixture.cases.find(testCase => testCase.name === name)!.events);
  });

  it('does not project complete-looking JSON into a card before a terminal result', async () => {
    const testCase = fixture.cases.find(({ name }) => name === 'card-json')!;
    const request = AiExecutionRequestSchema.parse(testCase.request);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const native = replayNormalized(testCase.events, gate);
    let settled = false;
    const partials: string[] = [];
    const running = executeFreeGeneration(native.options, input,
      { requestId: request.requestId, mode: 'direct-local' }, new AbortController().signal, text => partials.push(text))
      .finally(() => { settled = true; });
    await vi.waitFor(() => expect(partials.at(-1)).toContain('"codename":"焰汐"'));
    expect(settled).toBe(false);
    release();
    expect((await running).status).toBe('completed');
  });
});

it.skipIf(!nativeDirectory)('feeds actual Rust Gemini loopback events through the existing Desktop card executor', async () => {
  for (const name of ['card-json', 'incomplete-card-json', 'tea-text']) {
    const events = JSON.parse(readFileSync(join(nativeDirectory!, `gemini-${name}.json`), 'utf8')) as unknown[];
    await assertFamilyConsumer(name, events);
  }
});

it.skipIf(!nativeDirectory)('never projects native truncation, filtering, invalid output or stream errors into a card', async () => {
  for (const testCase of fixture.failureCases) {
    const packet = JSON.parse(readFileSync(join(nativeDirectory!, `gemini-failure-${testCase.name}.json`), 'utf8')) as {
      request: { requestId: string }; events: unknown[];
    };
    const native = replayNormalized(packet.events);
    const outcome = await executeFreeGeneration(native.options, input,
      { requestId: packet.request.requestId, mode: 'direct-local' }, new AbortController().signal);
    expect(outcome).toMatchObject({ status: 'failed', code: testCase.expectedCode });
    expect(outcome).not.toHaveProperty('card');
    const acceptedText = packet.events.map(event => AiStreamEventSchema.parse(event))
      .filter(event => event.type === 'text-delta').map(event => event.delta).join('');
    expect(outcome.rawText).toBe(acceptedText);
    expect(JSON.stringify(outcome)).not.toContain('synthetic-secret');
    expect(JSON.stringify(outcome)).not.toContain('synthetic-opaque');
    expect(native.invoke).toHaveBeenCalledOnce();
  }
});

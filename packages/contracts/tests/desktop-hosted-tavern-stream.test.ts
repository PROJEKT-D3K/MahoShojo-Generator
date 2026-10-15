import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DESKTOP_TAVERN_STREAM_PRE_DISPATCH_CODES,
  DesktopCloudErrorCodeSchema,
  DesktopHostedGenerateRequestSchema,
  DesktopHostedJsonRequestSchema,
  DesktopTavernStreamErrorSchema,
  DesktopTavernStreamMarkdownSchema,
  HostedGenerationRouteIdSchema,
  classifyDesktopTavernStreamFailure,
  hostedGenerationBodyMaxBytes,
} from '../src/desktop-cloud';
import {
  TAVERN_COMPLETION_HEADER,
  TAVERN_COMPLETION_HEADER_VALUE,
  TavernCompletionCapabilitySchema,
  TavernCompletionDoneSchema,
} from '../src/tavern-completion';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/desktop-hosted-tavern-stream.json', import.meta.url), 'utf8')) as {
  routeId: 'tavern-convert-stream';
  bodyMaxBytes: number;
  capability: { header: string; value: string; payload: unknown; invalidPayloads: unknown[] };
  preDispatchCodes: string[];
  failureCases: (Parameters<typeof classifyDesktopTavernStreamFailure>[0] & { label: string; phase: string })[];
  validMarkdown: unknown[]; invalidMarkdown: unknown[];
  validDone: unknown[]; invalidDone: unknown[];
  validErrors: unknown[]; invalidErrors: unknown[];
  rateLimited: { expected: unknown };
};
const bodyFixture = JSON.parse(readFileSync(new URL('../fixtures/desktop-hosted-tavern.json', import.meta.url), 'utf8')) as {
  valid: { label: string; request: Record<string, unknown> }[];
  invalid: { label: string; request: Record<string, unknown> }[];
};
const streamRequest = (request: Record<string, unknown>) => ({ ...request, routeId: fixture.routeId });

describe('Tavern Hosted Native stream contract', () => {
  it.each(bodyFixture.valid)('reuses JSON boundary: accepts $label', ({ request }) => {
    expect(DesktopHostedGenerateRequestSchema.safeParse(streamRequest(request)).success).toBe(true);
  });
  it.each(bodyFixture.invalid)('reuses JSON boundary: rejects $label', ({ request }) => {
    expect(DesktopHostedGenerateRequestSchema.safeParse(streamRequest(request)).success).toBe(false);
  });
  it('keeps the reused UTF-8 content, aggregate and escaped JSON budgets', () => {
    const body = { template: 'general', language: 'zh-CN', sourceName: '', attachments: [{ name: 'x', content: '\0'.repeat(1024 * 1024) }] };
    const request = { requestId: 'tavern-stream', routeId: fixture.routeId, body };
    expect(DesktopHostedGenerateRequestSchema.safeParse(request).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThan(fixture.bodyMaxBytes);
    expect(DesktopHostedGenerateRequestSchema.safeParse({ ...request, body: {
      ...body, attachments: [{ name: 'x', content: '界'.repeat(350_000) }],
    } }).success).toBe(false);
    expect(DesktopHostedGenerateRequestSchema.safeParse({ ...request, body: {
      ...body, attachments: [...body.attachments, { name: 'y', content: 'x' }],
    } }).success).toBe(false);
  });
  it.each(['url', 'headers', 'raw', 'customProvider'])('rejects %s at the request and body boundary', key => {
    const request = streamRequest(bodyFixture.valid[0]!.request);
    expect(DesktopHostedGenerateRequestSchema.safeParse({ ...request, [key]: {} }).success).toBe(false);
    expect(DesktopHostedGenerateRequestSchema.safeParse({ ...request, body: {
      ...(bodyFixture.valid[0]!.request.body as Record<string, unknown>), [key]: {},
    } }).success).toBe(false);
  });
  it('does not widen the JSON command or other routes and budgets', () => {
    expect(HostedGenerationRouteIdSchema.safeParse(fixture.routeId).success).toBe(true);
    expect(HostedGenerationRouteIdSchema.safeParse('tavern-convert').success).toBe(false);
    expect(DesktopHostedJsonRequestSchema.safeParse(streamRequest(bodyFixture.valid[0]!.request)).success).toBe(false);
    expect(hostedGenerationBodyMaxBytes(fixture.routeId)).toBe(fixture.bodyMaxBytes);
    expect(hostedGenerationBodyMaxBytes('tavern-convert')).toBe(fixture.bodyMaxBytes);
    expect(hostedGenerationBodyMaxBytes('generate-canshou-stream')).toBe(256 * 1024);
    expect(DesktopCloudErrorCodeSchema.safeParse('rate-limited').success).toBe(false);
  });
  it('reuses the existing completion capability', () => {
    expect(fixture.capability.header).toBe(TAVERN_COMPLETION_HEADER);
    expect(fixture.capability.value).toBe(TAVERN_COMPLETION_HEADER_VALUE);
    expect(TavernCompletionCapabilitySchema.safeParse(fixture.capability.payload).success).toBe(true);
    for (const value of fixture.capability.invalidPayloads) {
      expect(TavernCompletionCapabilitySchema.safeParse(value).success).toBe(false);
    }
  });
  it.each(fixture.validMarkdown.map(value => ({ value })))('accepts exact markdown %j', ({ value }) => expect(DesktopTavernStreamMarkdownSchema.safeParse(value).success).toBe(true));
  it.each(fixture.invalidMarkdown.map(value => ({ value })))('rejects malformed markdown %j', ({ value }) => expect(DesktopTavernStreamMarkdownSchema.safeParse(value).success).toBe(false));
  it.each(fixture.validDone.map(value => ({ value })))('accepts existing completion evidence %j', ({ value }) => expect(TavernCompletionDoneSchema.safeParse(value).success).toBe(true));
  it.each(fixture.invalidDone.map(value => ({ value })))('rejects invalid completion evidence %j', ({ value }) => expect(TavernCompletionDoneSchema.safeParse(value).success).toBe(false));
  it.each(fixture.validErrors.map(value => ({ value })))('accepts closed failure %j', ({ value }) => expect(DesktopTavernStreamErrorSchema.safeParse(value).success).toBe(true));
  it.each(fixture.invalidErrors.map(value => ({ value })))('rejects invalid failure %j', ({ value }) => expect(DesktopTavernStreamErrorSchema.safeParse(value).success).toBe(false));
  it('preserves bounded 429 retry diagnostics without a new message length limit', () => {
    expect(DesktopTavernStreamErrorSchema.parse(fixture.rateLimited.expected)).toEqual(fixture.rateLimited.expected);
    expect(DesktopTavernStreamErrorSchema.safeParse({ ok: false, code: 'server-rejected', error: 'x'.repeat(1024) }).success).toBe(true);
  });
  it('only lists known pre-dispatch invoke rejections', () => {
    expect(DESKTOP_TAVERN_STREAM_PRE_DISPATCH_CODES).toEqual(fixture.preDispatchCodes);
  });
  it.each(fixture.failureCases)('classifies $label as $phase', entry => {
    expect(classifyDesktopTavernStreamFailure(entry)).toBe(entry.phase);
  });
});

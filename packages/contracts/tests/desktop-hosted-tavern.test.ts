import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DesktopHostedJsonRequestSchema, DesktopHostedTavernBodySchema, HostedGenerationRouteIdSchema, hostedGenerationBodyMaxBytes } from '../src/desktop-cloud';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/desktop-hosted-tavern.json', import.meta.url), 'utf8')) as {
  valid: { label: string; request: Record<string, unknown> }[];
  invalid: { label: string; request: Record<string, unknown> }[];
};
const templates = ['general', 'general-scenario', 'scenario', 'magical-girl', 'canshou'] as const;

describe('酒馆 Hosted JSON contract', () => {
  it.each(fixture.valid)('accepts $label', ({ request }) => expect(DesktopHostedJsonRequestSchema.safeParse(request).success).toBe(true));
  it.each(fixture.invalid)('rejects $label', ({ request }) => expect(DesktopHostedJsonRequestSchema.safeParse(request).success).toBe(false));
  describe.each(templates)('%s boundaries', (template) => {
    it.each(fixture.invalid.filter(({ request }) => {
      const body = request.body as Record<string, unknown>;
      return body.template === 'general' || body.template === 'general-scenario';
    }))('retains the same boundary for $label', ({ request }) => {
      expect(DesktopHostedJsonRequestSchema.safeParse({
        ...request, body: { ...(request.body as Record<string, unknown>), template },
      }).success).toBe(false);
    });
  });
  it.each(templates)('rejects noncanonical spellings of %s', (template) => {
    for (const invalid of [template.toUpperCase(), ` ${template}`, `${template} `]) {
      const request = fixture.valid[0]!.request;
      expect(DesktopHostedJsonRequestSchema.safeParse({
        ...request, body: { ...(request.body as Record<string, unknown>), template: invalid },
      }).success).toBe(false);
    }
  });
  it.each(templates)('retains UTF-8 content limits and JSON escaping room for %s', (template) => {
    const body = { template, language: 'zh-CN', sourceName: '', attachments: [{ name: 'x', content: '\u0000'.repeat(1024 * 1024) }] };
    expect(DesktopHostedTavernBodySchema.safeParse(body).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThan(hostedGenerationBodyMaxBytes('tavern-convert'));
    expect(DesktopHostedTavernBodySchema.safeParse({ ...body, attachments: [{ name: 'x', content: '界'.repeat(350_000) }] }).success).toBe(false);
    expect(DesktopHostedTavernBodySchema.safeParse({ ...body, attachments: [...body.attachments, { name: 'y', content: 'x' }] }).success).toBe(false);
    expect(hostedGenerationBodyMaxBytes('generate-magical-girl')).toBe(256 * 1024);
    expect(HostedGenerationRouteIdSchema.safeParse('tavern-convert').success).toBe(false);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DesktopHostedJsonRequestSchema, DesktopHostedJsonResponseSchema, DesktopHostedNameBodySchema, HostedGenerationRouteIdSchema } from '../src/desktop-cloud';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/desktop-hosted-name.json', import.meta.url), 'utf8')) as {
  valid: { label: string; request: Record<string, unknown> }[];
  invalid: { label: string; request: Record<string, unknown> }[];
};

describe('名字 Hosted JSON 固定系统通道', () => {
  it.each(fixture.valid)('接受 $label', ({ request }) => expect(DesktopHostedJsonRequestSchema.safeParse(request).success).toBe(true));
  it.each(fixture.invalid)('拒绝 $label', ({ request }) => expect(DesktopHostedJsonRequestSchema.safeParse(request).success).toBe(false));
  it('trim 与 UTF-16 边界保持 Web 语义，BOM 是空白而 NEL 不是', () => {
    expect(DesktopHostedNameBodySchema.parse({ name: '\ufeff 小满\ufeff' })).toEqual({ name: '小满', language: 'zh-CN' });
    expect(DesktopHostedNameBodySchema.parse({ name: '\u0085' }).name).toBe('\u0085');
    expect(HostedGenerationRouteIdSchema.safeParse('generate-magical-girl').success).toBe(false);
  });
  it('429 header 秒数为可选受检字段，不更改正文', () => {
    expect(DesktopHostedJsonResponseSchema.parse({ status: 429, body: null, retryAfterSeconds: 60 })).toEqual({ status: 429, body: null, retryAfterSeconds: 60 });
    for (const retryAfterSeconds of [0, -1, '60', 1.5, 4_294_967_296]) expect(DesktopHostedJsonResponseSchema.safeParse({ status: 429, body: null, retryAfterSeconds }).success).toBe(false);
  });
});

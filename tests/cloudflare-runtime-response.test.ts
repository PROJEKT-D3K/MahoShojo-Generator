import { describe, expect, test } from 'vitest';

import { assertHealthyCloudflareResponse } from '../apps/web/scripts/cloudflare-runtime-response.mjs';

describe('Cloudflare runtime response gate', () => {
  const response = () => new Response(null, { headers: { 'content-type': 'text/html' } });

  test.each([
    ['/arena', '正在恢复本地设置…'],
    ['/', '欢迎来到魔法国度！'],
  ])('accepts the healthy %s server-rendered shell', (route, marker) => {
    expect(() => assertHealthyCloudflareResponse(route, response(), `<!DOCTYPE html><body>${marker}</body>`)).not.toThrow();
  });

  test.each(['__next_error__', 'Application error:', 'Internal Server Error'])('rejects HTTP 200 error pages containing %s', (error) => {
    expect(() => assertHealthyCloudflareResponse('/arena', response(), `<!DOCTYPE html><body>正在恢复本地设置…${error}</body>`)).toThrow();
  });

  test('rejects unrelated HTML even when HTTP status is 200', () => {
    expect(() => assertHealthyCloudflareResponse('/arena', response(), '<!DOCTYPE html><body>Something went wrong</body>')).toThrow();
  });
});

import assert from 'node:assert/strict';

export function assertHealthyCloudflareResponse(route, response, html) {
  assert.equal(response.status, 200, `${route}: expected a healthy built Worker`);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/i);
  assert.match(html, /<!DOCTYPE html>/i);
  assert.doesNotMatch(html, /__next_error__|Application error:|Internal Server Error/i);
  assert.match(html, route === '/arena' ? /正在恢复本地设置/ : /欢迎来到魔法国度/);
}

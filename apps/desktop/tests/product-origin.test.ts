import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { DESKTOP_PRODUCT_ORIGIN } from '../src/platform/product-origin';

it('Desktop 分享使用既有产品 origin，不是 API 或 WebView origin', () => {
  const native = readFileSync(fileURLToPath(new URL('../src-tauri/src/cloud.rs', import.meta.url)), 'utf8');
  const existingOrigin = native.match(/const CLOUD_ORIGIN_PRODUCTION: &str = "([^"]+)";/u)?.[1];
  expect(existingOrigin).toBeDefined();
  expect(DESKTOP_PRODUCT_ORIGIN).toBe(existingOrigin);
  expect(DESKTOP_PRODUCT_ORIGIN).toBe('https://mahoshojo.colanns.me');
});

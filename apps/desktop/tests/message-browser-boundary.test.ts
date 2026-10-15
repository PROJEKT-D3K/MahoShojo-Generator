import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
it('registers the message command only for the main UI and uses current origin without credentials', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const lib = read('../src-tauri/src/lib.rs');
  expect(read('../src-tauri/build.rs')).toContain('"open_cloud_message_page"');
  expect(lib.slice(lib.indexOf('tauri::generate_handler!['))).toContain('open_cloud_message_page,');
  const acl = JSON.parse(read('../src-tauri/capabilities/main-ui.json')) as { webviews: string[]; windows?: string[]; permissions: string[] };
  expect(acl.webviews).toEqual(['main-ui']);
  expect(acl.windows).toBeUndefined();
  expect(acl.permissions.filter(p => p.includes('cloud-message-page'))).toEqual(['allow-open-cloud-message-page']);
  for (const name of readdirSync(new URL('../src-tauri/capabilities/', import.meta.url))) {
    if (name !== 'main-ui.json' && name.endsWith('.json')) expect(read(`../src-tauri/capabilities/${name}`)).not.toContain('cloud-message-page');
  }
  const command = lib.slice(lib.indexOf('fn open_cloud_message_page('), lib.indexOf('/// 公告快照：'));
  expect(command).toContain('cloud.origin(), &request');
  expect(command).toContain('external_link::open_validated_url(&url)');
  expect(command).not.toMatch(/SecretStore|secrets|\.send\(|\.lock\(|login/);
});

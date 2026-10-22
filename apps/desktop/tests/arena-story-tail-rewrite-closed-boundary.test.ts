import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STORY_TAIL_REWRITE_IPC } from '../src/platform/arena-story-tail-rewrite-native';
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
describe('tail rewrite command registration without schema or product activation', () => {
  it('registers exactly four dedicated commands for main-ui only', () => {
    const build = read('../src-tauri/build.rs'), lib = read('../src-tauri/src/lib.rs');
    const handler = lib.slice(lib.indexOf('tauri::generate_handler!['));
    const acl = JSON.parse(read('../src-tauri/capabilities/main-ui.json')) as { permissions: string[]; webviews: string[]; windows?: string[] };
    const commands = Object.values(STORY_TAIL_REWRITE_IPC);
    expect(build.match(/"\w*arena_story_tail_rewrite\w*"/gu)?.map(name => name.slice(1, -1)).sort()).toEqual([...commands].sort());
    expect(handler.match(/\b\w*arena_story_tail_rewrite\w*\b/gu)?.sort()).toEqual([...commands].sort());
    expect(acl.permissions.filter(permission => /tail-rewrite/u.test(permission)).sort()).toEqual(commands.map(command => `allow-${command.replaceAll('_', '-')}`).sort());
    expect(acl.webviews).toEqual(['main-ui']); expect(acl.windows ?? []).toEqual([]);
    for (const name of readdirSync(new URL('../src-tauri/capabilities/', import.meta.url))) {
      if (name === 'main-ui.json' || !name.endsWith('.json')) continue;
      expect(read(`../src-tauri/capabilities/${name}`)).not.toMatch(/tail-rewrite/u);
    }
  });
  it('keeps raw closed-wire decoding, shared expiry and exact bounded receipt encoding', () => {
    const lib = read('../src-tauri/src/lib.rs');
    const begin = lib.slice(lib.indexOf('fn begin_arena_story_tail_rewrite_commit'), lib.indexOf('fn append_arena_story_part'));
    expect(begin).toContain('manifest_json: String'); expect(begin).toContain('TailRewriteManifest::decode(&manifest_json)?');
    expect(begin).toContain('expire_arena_story_stage(app, begun.token.clone())');
    const end = lib.slice(lib.indexOf('fn end_arena_story_tail_rewrite_commit'), lib.indexOf('fn abort_arena_story_commit'));
    expect(end).toContain('arena_story::ipc::token(Some(&token))?'); expect(end).toContain('.encode()');
    const query = lib.slice(lib.indexOf('fn query_arena_story_tail_rewrite_receipt'), lib.indexOf('fn resolve_arena_story_tail_rewrite_source'));
    expect(query).toContain('Result<Option<String>'); expect(query).toContain('.tail_rewrite_receipt(&session_id, &operation_id, &request_digest)?');
    expect(query).toContain('.map(|receipt| receipt.encode())');
    const harness = read('../src-tauri/src/arena_story_command_pipe_tests.rs');
    for (const command of Object.values(STORY_TAIL_REWRITE_IPC)) expect(harness.match(/tauri::generate_handler!\[([\s\S]*?)\]/u)![1]).toContain(command);
    expect(harness).toContain('.build(tauri::generate_context!())'); expect(harness).toContain('get_ipc_response(');
  });
  it('keeps production image schema 12 and the unconfigured product owner closed', () => {
    expect(read('../src-tauri/src/store.rs')).toContain('pub const SCHEMA_VERSION: i64 = 12;');
    const history = read('../src-tauri/src/arena_story_history.rs');
    expect(history).toContain('Ok(5..=12) => Ok(false)');
    expect(history).toMatch(/#\[cfg\(test\)\]\s*Ok\(13\) => Ok\(true\)/u);
    expect(read('../src/app/battle-page.tsx')).not.toMatch(/tailRewrite|tail_rewrite|tail-rewrite/u);
    const owner = read('../src/features/arena/story-session.ts');
    const flow = owner.slice(owner.indexOf('async generateTailRewrite('), owner.indexOf('private assertNoBranchCandidate('));
    expect(flow.indexOf('readStoryTailRewriteSource(')).toBeLessThan(flow.indexOf('await prepare('));
    expect(flow).toContain('input.mode !== \'direct\'');
    expect(read('../src/platform/arena-story-tail-rewrite-native.ts')).not.toMatch(/localStorage|process\.env|import\.meta\.env/u);
  });
});

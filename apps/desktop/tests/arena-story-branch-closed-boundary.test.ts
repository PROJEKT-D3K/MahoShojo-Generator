import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createIpcStoryNativePort, STORY_IPC } from '../src/platform/arena-story-native';
import { STORY_BRANCH_IPC } from '../src/platform/arena-story-branch-native';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
describe('branch v2 keeps its narrow IPC capability separate from v1', () => {
  it('registers exactly four branch commands for main-ui only', () => {
    const build = read('../src-tauri/build.rs');
    const lib = read('../src-tauri/src/lib.rs');
    const handler = lib.slice(lib.indexOf('tauri::generate_handler!['));
    const acl = JSON.parse(read('../src-tauri/capabilities/main-ui.json')) as { permissions: string[]; webviews: string[]; windows?: string[] };
    expect(build).toContain('begin_arena_story_commit');
    expect(handler).toContain('begin_arena_story_commit');
    expect(acl.permissions).toContain('allow-begin-arena-story-commit');
    const commands = Object.values(STORY_BRANCH_IPC);
    expect(build.match(/"\w*arena_story_branch\w*"/gu)?.map(name => name.slice(1, -1)).sort()).toEqual([...commands].sort());
    expect(handler.match(/\b\w*arena_story_branch\w*\b/gu)?.sort()).toEqual([...commands].sort());
    expect(acl.permissions.filter(permission => /branch/iu.test(permission)).sort()).toEqual(commands.map(command => `allow-${command.replaceAll('_', '-')}`).sort());
    expect(acl.webviews).toEqual(['main-ui']);
    expect(acl.windows ?? []).toEqual([]);
    for (const name of readdirSync(new URL('../src-tauri/capabilities/', import.meta.url))) {
      if (name === 'main-ui.json' || !name.endsWith('.json')) continue;
      const other = JSON.parse(read(`../src-tauri/capabilities/${name}`)) as { permissions: unknown[] };
      expect(JSON.stringify(other.permissions)).not.toMatch(/arena-story-branch/u);
    }
  });
  it('pins the real command test handler to registered production functions and shared expiry', () => {
    const lib = read('../src-tauri/src/lib.rs');
    const production = lib.slice(lib.indexOf('tauri::generate_handler!['));
    const transport = read('../src-tauri/src/arena_story_command_pipe_tests.rs');
    const subset = transport.match(/tauri::generate_handler!\[([\s\S]*?)\]/u)![1]!.match(/\b[a-z_]+arena_story[a-z_]*\b/gu)!;
    const build = read('../src-tauri/build.rs');
    const acl = JSON.parse(read('../src-tauri/capabilities/main-ui.json')) as { permissions: string[] };
    expect(subset.length).toBeGreaterThan(4);
    for (const command of subset) {
      expect(production).toContain(command);
      expect(build).toContain(`"${command}"`);
      expect(acl.permissions).toContain(`allow-${command.replaceAll('_', '-')}`);
    }
    for (const command of Object.values(STORY_BRANCH_IPC)) expect(subset).toContain(command);
    expect(transport).toContain('get_ipc_response(');
    expect(transport).toContain('.build(tauri::generate_context!())');
    expect(lib.match(/expire_arena_story_stage\(app, begun.token.clone\(\)\)/gu)).toHaveLength(2);
    expect(lib).toContain('tokio::time::sleep(arena_story::STAGE_LIFETIME).await');
  });
  it('keeps v1 unchanged while both pages share explicit branch ports', () => {
    const port = createIpcStoryNativePort(vi.fn());
    expect(Object.keys(port).filter((key) => /branch/iu.test(key))).toEqual([]);
    expect(Object.values(STORY_IPC).filter((name) => /branch/iu.test(name))).toEqual([]);
    const page = read('../src/app/battle-page.tsx');
    expect(page).toContain('DesktopBattle()');
    expect(page).toContain('DesktopAdvancedArena()');
    expect(page).toContain('port: createIpcStoryBranchNativePort(invoke)');
    expect(page).toContain('source: createIpcStoryBranchSourcePort(invoke)');
    expect(page).toContain('storyOwner.generateBranch(');
    expect(read('../src/features/arena/story-controls.tsx')).toContain('BattleStoryBranchAction');
  });
});

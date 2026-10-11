import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createIpcStoryNativePort, STORY_IPC } from '../src/platform/arena-story-native';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
describe('branch v2 is a closed storage contract, not an enabled product capability', () => {
  it('has no branch command in build registration, generated handler or main ACL', () => {
    const build = read('../src-tauri/build.rs');
    const lib = read('../src-tauri/src/lib.rs');
    const handler = lib.slice(lib.indexOf('tauri::generate_handler!['));
    const acl = JSON.parse(read('../src-tauri/capabilities/main-ui.json')) as { permissions: string[] };
    expect(build).toContain('begin_arena_story_commit');
    expect(handler).toContain('begin_arena_story_commit');
    expect(acl.permissions).toContain('allow-begin-arena-story-commit');
    expect(build).not.toMatch(/(?:begin|end|query|save)_arena_story_branch/iu);
    expect(handler).not.toMatch(/(?:begin|end|query|save)_arena_story_branch/iu);
    expect(acl.permissions.filter((permission) => /branch/iu.test(permission))).toEqual([]);
    expect(lib).not.toMatch(/#\[tauri::command[^\]]*\][\s\S]{0,200}fn\s+\w*branch/iu);
  });
  it('keeps the actual default binder and both page owners without a branch path', () => {
    const port = createIpcStoryNativePort(vi.fn());
    expect(Object.keys(port).filter((key) => /branch/iu.test(key))).toEqual([]);
    expect(Object.values(STORY_IPC).filter((name) => /branch/iu.test(name))).toEqual([]);
    const page = read('../src/app/battle-page.tsx');
    expect(page).toContain('DesktopBattle()');
    expect(page).toContain('DesktopAdvancedArena()');
    for (const source of [page, read('../src/features/arena/story-controls.tsx'), read('../src/features/arena/story-session.ts')]) {
      expect(source).not.toMatch(/onBranch|startBranch|beginBranch|buildCompletedBattleStoryBranchRecords|desktop-arena-story-branch/u);
    }
  });
});

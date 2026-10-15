// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fixture from '@mahoshojo/contracts/fixtures/desktop-room-session.json';
import type { ArenaRoomSessionResponse } from '@mahoshojo/contracts/arena-room';
import type { ComponentProps } from 'react';
import type { StoryOptionsPanel } from '@mahoshojo/ui-web/arena';
import { DesktopRoomStoryDraft } from '../src/features/arena/room-story-draft';
import { createInitialArenaDraft, type DesktopArenaSession } from '../src/features/arena/session';
import type { DesktopArenaRoomSession, DesktopRoomState } from '../src/features/arena/room-session';
const capture = vi.hoisted(() => ({ props: null as ComponentProps<typeof StoryOptionsPanel> | null }));
vi.mock('@mahoshojo/ui-web/arena', () => ({ StoryOptionsPanel: (props: ComponentProps<typeof StoryOptionsPanel>) => { capture.props = props; return null; } }));
let root: Root, container: HTMLDivElement;
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; container = document.createElement('div'); document.body.append(container); root = createRoot(container); capture.props = null; });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function harness() {
  const authority = structuredClone(fixture.operations.create.success.result) as ArenaRoomSessionResponse;
  let room = { session: authority, phase: 'online', snapshotReceived: true, busy: false, unknown: null, configTracking: null } as DesktopRoomState;
  let local = { draft: createInitialArenaDraft(), pendingRestore: false, result: 'existing-output', draftError: null as string | null };
  let identity: symbol | null = Symbol('owner'), allowed = true, localBusy = false;
  const listeners = new Set<() => void>(); const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
  const updateDraft = vi.fn((draft: typeof local.draft) => { local = { ...local, draft }; listeners.forEach(fn => fn()); });
  const owner = { getSnapshot: () => room, subscribe, confirmationOwner: () => identity } as unknown as DesktopArenaRoomSession;
  const session = { getSnapshot: () => local, subscribe, updateDraft, isBusy: () => localBusy } as unknown as DesktopArenaSession;
  await act(async () => root.render(<DesktopRoomStoryDraft roomOwner={owner} localSession={session} languages={[]} isEditingAllowed={() => allowed} />));
  return { read: () => local, room: () => room, updateDraft,
    patch: (patch: Partial<DesktopRoomState>) => { room = { ...room, ...patch }; },
    identity: () => { identity = Symbol('replacement'); }, unauthenticated: () => { identity = null; },
    disallow: () => { allowed = false; }, localBusy: () => { localBusy = true; },
    failSave: () => { local = { ...local, draftError: '本机草稿保存失败，当前修改仅保留在内存中。' }; listeners.forEach(fn => fn()); },
    restorePending: () => { local = { ...local, pendingRestore: true }; },
  };
}
it('merges only the four local fields from the latest draft, preserving authority, bodies and output', async () => {
  const h = await harness(), before = structuredClone(h.read()), authority = structuredClone(h.room());
  const props = capture.props!;
  await act(async () => {
    props.onUserGuidanceChange('local intent');
    props.onCustomStoryLengthChange!('1600');
    props.onCustomStoryLengthChange!(''); props.onStoryLengthChange('long');
    props.onSelectedLanguageChange('en-US');
  });
  expect(h.read().draft).toEqual({ ...before.draft, settings: { ...before.draft.settings, userGuidance: 'local intent' }, customStoryLength: '', storyLength: 'long', selectedLanguage: 'en-US' });
  expect(h.read().result).toBe('existing-output'); expect(h.room()).toEqual(authority); expect(h.updateDraft).toHaveBeenCalledTimes(5);
  expect(capture.props!.afterUserGuidance).toBeUndefined(); expect(capture.props!.idPrefix).toBe('room-host-draft');
});
it.each(['busy', 'unknown', 'publishing', 'ended', 'offline', 'connecting', 'no-snapshot', 'role', 'membership', 'room', 'owner', 'logout', 'other-operation', 'local-busy', 'pending-restore'] as const)('stale callbacks cannot write after %s changes before a render', async change => {
  const h = await harness(), props = capture.props!;
  if (change === 'busy') h.patch({ busy: true });
  if (change === 'unknown') h.patch({ unknown: { operation: 'config', roomId: h.room().session!.roomId, intentId: 'unknown' } });
  if (change === 'publishing' || change === 'ended') h.patch({ configTracking: { id: 'tracking', roomId: h.room().session!.roomId, phase: change === 'ended' ? 'ended-needs-read' : 'publishing', target: null, observation: 'unobserved' } });
  if (change === 'offline' || change === 'connecting') h.patch({ phase: change });
  if (change === 'no-snapshot') h.patch({ snapshotReceived: false });
  if (change === 'role' || change === 'membership' || change === 'room') {
    const s = h.room().session!; h.patch({ session: { ...s, ...(change === 'room' ? { roomId: 'another-room' } : {}), self: { ...s.self, ...(change === 'role' ? { role: 'member' as const } : change === 'membership' ? { membershipState: 'revoked' as const } : {}) } } });
  }
  if (change === 'owner') h.identity(); if (change === 'logout') h.unauthenticated();
  if (change === 'other-operation') h.disallow(); if (change === 'local-busy') h.localBusy(); if (change === 'pending-restore') h.restorePending();
  await act(async () => { props.onUserGuidanceChange('must not write'); props.onStoryLengthChange('long'); props.onCustomStoryLengthChange!('12'); props.onSelectedLanguageChange('en-US'); });
  expect(h.updateDraft).not.toHaveBeenCalled();
});
it('retired component callbacks cannot update a still-current local session', async () => {
  const h = await harness(), props = capture.props!; await act(async () => root.render(null));
  props.onUserGuidanceChange('late'); expect(h.updateDraft).not.toHaveBeenCalled();
});

it('shows local autosave failures while the ordinary workspace is hidden', async () => {
  const h = await harness();
  await act(async () => h.failSave());
  expect(container.querySelector('[role=alert]')?.textContent).toBe(h.read().draftError);
  expect(h.updateDraft).not.toHaveBeenCalled();
});

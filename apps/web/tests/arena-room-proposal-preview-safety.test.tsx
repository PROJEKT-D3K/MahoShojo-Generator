// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoomProposalArenaEditorSession } from '@/components/arena/editor';
import { ArenaRoomProposalWorkspaceView } from '@/components/arena/multiplayer/ArenaRoomProposalWorkspace';
import { buildArenaRoomState, closeArenaWorkspaceDom, createArenaWorkspaceQueries, openArenaWorkspaceDom, sharedConfig } from './helpers/arena-room-proposal-workspace';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('@/lib/config', () => ({ config: { ENABLE_ARENA_USER_GUIDANCE: true } }));
vi.mock('@/components/arena/hooks/useArenaData', () => ({ useLanguagesQuery: () => ({ data: [{ code: 'zh-CN', name: '简体中文' }] }) }));

const { button, buttonsWithText } = createArenaWorkspaceQueries();
const controller = () => ({ submitProposal: vi.fn(async () => undefined), withdrawProposal: vi.fn(async () => undefined), endProposalTracking: vi.fn(), reconnect: vi.fn() });
let dom: ReturnType<typeof openArenaWorkspaceDom>;
beforeEach(() => { dom = openArenaWorkspaceDom(); });
afterEach(async () => { await closeArenaWorkspaceDom(dom.container, dom.root); });

const makeEditor = () => createRoomProposalArenaEditorSession({ roomId: 'room-1', roomEpoch: 'epoch-1', revision: 7, sharedConfig });

describe('member proposal preview confirmation safety', () => {
  it('does not submit recomputed content under the same change ID after the editor changed', async () => {
    const editor = makeEditor(), host = controller(), state = buildArenaRoomState();
    editor.update(draft => ({ ...draft, userGuidance: '预览中明确看过的 A' }));
    const originalChanges = editor.preview().changes;
    await act(async () => dom.root.render(<ArenaRoomProposalWorkspaceView editor={editor} state={state} controller={host} />));
    await act(async () => button('预览提案').click());
    expect(document.body.textContent).toContain('预览中明确看过的 A');
    await act(async () => editor.update(draft => ({ ...draft, userGuidance: '预览后才变化的 B' })));
    expect(editor.preview().changes[0]!.changeId).toBe(originalChanges[0]!.changeId);
    await act(async () => buttonsWithText('提交提案')[0]?.click());
    expect(host.submitProposal).not.toHaveBeenCalled();
    expect(editor.exportSharedConfig()).toMatchObject({ userGuidance: '预览后才变化的 B' });
    await act(async () => editor.dispose());
  });

  it('does not transfer an old preview confirmation to a replacement host controller', async () => {
    const editor = makeEditor(), oldHost = controller(), newHost = controller(), state = buildArenaRoomState();
    editor.update(draft => ({ ...draft, userGuidance: '原宿主预览' }));
    await act(async () => dom.root.render(<ArenaRoomProposalWorkspaceView editor={editor} state={state} controller={oldHost} />));
    await act(async () => button('预览提案').click());
    await act(async () => dom.root.render(<ArenaRoomProposalWorkspaceView editor={editor} state={state} controller={newHost} />));
    await act(async () => buttonsWithText('提交提案')[0]?.click());
    expect(oldHost.submitProposal).not.toHaveBeenCalled();
    expect(newHost.submitProposal).not.toHaveBeenCalled();
    await act(async () => editor.dispose());
  });
});

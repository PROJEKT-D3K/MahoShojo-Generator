// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArenaRoomSessionResponse, ArenaRoomSharedConfig, DataCardRef } from '@mahoshojo/contracts/arena-room';
import { createArenaMemberProposalModel } from '@mahoshojo/multiplayer-core/member-proposal';
import { RoomMemberProposalWorkspace, type RoomMemberProposalWorkspaceProps, type ArenaMemberSourcePickerProps } from '../src/arena-room';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const config = (): ArenaRoomSharedConfig => ({ battleMode: 'classic', reportFormat: 'markdown', combatants: [], teams: [], scenario: null, auxScenarios: [], materials: [],
  userGuidance: '', storyLength: 'default', customStoryLength: null, selectedLanguage: 'zh-CN', historySettings: {
    readArenaHistory: true, readArenaHistoryLimit: 3, isArenaHistoryUnlimited: false, writeArenaHistory: true,
    readCurrentState: true, writeCurrentState: true, readNarrativeHistory: false, readNarrativeHistoryLimit: 10,
    isNarrativeHistoryUnlimited: false, writeNarrativeHistory: false } });
const session = (): ArenaRoomSessionResponse => {
  const self = { userId: 'member-1', role: 'member' as const, displayName: '成员', membershipState: 'active' as const };
  return { protocolVersion: 1, roomId: 'room-1', roomEpoch: 'epoch-1', self, snapshot: { protocolVersion: 1, schemaVersion: 1,
    roomId: 'room-1', roomEpoch: 'epoch-1', revision: 7, controlSeq: 0, sharedConfig: config(), members: [self], proposals: [], activeGeneration: null } };
};
const ref: DataCardRef = { id: 'public-character', kind: 'character', versionToken: 'observation-v2' };
const button = (label: string) => {
  const found = [...document.body.querySelectorAll('button')].find(item => item.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`); return found;
};
let container: HTMLDivElement, root: Root, picker: ArenaMemberSourcePickerProps | undefined;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); picker = undefined; });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const fixture = () => {
  const authority = session();
  const model = createArenaMemberProposalModel({ roomId: authority.roomId, roomEpoch: authority.roomEpoch, revision: 7, sharedConfig: authority.snapshot.sharedConfig });
  const props: RoomMemberProposalWorkspaceProps = { model, scopeIdentity: {}, room: { session: authority, operation: null, resultUnknown: false },
    host: { SourcePicker: props => { picker = props; return null; }, ReferenceDetails: () => null,
      randomPublicCharacter: vi.fn(async () => ref), resolveReferenceName: request => request.id, enableUserGuidance: true,
      createId: () => 'stable-test-id', languages: [{ code: 'zh-CN', name: '简体中文' }],
      presetDownloadHref: (_, id) => `/preset/${id}`, downloadBuiltinWebPackage: vi.fn(async () => undefined), webConsent: { accepted: false, onAccept: vi.fn() } },
    actions: { submit: vi.fn(async () => undefined), withdraw: vi.fn(async () => undefined), read: vi.fn(), endTracking: vi.fn(), sync: vi.fn() } };
  const render = async (next = props) => { await act(async () => root.render(<RoomMemberProposalWorkspace {...next} />)); };
  return { model, props, render };
};

describe('controlled full member proposal workspace', () => {
  it('renders shared Arena controls without editing through transport or ordinary persistence', async () => {
    const { model, props, render } = fixture(); await render();
    expect(document.body.textContent).toContain('选择预设魔法少女'); expect(document.body.textContent).toContain('选择预设残兽');
    expect(document.body.textContent).toContain('竞技场提案编辑模式'); expect(document.body.textContent).toContain('本地编辑不联网');
    await act(async () => model.actions.setUserGuidance('独立成员草稿'));
    expect(props.actions.submit).not.toHaveBeenCalled(); expect(props.actions.read).not.toHaveBeenCalled();
    expect(props.room.session!.snapshot.sharedConfig.userGuidance).toBe('');
  });

  it('submits exactly the reviewed immutable intent once', async () => {
    const { model, props, render } = fixture(); model.actions.setUserGuidance('已经确认的文本'); await render();
    await act(async () => button('预览提案').click()); expect(document.body.textContent).toContain('已经确认的文本');
    const submit = button('提交提案'); await act(async () => { submit.click(); submit.click(); });
    expect(props.actions.submit).toHaveBeenCalledTimes(1);
    const intent = vi.mocked(props.actions.submit).mock.calls[0]![0];
    expect(intent).toMatchObject({ proposalId: 'proposal-stable-test-id', baseRevision: 7, expectedRoomEpoch: 'epoch-1', changes: [expect.objectContaining({ value: '已经确认的文本' })] });
    expect(Object.isFrozen(intent)).toBe(true); expect(Object.isFrozen(intent.changes[0])).toBe(true);
  });

  it.each(['edit', 'scope', 'model'] as const)('expires old preview after %s replacement', async change => {
    const { model, props, render } = fixture(); model.actions.setUserGuidance('原预览'); await render(); await act(async () => button('预览提案').click());
    const oldSubmit = button('提交提案');
    if (change === 'edit') await act(async () => model.actions.setUserGuidance('新内容'));
    else if (change === 'scope') await render({ ...props, scopeIdentity: {} });
    else await render({ ...props, model: fixture().model });
    await act(async () => oldSubmit.click()); expect(props.actions.submit).not.toHaveBeenCalled();
  });

  it.each(['edit', 'scope', 'role'] as const)('drops asynchronous public source result after %s changes', async change => {
    const { model, props, render } = fixture(); let resolve!: (value: DataCardRef) => void;
    Object.assign(props.host, { randomPublicCharacter: vi.fn(() => new Promise<DataCardRef>(done => { resolve = done; })) });
    await render(); await act(async () => button('随机匹配角色').click());
    if (change === 'edit') await act(async () => model.actions.setUserGuidance('加载期间的修改'));
    else if (change === 'scope') await render({ ...props, scopeIdentity: {} });
    else await render({ ...props, room: { ...props.room, session: { ...props.room.session!, self: { ...props.room.session!.self, role: 'host' } } } });
    await act(async () => resolve(ref)); expect(model.exportSharedConfig().combatants).toEqual([]); expect(props.actions.submit).not.toHaveBeenCalled();
  });

  it('invalidates a preview when a current asynchronous source result arrives', async () => {
    const { model, props, render } = fixture(); let resolve!: (value: DataCardRef) => void;
    Object.assign(props.host, { randomPublicCharacter: vi.fn(() => new Promise<DataCardRef>(done => { resolve = done; })) });
    model.actions.setUserGuidance('预览'); await render(); await act(async () => button('随机匹配角色').click());
    await act(async () => button('预览提案').click()); const oldSubmit = button('提交提案');
    await act(async () => resolve(ref)); await act(async () => oldSubmit.click());
    expect(props.actions.submit).not.toHaveBeenCalled(); expect(model.exportSharedConfig().combatants[0]).toMatchObject({ ref });
  });

  it('fences stale source-picker callbacks across editor and scope changes', async () => {
    const { model, props, render } = fixture(); await render(); await act(async () => button('浏览在线角色库').click());
    const oldPicker = picker!; expect(oldPicker.open).toBe(true);
    await act(async () => model.actions.setUserGuidance('changed')); await act(async () => oldPicker.onSelect(ref));
    expect(model.exportSharedConfig().combatants).toEqual([]);
    const scopedPicker = picker!; await render({ ...props, scopeIdentity: {} }); await act(async () => scopedPicker.onSelect(ref));
    expect(model.exportSharedConfig().combatants).toEqual([]);
  });

  it('keeps unknown and ended tracking blocked until the host supplies a fresh read', async () => {
    const { model, props, render } = fixture(); model.actions.setUserGuidance('留存意图');
    const unknown = { ...props, room: { ...props.room, resultUnknown: true, tracking: { id: 'tracked', phase: 'unknown' as const } } };
    await render(unknown); expect(button('预览提案').disabled).toBe(true);
    await act(async () => button('结束本机跟踪（不取消服务器操作）').click()); expect(props.actions.endTracking).toHaveBeenCalledExactlyOnceWith('tracked');
    await render({ ...props, room: { ...props.room, tracking: { id: 'tracked', phase: 'ended-needs-read' } } });
    expect(button('预览提案').disabled).toBe(true); await act(async () => button('重新连接并对账').click()); expect(props.actions.read).toHaveBeenCalledTimes(1);
    expect(props.actions.submit).not.toHaveBeenCalled(); expect(model.exportSharedConfig().userGuidance).toBe('留存意图');
    await render(props); expect(button('预览提案').disabled).toBe(false);
  });

  it('retains a transport-blocked draft and disables writes without inventing an unknown request', async () => {
    const { model, props, render } = fixture(); model.actions.setUserGuidance('offline retained draft'); await render();
    await act(async () => button('预览提案').click()); const submit = button('提交提案');
    await render({ ...props, room: { ...props.room, blockedReason: '等待当前连接的完整房间快照；提案草稿仍保留。' } });
    expect(document.body.textContent).toContain('等待当前连接的完整房间快照');
    expect(document.body.textContent).not.toContain('上次提案请求结果未知');
    expect(button('预览提案').disabled).toBe(true); expect(button('同步配置').disabled).toBe(true);
    await act(async () => submit.click()); expect(props.actions.submit).not.toHaveBeenCalled(); expect(props.actions.sync).not.toHaveBeenCalled();
    expect(model.exportSharedConfig().userGuidance).toBe('offline retained draft');
    await render(props); expect(button('预览提案').disabled).toBe(false);
  });

  it('only offers withdrawal for the current member pending proposal and blocks it while unknown', async () => {
    const { model, props, render } = fixture(); model.actions.setUserGuidance('pending');
    const intent = model.preparePreview('mine').intent!;
    const proposal = { proposalVersion: 1 as const, proposalId: 'mine', roomId: 'room-1', authorUserId: 'member-1',
      baseRevision: 7, status: 'submitted' as const, createdAt: '2026-10-15T12:00:00Z', changes: intent.changes };
    const authority = { ...props.room.session!, snapshot: { ...props.room.session!.snapshot, proposals: [proposal,
      { ...proposal, proposalId: 'other', authorUserId: 'other-member' }, { ...proposal, proposalId: 'done', status: 'withdrawn' as const }] } };
    const current = { ...props, room: { ...props.room, session: authority } };
    await render(current);
    expect([...document.body.querySelectorAll('button')].filter(item => item.textContent === '撤回提案')).toHaveLength(1);
    await act(async () => button('撤回提案').click()); expect(props.actions.withdraw).toHaveBeenCalledExactlyOnceWith('mine');
    await render({ ...current, room: { ...current.room, resultUnknown: true } });
    expect(button('撤回提案').disabled).toBe(true); await act(async () => button('撤回提案').click());
    expect(props.actions.withdraw).toHaveBeenCalledTimes(1);
  });

  it('requires confirmation before syncing a dirty member draft', async () => {
    const { model, props, render } = fixture(); model.actions.setUserGuidance('must retain'); await render();
    await act(async () => button('同步配置').click()); expect(props.actions.sync).not.toHaveBeenCalled();
    await act(async () => button('保留草稿').click()); expect(model.exportSharedConfig().userGuidance).toBe('must retain');
    await act(async () => button('同步配置').click()); await act(async () => button('确认丢弃并同步').click());
    expect(props.actions.sync).toHaveBeenCalledTimes(1);
  });


  it('does not let an old pending source request lock a replacement owner', async () => {
    const { model, props, render } = fixture(); let resolveOld!: (value: DataCardRef) => void;
    const random = vi.fn().mockImplementationOnce(() => new Promise<DataCardRef>(done => { resolveOld = done; })).mockResolvedValueOnce(ref);
    Object.assign(props.host, { randomPublicCharacter: random }); await render();
    await act(async () => button('随机匹配角色').click());
    await render({ ...props, scopeIdentity: {} });
    await act(async () => button('随机匹配角色').click());
    expect(random).toHaveBeenCalledTimes(2); expect(model.exportSharedConfig().combatants[0]).toMatchObject({ ref });
    await act(async () => resolveOld({ ...ref, id: 'old-owner-result' }));
    expect(model.exportSharedConfig().combatants).toHaveLength(1);
  });


  it('does not revive a closed source picker callback when the same picker reopens', async () => {
    const { model, render } = fixture(); await render(); await act(async () => button('浏览在线角色库').click());
    const previous = picker!; await act(async () => previous.onClose());
    await act(async () => button('浏览在线角色库').click());
    await act(async () => previous.onSelect(ref)); expect(model.exportSharedConfig().combatants).toEqual([]);
    await act(async () => picker!.onSelect(ref)); expect(model.exportSharedConfig().combatants[0]).toMatchObject({ ref });
  });


  it('keeps the room-specific 32-character budget explicit on shared source controls', async () => {
    const { model, render } = fixture();
    model.update(draft => ({ ...draft, combatants: Array.from({ length: 32 }, (_, index) => ({ key: `data-card:c${index}`,
      ref: { id: `c${index}`, kind: 'character' as const, versionToken: 'observed' } })) }));
    await render(); expect(button('浏览在线角色库').disabled).toBe(true); expect(button('随机匹配角色').disabled).toBe(true);
  });

});

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fixture from '@mahoshojo/contracts/fixtures/desktop-room-session.json';
import type { ArenaProposal, ArenaRoomSessionResponse } from '@mahoshojo/contracts/arena-room';
import { RoomProposalHostReview, type RoomProposalHostReviewProps } from '../src/arena-room';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const propsFor = (conflict = true): RoomProposalHostReviewProps => {
  const session = structuredClone(fixture.operations.create.success.result) as ArenaRoomSessionResponse;
  const config = { ...session.snapshot.sharedConfig, userGuidance: conflict ? '当前 C' : '基准 A' };
  const proposal: ArenaProposal = {
    proposalVersion: 1, proposalId: 'proposal-review', roomId: session.roomId, authorUserId: session.self.userId,
    baseRevision: 0, status: 'submitted', createdAt: '2026-10-15T12:00:00Z',
    changes: [{ changeId: 'guidance', type: 'setUserGuidance', expectedBase: { kind: 'value', value: '基准 A' }, value: '提案 B' }],
  };
  return { proposal, roomId: session.roomId, roomEpoch: session.roomEpoch, revision: 1,
    currentConfig: config, authorDisplayName: '成员名字', disabled: false, onResolve: vi.fn(async () => undefined) };
};
const render = async (props: RoomProposalHostReviewProps) => {
  await act(async () => root.render(<ul><RoomProposalHostReview {...props} /></ul>));
};
const button = (text: string): HTMLButtonElement => {
  const result = [...container.querySelectorAll('button')].find(item => item.textContent === text);
  expect(result, text).toBeTruthy();
  return result!;
};
const click = async (text: string) => { await act(async () => button(text).click()); };
const checkbox = (index = 0) => container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[index]!;

it('shares the full three-way conflict review without HTML injection, fetching or implicit resolution', async () => {
  const props = propsFor();
  const text = `<img src=x>${'完整提案文字'.repeat(25)}末尾`;
  props.proposal.changes = [{ changeId: 'guidance', type: 'setUserGuidance',
    expectedBase: { kind: 'value', value: '基准 A' }, value: text }];
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await render(props);
  expect(container.textContent).toContain('成员名字 提出了 1 项修改');
  expect(container.querySelector('dl')?.textContent).toContain('提案基准：基准 A');
  expect(container.querySelector('dl')?.textContent).toContain('当前房间值：当前 C');
  expect(container.querySelector('dl')?.textContent).toContain(text);
  expect(container.querySelector('img')).toBeNull();
  expect(button('接受所选').disabled).toBe(true);
  expect(props.onResolve).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  await click('采用提案值');
  expect(props.onResolve).not.toHaveBeenCalled();
  await click('接受所选');
  expect(props.onResolve).toHaveBeenCalledExactlyOnceWith('proposal-review', {
    expectedRoomEpoch: props.roomEpoch, expectedRevision: 1, resolution: 'accept-selected',
    selectedChangeIds: ['guidance'], overrideChangeIds: ['guidance'],
  });
});

it('ordinary merges preserve target-base semantics after unrelated revisions and omit empty override fields', async () => {
  const props = propsFor(false);
  await render({ ...props, revision: 8 });
  expect(button('接受所选').disabled).toBe(false);
  await click('接受所选');
  expect(props.onResolve).toHaveBeenCalledWith('proposal-review', {
    expectedRoomEpoch: props.roomEpoch, expectedRevision: 8, resolution: 'accept-selected', selectedChangeIds: ['guidance'],
  });
});

it('keeps the current value by deselecting its change while allowing the ordinary remainder', async () => {
  const props = propsFor();
  props.proposal.changes.push({ changeId: 'language', type: 'setSelectedLanguage', value: 'en-US',
    expectedBase: { kind: 'value', value: props.currentConfig.selectedLanguage } });
  await render(props);
  await click('保留当前值');
  expect(checkbox().checked).toBe(false);
  await click('接受所选');
  expect(props.onResolve).toHaveBeenCalledWith('proposal-review', expect.objectContaining({ selectedChangeIds: ['language'] }));
  expect(vi.mocked(props.onResolve).mock.calls[0]![1]).not.toHaveProperty('overrideChangeIds');
});

it.each(['revision', 'epoch', 'proposal', 'identity'] as const)('expires override consent when %s changes and never revives it on return', async scope => {
  const props = { ...propsFor(), reviewIdentity: Symbol('owner') };
  await render(props); await click('采用提案值');
  const next = scope === 'revision' ? { ...props, revision: 2 }
    : scope === 'epoch' ? { ...props, roomEpoch: 'next-epoch' }
      : scope === 'identity' ? { ...props, reviewIdentity: Symbol('new-owner') }
        : { ...props, proposal: { ...props.proposal, changes: [{ changeId: 'guidance', type: 'setUserGuidance' as const,
          expectedBase: { kind: 'value' as const, value: '基准 A' }, value: '另一份目标' }] } };
  await render(next);
  expect(container.textContent).toContain('请重新确认覆盖项');
  expect(button('采用提案值').getAttribute('aria-pressed')).toBe('false');
  expect(button('接受所选').disabled).toBe(true);
  await render(props);
  expect(button('采用提案值').getAttribute('aria-pressed')).toBe('false');
  expect(button('接受所选').disabled).toBe(true);
  expect(props.onResolve).not.toHaveBeenCalled();
});

it('requires fresh consent after revision advancement and sends the new exact reviewed revision', async () => {
  const props = propsFor(); await render(props); await click('采用提案值');
  await render({ ...props, revision: 9, currentConfig: { ...props.currentConfig, userGuidance: '当前 D' } });
  expect(container.querySelector('dl')?.textContent).toContain('当前 D');
  await click('采用提案值'); await click('接受所选');
  expect(props.onResolve).toHaveBeenCalledWith('proposal-review', expect.objectContaining({ expectedRevision: 9, overrideChangeIds: ['guidance'] }));
});

it('does not expire consent on equal proposal snapshots or unrelated display labels', async () => {
  const props = propsFor(); await render(props); await click('采用提案值');
  await render({ ...props, proposal: structuredClone(props.proposal), labels: { language: () => '新的显示名' } });
  expect(button('采用提案值').getAttribute('aria-pressed')).toBe('true');
  expect(button('接受所选').disabled).toBe(false);
});

it('deselecting and reselecting cannot restore prior override consent', async () => {
  const props = propsFor(); await render(props); await click('采用提案值');
  await act(async () => checkbox().click()); await act(async () => checkbox().click());
  expect(button('采用提案值').getAttribute('aria-pressed')).toBe('false');
  expect(button('接受所选').disabled).toBe(true);
});

it.each(['dependsOn', 'atomicGroupId'] as const)('keeps core %s selection closure', async kind => {
  const props = propsFor(false);
  props.proposal.changes.push({ changeId: 'language', type: 'setSelectedLanguage', value: 'en-US',
    expectedBase: { kind: 'value', value: props.currentConfig.selectedLanguage },
    ...(kind === 'dependsOn' ? { dependsOn: ['guidance'] } : { atomicGroupId: 'linked' }),
  });
  if (kind === 'atomicGroupId') props.proposal.changes[0]!.atomicGroupId = 'linked';
  await render(props);
  expect(button('接受所选').disabled).toBe(false);
  await act(async () => checkbox().click());
  expect(container.textContent).toContain('所选变更缺少依赖或拆分了联动变更组');
  expect(button('接受所选').disabled).toBe(true);
  await click('接受所选'); expect(props.onResolve).not.toHaveBeenCalled();
});

it('stages dependent expectedBase values and marks already-satisfied targets without changing input', async () => {
  const props = propsFor(false);
  props.proposal.changes.push({ changeId: 'dependent', type: 'setUserGuidance', value: '提案 B',
    expectedBase: { kind: 'value', value: '基准 A' }, dependsOn: ['guidance'] });
  const before = structuredClone({ proposal: props.proposal, config: props.currentConfig });
  await render(props);
  expect(container.querySelector('[data-change-outcome="satisfied"]')?.textContent).toContain('将自动跳过');
  expect(button('接受所选').disabled).toBe(false);
  expect(props.proposal).toEqual(before.proposal); expect(props.currentConfig).toEqual(before.config);
});

it('shows non-overridable missing targets without an adopt button', async () => {
  const props = propsFor();
  props.proposal.changes = [{ changeId: 'missing', type: 'setCharacterGuidance', combatantKey: 'data-card:absent-character',
    expectedBase: { kind: 'value', value: '旧引导' }, value: '新引导' }];
  await render(props);
  expect(container.textContent).toContain('目标角色或队伍已不存在');
  expect([...container.querySelectorAll('button')].some(item => item.textContent === '采用提案值')).toBe(false);
  expect(button('接受所选').disabled).toBe(true);
});

it('rejects the whole proposal without any selected or override IDs', async () => {
  const props = propsFor(); await render(props); await click('采用提案值'); await click('拒绝全部');
  expect(props.onResolve).toHaveBeenCalledWith('proposal-review', {
    expectedRoomEpoch: props.roomEpoch, expectedRevision: props.revision, resolution: 'reject',
  });
});

it('blocks all write controls while the host reports disabled and never calls back on unmount', async () => {
  const props = propsFor(); await render({ ...props, disabled: true });
  expect([...container.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')].every(item => item.disabled)).toBe(true);
  await click('保留当前值'); await click('采用提案值'); await click('拒绝全部');
  expect(checkbox().checked).toBe(true);
  await act(async () => root.render(null));
  expect(props.onResolve).not.toHaveBeenCalled();
});

it('holds a local action lock and shows callback failure without automatic replay', async () => {
  const props = propsFor(false);
  let reject!: (error: Error) => void;
  const onResolve = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  await render({ ...props, onResolve });
  await act(async () => { button('接受所选').click(); button('接受所选').click(); button('拒绝全部').click(); });
  expect(onResolve).toHaveBeenCalledOnce();
  await act(async () => reject(new Error('unknown result')));
  expect(container.textContent).toContain('审阅未完成，请核对房间最新状态');
  expect(onResolve).toHaveBeenCalledOnce();
});

it('uses host-provided reference and language labels without resolving them itself', async () => {
  const props = propsFor(false);
  props.proposal.changes = [{ changeId: 'language', type: 'setSelectedLanguage', value: 'en-US',
    expectedBase: { kind: 'value', value: props.currentConfig.selectedLanguage } }];
  props.proposal.changes.push({ changeId: 'character', type: 'addCombatant', key: 'data-card:host-label-card',
    ref: { kind: 'character', id: 'host-label-card', versionToken: 'v1' }, expectedBase: { kind: 'absent' } });
  await render({ ...props, labels: { language: value => value === 'en-US' ? 'English' : undefined, ref: () => '在线:已解析角色' } });
  expect(checkbox().getAttribute('aria-label')).toBe('接受变更：语言改为 English');
  expect(checkbox(1).getAttribute('aria-label')).toBe('接受变更：新增角色 在线:已解析角色');
});

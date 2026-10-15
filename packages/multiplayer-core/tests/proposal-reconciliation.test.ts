import { describe, expect, it } from 'vitest';
import fixture from '@mahoshojo/contracts/fixtures/desktop-room-session.json';
import type { ArenaProposal, ArenaRoomSnapshot, ControlRoomEvent, ResolvedArenaProposalStatus } from '@mahoshojo/contracts/arena-room';
import {
  createArenaRoomProposalReconciliationTarget as createTarget,
  observeArenaRoomProposalReconciliation as observe,
  type ArenaRoomProposalReconciliationTarget,
} from '../src';
import { guidanceChange, proposal } from './state-machine-fixtures';

const scope = { roomId: 'room-1', roomEpoch: 'epoch-1', selfUserId: 'member-1' };
const pending = (): ArenaProposal => ({ ...proposal([]), changes: [guidanceChange(), { ...guidanceChange('second'), changeId: 'guidance-2' }] });
const submit = () => createTarget({ ...scope, operation: 'submit', request: {
  expectedRoomEpoch: scope.roomEpoch, proposalId: 'proposal-1', baseRevision: 0, changes: pending().changes,
} });
const resolve = (resolution: 'accept-selected' | 'reject', selectedChangeIds?: string[]) => createTarget({
  ...scope, operation: 'resolve', proposalId: 'proposal-1', pendingProposal: pending(),
  request: { expectedRoomEpoch: scope.roomEpoch, resolution, selectedChangeIds },
});
const withdraw = () => createTarget({ ...scope, operation: 'withdraw', proposalId: 'proposal-1', pendingProposal: pending(), request: { expectedRoomEpoch: scope.roomEpoch } });
const event = (status: ResolvedArenaProposalStatus, proposalId = 'proposal-1'): ControlRoomEvent => ({
  protocolVersion: 1, type: 'proposal.resolved', roomId: scope.roomId, roomEpoch: scope.roomEpoch,
  controlSeq: 1, timestamp: '2026-08-27T16:01:00.000Z', payload: { proposalId, status },
});
const statuses: ResolvedArenaProposalStatus[] = ['accepted', 'partially_accepted', 'rejected', 'withdrawn', 'stale'];

describe('proposal reconciliation observes business state without claiming POST delivery', () => {
  it('freezes a deep copy of intent, including request selection and original proposal', () => {
    const p = pending();
    const ids = ['guidance-1'];
    const target = createTarget({ ...scope, operation: 'resolve', proposalId: p.proposalId, pendingProposal: p,
      request: { expectedRoomEpoch: scope.roomEpoch, resolution: 'accept-selected', selectedChangeIds: ids } });
    p.changes.reverse(); ids.push('guidance-2');
    expect(target.identity!.changes[0].changeId).toBe('guidance-1');
    expect(target.selectedChangeIds).toEqual(['guidance-1']);
    expect(Object.isFrozen(target.identity!.changes[0])).toBe(true);
  });
  it('retains the entire original resolve request, including override revision and IDs', () => {
    const request = { expectedRoomEpoch: scope.roomEpoch, resolution: 'accept-selected' as const,
      expectedRevision: 7, selectedChangeIds: ['guidance-1'], overrideChangeIds: ['guidance-1'] };
    const target = createTarget({ ...scope, operation: 'resolve', proposalId: 'proposal-1', pendingProposal: pending(), request });
    const original = structuredClone(request);
    request.expectedRevision = 99;
    request.overrideChangeIds.push('guidance-2');
    request.selectedChangeIds.reverse();
    expect(target.request).toEqual(original);
    expect(Object.isFrozen(target.request)).toBe(true);
    expect(Object.isFrozen((target.request as typeof request).overrideChangeIds)).toBe(true);
  });
  it('retains independent original submit and withdraw requests', () => {
    const submitRequest = { expectedRoomEpoch: scope.roomEpoch, proposalId: 'proposal-1', baseRevision: 0, changes: pending().changes };
    const submitTarget = createTarget({ ...scope, operation: 'submit', request: submitRequest });
    const originalSubmit = structuredClone(submitRequest);
    submitRequest.changes.reverse(); submitRequest.baseRevision = 42;
    expect(submitTarget.request).toEqual(originalSubmit);
    const withdrawRequest = { expectedRoomEpoch: scope.roomEpoch };
    const withdrawTarget = createTarget({ ...scope, operation: 'withdraw', proposalId: 'proposal-1', pendingProposal: pending(), request: withdrawRequest });
    withdrawRequest.expectedRoomEpoch = 'other';
    expect(withdrawTarget.request).toEqual({ expectedRoomEpoch: scope.roomEpoch });
  });
  it('matches full submit identity ignoring server timestamps and object key order', () => {
    const p = pending(); p.createdAt = '2026-10-01T00:00:00.000Z'; p.updatedAt = p.createdAt;
    p.changes[0] = { expectedBase: { value: '', kind: 'value' }, value: '成员建议', type: 'setUserGuidance', changeId: 'guidance-1' };
    expect(observe(submit(), { ...scope, proposals: [p] })).toMatchObject({ observation: 'submitted', settle: true, linked: true, outcome: 'satisfied' });
  });
  it.each(['author', 'revision', 'changes', 'order', 'room', 'version'])('does not match same ID with different %s', field => {
    const p = pending();
    if (field === 'author') p.authorUserId = 'another';
    if (field === 'revision') p.baseRevision++;
    if (field === 'changes') p.changes[0] = guidanceChange('different');
    if (field === 'order') p.changes.reverse();
    if (field === 'room') p.roomId = 'another';
    if (field === 'version') Object.assign(p, { proposalVersion: 2 });
    expect(observe(submit(), { ...scope, proposals: [p] }, true)).toMatchObject({ observation: 'conflict', settle: false, linked: false });
  });
  it('requires prior exact submit evidence before trusting ID-only terminal', () => {
    const target = submit();
    expect(observe(target, { ...scope, event: event('accepted') })).toMatchObject({ settle: false, linked: false });
    const linked = observe(target, { ...scope, proposals: [pending()] }).linked;
    expect(observe(target, { ...scope, event: event('accepted') }, linked)).toMatchObject({ settle: true, outcome: 'satisfied', terminalStatus: 'accepted' });
  });
  it.each(statuses)('full terminal %s links submit and reports actual lifecycle', status => {
    expect(observe(submit(), { ...scope, proposals: [{ ...pending(), status }] })).toMatchObject({ settle: true, outcome: 'satisfied', terminalStatus: status });
  });
  it.each(statuses)('withdraw/reject lifecycle %s ends tracking even when intent differs', status => {
    expect(observe(withdraw(), { ...scope, event: event(status) })).toMatchObject({ settle: true, terminalStatus: status, outcome: status === 'withdrawn' ? 'satisfied' : 'different' });
    expect(observe(resolve('reject'), { ...scope, event: event(status) })).toMatchObject({ settle: true, terminalStatus: status, outcome: status === 'rejected' ? 'satisfied' : 'different' });
  });
  it.each(([undefined, ['guidance-1', 'guidance-2'], ['guidance-1']] as (string[] | undefined)[]).map(ids => [ids] as const))('reports acceptance without inventing selected scope (%j)', ids => {
    for (const status of statuses) {
      const outcome = status === 'partially_accepted' ? 'scope-unverified'
        : status === 'accepted' && (ids === undefined || ids.length === 2) ? 'satisfied' : 'different';
      expect(observe(resolve('accept-selected', ids), { ...scope, event: event(status) })).toMatchObject({ settle: true, outcome, terminalStatus: status });
    }
  });
  it('missing and pending authority never end resolve/withdraw tracking', () => {
    for (const target of [withdraw(), resolve('reject'), resolve('accept-selected')]) {
      expect(observe(target, { ...scope, proposals: [] })).toMatchObject({ observation: 'absent', settle: false });
      expect(observe(target, { ...scope, proposals: [pending()] })).toMatchObject({ observation: 'pending', settle: false });
      expect(observe(target, { ...scope, event: event('accepted', 'unrelated') }).settle).toBe(false);
    }
  });
  it.each(['roomId', 'roomEpoch', 'selfUserId'] as const)('scope change in %s invalidates linkage', key => {
    expect(observe(withdraw(), { ...scope, [key]: 'different', event: event('withdrawn') })).toMatchObject({ observation: 'scope-changed', linked: false, settle: false });
  });
  it('checks event scope independently', () => {
    expect(observe(withdraw(), { ...scope, event: { ...event('withdrawn'), roomEpoch: 'new' } })).toMatchObject({ observation: 'scope-changed', linked: false, settle: false });
  });
  it('same-ID updated content invalidates prior association until exact evidence reappears', () => {
    const target = withdraw();
    const updated: ControlRoomEvent = { ...event('withdrawn'), type: 'proposal.updated', payload: { proposal: { ...pending(), authorUserId: 'other' } } };
    const conflict = observe(target, { ...scope, event: updated });
    expect(conflict).toMatchObject({ observation: 'conflict', linked: false, settle: false });
    expect(observe(target, { ...scope, event: event('withdrawn') }, conflict.linked).settle).toBe(false);
    const exact = observe(target, { ...scope, proposals: [pending()] }, conflict.linked);
    expect(observe(target, { ...scope, event: event('withdrawn') }, exact.linked).settle).toBe(true);
  });
  it('conflicting full evidence wins over an ID-only terminal in the same observation', () => {
    expect(observe(withdraw(), { ...scope, proposals: [{ ...pending(), baseRevision: 99 }], event: event('withdrawn') })).toMatchObject({ observation: 'conflict', linked: false, settle: false });
  });
  it.each([null, { ...pending(), status: 'accepted' as const }, { ...pending(), roomId: 'other' }, { ...pending(), proposalId: 'other' }])('cannot reconstruct missing original pending evidence from later observations', pendingProposal => {
    const target = createTarget({ ...scope, operation: 'withdraw', proposalId: 'proposal-1', pendingProposal, request: { expectedRoomEpoch: scope.roomEpoch } });
    expect(observe(target, { ...scope, proposals: [pending()], event: event('withdrawn') })).toMatchObject({ observation: 'target-unavailable', settle: false });
  });
  it('GET, room snapshot and full proposal events use the same identity rules', () => {
    const target = submit();
    const p = pending();
    const expected = observe(target, { ...scope, proposals: [p] });
    const snapshot = structuredClone(fixture.operations.create.success.result.snapshot) as ArenaRoomSnapshot;
    snapshot.proposals = [p];
    const snapshotEvent: ControlRoomEvent = { ...event('accepted'), type: 'room.snapshot', payload: snapshot };
    const submittedEvent: ControlRoomEvent = { ...event('accepted'), type: 'proposal.submitted', payload: { proposal: p } };
    const updatedEvent: ControlRoomEvent = { ...event('accepted'), type: 'proposal.updated', payload: { proposal: p } };
    for (const fullEvent of [snapshotEvent, submittedEvent, updatedEvent]) {
      expect(observe(target, { ...scope, event: fullEvent })).toEqual(expected);
    }
  });
  it('does not mutate frozen target or observation evidence', () => {
    const target: ArenaRoomProposalReconciliationTarget = submit();
    const evidence = { ...scope, proposals: [pending()] };
    const before = structuredClone({ target, evidence });
    observe(target, evidence);
    expect({ target, evidence }).toEqual(before);
  });
});

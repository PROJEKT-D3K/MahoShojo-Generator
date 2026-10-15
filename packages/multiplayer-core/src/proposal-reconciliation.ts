import type {
  ArenaProposal,
  ArenaRoomProposalResolveRequest,
  ArenaRoomProposalSubmitRequest,
  ArenaRoomProposalWithdrawRequest,
  ControlRoomEvent,
  ResolvedArenaProposalStatus,
} from '@mahoshojo/contracts/arena-room';
import { PROPOSAL_VERSION } from '@mahoshojo/contracts/arena-room';
import { deepClone, deepEqual } from './utils';

type ProposalIdentity = Pick<ArenaProposal, 'proposalVersion' | 'proposalId' | 'roomId' | 'authorUserId' | 'baseRevision' | 'changes'>;
type Scope = { readonly roomId: string; readonly selfUserId: string };
export type ArenaRoomProposalReconciliationInput = Scope & (
  | { readonly operation: 'submit'; readonly request: ArenaRoomProposalSubmitRequest }
  | { readonly operation: 'resolve'; readonly proposalId: string; readonly request: ArenaRoomProposalResolveRequest; readonly pendingProposal: ArenaProposal | null }
  | { readonly operation: 'withdraw'; readonly proposalId: string; readonly request: ArenaRoomProposalWithdrawRequest; readonly pendingProposal: ArenaProposal | null }
);

/** Ephemeral evidence only: never a permission, receipt, retry token, or durable operation ledger. */
export type ArenaRoomProposalReconciliationTarget = Readonly<{
  roomId: string;
  roomEpoch: string;
  selfUserId: string;
  operation: ArenaRoomProposalReconciliationInput['operation'];
  request: Readonly<ArenaRoomProposalSubmitRequest | ArenaRoomProposalResolveRequest | ArenaRoomProposalWithdrawRequest>;
  proposalId: string;
  identity: Readonly<ProposalIdentity> | null;
  resolution: ArenaRoomProposalResolveRequest['resolution'] | null;
  selectedChangeIds: readonly string[] | null;
  linked: boolean;
}>;

const freeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const identityOf = (proposal: ProposalIdentity): ProposalIdentity => ({
  proposalVersion: proposal.proposalVersion,
  proposalId: proposal.proposalId,
  roomId: proposal.roomId,
  authorUserId: proposal.authorUserId,
  baseRevision: proposal.baseRevision,
  changes: deepClone(proposal.changes),
});

/** The caller supplies pending evidence from the current authoritative request epoch. */
export const createArenaRoomProposalReconciliationTarget = (
  input: ArenaRoomProposalReconciliationInput,
): ArenaRoomProposalReconciliationTarget => {
  const proposalId = input.operation === 'submit' ? input.request.proposalId : input.proposalId;
  const pending = input.operation === 'submit' ? null : input.pendingProposal;
  const identity = input.operation === 'submit'
    ? identityOf({ ...input.request, proposalVersion: PROPOSAL_VERSION, roomId: input.roomId, authorUserId: input.selfUserId })
    : pending?.status === 'submitted' && pending.roomId === input.roomId && pending.proposalId === proposalId
      ? identityOf(pending) : null;
  return freeze({
    roomId: input.roomId,
    roomEpoch: input.request.expectedRoomEpoch,
    selfUserId: input.selfUserId,
    operation: input.operation,
    request: deepClone(input.request),
    proposalId,
    identity,
    resolution: input.operation === 'resolve' ? input.request.resolution : null,
    selectedChangeIds: input.operation === 'resolve' ? deepClone(input.request.selectedChangeIds ?? null) : null,
    linked: input.operation !== 'submit' && identity !== null,
  });
};

export type ArenaRoomProposalReconciliationEvidence = Scope & Readonly<{
  roomEpoch: string;
  proposals?: readonly ArenaProposal[];
  event?: ControlRoomEvent;
}>;
export type ArenaRoomProposalReconciliationObservation = Readonly<{
  observation: 'pending' | 'absent' | 'conflict' | 'scope-changed' | 'target-unavailable' | 'submitted' | 'terminal';
  linked: boolean;
  settle: boolean;
  outcome: 'satisfied' | 'different' | 'scope-unverified' | null;
  terminalStatus: ResolvedArenaProposalStatus | null;
}>;

const terminalOutcome = (
  target: ArenaRoomProposalReconciliationTarget,
  status: ResolvedArenaProposalStatus,
): ArenaRoomProposalReconciliationObservation['outcome'] => {
  if (target.operation === 'submit') return 'satisfied';
  if (target.operation === 'withdraw') return status === 'withdrawn' ? 'satisfied' : 'different';
  if (target.resolution === 'reject') return status === 'rejected' ? 'satisfied' : 'different';
  if (status === 'partially_accepted') return 'scope-unverified';
  if (status !== 'accepted') return 'different';
  const all = target.identity!.changes.map(change => change.changeId);
  const selected = target.selectedChangeIds;
  return selected === null || (new Set(selected).size === all.length && all.every(id => selected.includes(id)))
    ? 'satisfied' : 'different';
};

/** Observes current authority, not which POST caused it. Carry `linked` only for this frozen target. */
export const observeArenaRoomProposalReconciliation = (
  target: ArenaRoomProposalReconciliationTarget,
  evidence: ArenaRoomProposalReconciliationEvidence,
  linked = target.linked,
): ArenaRoomProposalReconciliationObservation => {
  const result = (
    observation: ArenaRoomProposalReconciliationObservation['observation'],
    settle = false,
    outcome: ArenaRoomProposalReconciliationObservation['outcome'] = null,
    terminalStatus: ResolvedArenaProposalStatus | null = null,
  ): ArenaRoomProposalReconciliationObservation => ({ observation, linked, settle, outcome, terminalStatus });
  const event = evidence.event;
  if (evidence.roomId !== target.roomId || evidence.roomEpoch !== target.roomEpoch
    || evidence.selfUserId !== target.selfUserId
    || (event && (event.roomId !== target.roomId || event.roomEpoch !== target.roomEpoch))) {
    linked = false;
    return result('scope-changed');
  }
  if (!target.identity) return result('target-unavailable');
  const proposals = [...(evidence.proposals ?? [])];
  if (event?.type === 'room.snapshot') proposals.push(...event.payload.proposals);
  if (event?.type === 'proposal.submitted' || event?.type === 'proposal.updated') proposals.push(event.payload.proposal);
  const matchingId = proposals.filter(proposal => proposal.proposalId === target.proposalId);
  // Conflicting full evidence must never be overridden by an ID-only terminal event.
  if (matchingId.some(proposal => !deepEqual(identityOf(proposal), target.identity))) {
    linked = false;
    return result('conflict');
  }
  if (matchingId.some(proposal => proposal.status !== 'draft')) linked = true;
  const terminal = matchingId.find(proposal => proposal.status !== 'submitted' && proposal.status !== 'draft');
  const terminalStatus = terminal?.status as ResolvedArenaProposalStatus | undefined
    ?? (event?.type === 'proposal.resolved' && event.payload.proposalId === target.proposalId ? event.payload.status : undefined);
  if (linked && terminalStatus) return result('terminal', true, terminalOutcome(target, terminalStatus), terminalStatus);
  if (matchingId.some(proposal => proposal.status === 'submitted')) {
    return target.operation === 'submit' ? result('submitted', true, 'satisfied') : result('pending');
  }
  return result('absent');
};

'use client';

import { useMemo, useState, useSyncExternalStore } from 'react';

import type {
  ArenaProposalChange,
  ArenaRoomSharedConfig,
} from '@mahoshojo/contracts/arena-room';

import {
  RoomProposalHostReview,
  type RoomProposalHostReviewProps,
  arenaProposalChangeSummary as sharedArenaProposalChangeSummary,
  arenaProposalChangeProposedSummary as sharedArenaProposalChangeProposedSummary,
  type ArenaProposalChangeLabels,
} from '@mahoshojo/ui-web/arena-room';

export {
  ArenaProposalSelectionDetails,
  arenaProposalSelectionError,
  arenaProposalConflictSummary,
  arenaProposalExpectedBaseSummary,
  changeRefTitle,
} from '@mahoshojo/ui-web/arena-room';
export type { ArenaProposalChangeLabels } from '@mahoshojo/ui-web/arena-room';

import {
  arenaRoomReferenceSourcePrefix,
  dataCardReferenceRequest,
  parseArenaRoomReferenceKey,
  presetReferenceRequest,
  resolveArenaRoomReferenceName,
  shortReferenceId,
  useArenaRoomReferenceNames,
  type ArenaRoomReferenceRequest,
} from '@/lib/arena-room/reference-presentation';

import type {
  ArenaRoomController,
  ArenaRoomControllerState,
} from '@/lib/arena-room/controller';
import { buttonClassName } from '@/components/shared/ui/Button';

import type { ArenaRoomProposalWorkspace } from './useArenaRoom';
import { arenaLanguageCopy } from './presentation/value-copy';

type ProposalController = Pick<
  ArenaRoomController,
  'endProposalTracking' | 'reconnect' | 'resolveProposal' | 'submitProposal' | 'withdrawProposal'
>;

export type ArenaProposalPanelProps = {
  readonly state: ArenaRoomControllerState;
  readonly controller: ProposalController;
  readonly workspace: ArenaRoomProposalWorkspace;
};

/** 从房间共享配置找回被 key 引用的在线卡版本；预设版本由策展目录提供。 */
const onlineVersionTokenOf = (
  config: ArenaRoomSharedConfig | null | undefined,
  key: string,
): string | undefined => {
  if (!config) return undefined;
  const entry = config.combatants.find((item) => item.key === key)
    ?? config.auxScenarios.find((item) => item.key === key)
    ?? config.materials.find((item) => item.key === key)
    ?? (config.scenario?.key === key ? config.scenario : undefined);
  return entry && 'ref' in entry ? entry.ref.versionToken : undefined;
};

/** key 解析为引用请求：绑定房间引用的版本；预设目录版本仅作回退。 */
const referenceRequestOfKey = (
  config: ArenaRoomSharedConfig | null | undefined,
  key: string,
  fallbackKind: ArenaRoomReferenceRequest['kind'],
): ArenaRoomReferenceRequest | null => {
  const parsed = parseArenaRoomReferenceKey(key, fallbackKind);
  if (!parsed) return null;
  if (parsed.source === 'preset') {
    return presetReferenceRequest(parsed.kind, parsed.id, onlineVersionTokenOf(config, key));
  }
  return dataCardReferenceRequest(parsed.kind, {
    id: parsed.id,
    versionToken: onlineVersionTokenOf(config, key),
  });
};

/** add/setScenario 的 ref + 可选 namespace key 解析为绑定版本的引用请求。 */
const referenceRequestOfRef = (
  kind: ArenaRoomReferenceRequest['kind'],
  ref: { readonly id: string; readonly versionToken?: string },
  key: string | undefined,
): ArenaRoomReferenceRequest => ({
  source: key !== undefined && key.startsWith('preset:') ? 'preset' : 'data-card',
  kind,
  id: ref.id,
  ...(ref.versionToken === undefined ? {} : { versionToken: ref.versionToken }),
});

/** 收集提案变更中所有可解析为预设/在线公开引用的名称请求（绑定引用版本）。 */
export const collectArenaProposalReferenceRequests = (
  changes: readonly ArenaProposalChange[],
  config?: ArenaRoomSharedConfig | null,
): ArenaRoomReferenceRequest[] => {
  const requests: ArenaRoomReferenceRequest[] = [];
  const push = (request: ArenaRoomReferenceRequest | null): void => {
    if (request) requests.push(request);
  };
  for (const change of changes) {
    switch (change.type) {
      case 'addCombatant':
        push(referenceRequestOfRef('character', change.ref, change.key));
        break;
      case 'removeCombatant':
      case 'setCharacterGuidance':
      case 'assignTeam':
        push(referenceRequestOfKey(config, change.combatantKey, 'character'));
        break;
      case 'setScenario':
        if (change.ref !== null) {
          push(referenceRequestOfRef('scenario', change.ref, change.key));
        }
        break;
      case 'addAuxScenario':
        push(referenceRequestOfRef('scenario', change.ref, change.key));
        break;
      case 'removeAuxScenario':
        push(referenceRequestOfKey(config, change.scenarioKey, 'scenario'));
        break;
      case 'addMaterial':
        push(referenceRequestOfRef('material', change.ref, change.key));
        break;
      case 'removeMaterial':
        push(referenceRequestOfKey(config, change.materialKey, 'material'));
        break;
      case 'reorderCombatants':
      case 'reorderTeamCombatants':
        change.value.forEach((key) => push(referenceRequestOfKey(config, key, 'character')));
        break;
      case 'reorderAuxScenarios':
        change.value.forEach((key) => push(referenceRequestOfKey(config, key, 'scenario')));
        break;
      case 'reorderMaterials':
        change.value.forEach((key) => push(referenceRequestOfKey(config, key, 'material')));
        break;
      default:
        break;
    }
  }
  return requests;
};

/** 由共享配置 + 统一引用名称缓存构建提案摘要标签；找不到时回退原始 key。 */
export const buildArenaProposalChangeLabels = (
  changes: readonly ArenaProposalChange[],
  config: ArenaRoomSharedConfig | null,
  onlineNames: ReadonlyMap<string, string>,
): ArenaProposalChangeLabels => {
  const prefixedName = (
    request: ArenaRoomReferenceRequest,
    fallback: string | undefined,
  ): string | undefined => {
    const name = resolveArenaRoomReferenceName(request, onlineNames);
    if (name) return `${arenaRoomReferenceSourcePrefix(request.source)}:${name}`;
    return fallback;
  };
  const fallbackOf = (request: ArenaRoomReferenceRequest): string => (
    `${arenaRoomReferenceSourcePrefix(request.source)}:${shortReferenceId(request.id)}`
  );
  const hostLocalNameOf = (key: string): string | undefined => {
    const entry = config?.combatants.find((item) => item.key === key);
    if (entry && !('ref' in entry)) return `房主本地:${entry.displayName}`;
    const scenario = config?.auxScenarios.find((item) => item.key === key)
      ?? (config?.scenario && config.scenario.key === key ? config.scenario : undefined);
    if (scenario && !('ref' in scenario)) return `房主本地:${scenario.displayName}`;
    const material = config?.materials.find((item) => item.key === key);
    if (material && !('ref' in material)) return `房主本地:${material.displayName}`;
    return undefined;
  };
  const keyLabelOf = (fallbackKind: ArenaRoomReferenceRequest['kind']) => (key: string): string | undefined => {
    const request = referenceRequestOfKey(config, key, fallbackKind);
    if (!request) return hostLocalNameOf(key);
    return prefixedName(request, fallbackOf(request));
  };
  return {
    language: arenaLanguageCopy,
    combatantKey: keyLabelOf('character'),
    scenarioKey: keyLabelOf('scenario'),
    materialKey: keyLabelOf('material'),
    teamKey: (key) => config?.teams.find((team) => team.key === key)?.displayName,
    ref: (ref, key) => {
      const request = referenceRequestOfRef(
        ref.kind === 'scenario' ? 'scenario' : ref.kind === 'material' ? 'material' : 'character',
        ref,
        key,
      );
      return prefixedName(request, fallbackOf(request));
    },
  };
};

/** 提案摘要标签 hook：预设走策展目录，在线公开卡走共享名称缓存（按引用版本缓存）。 */
export const useArenaProposalChangeLabels = (
  config: ArenaRoomSharedConfig | null,
  changes: readonly ArenaProposalChange[],
): ArenaProposalChangeLabels => {
  const requests = useMemo(
    () => collectArenaProposalReferenceRequests(changes, config),
    [changes, config],
  );
  const onlineNames = useArenaRoomReferenceNames(requests);
  return useMemo(
    () => buildArenaProposalChangeLabels(changes, config, onlineNames),
    [changes, config, onlineNames],
  );
};

export const arenaProposalChangeSummary = (
  change: ArenaProposalChange,
  labels?: ArenaProposalChangeLabels,
): string => sharedArenaProposalChangeSummary(change, {
  ...labels,
  language: labels?.language ?? arenaLanguageCopy,
});

export const arenaProposalChangeProposedSummary = (
  change: ArenaProposalChange,
  labels?: ArenaProposalChangeLabels,
): string => sharedArenaProposalChangeProposedSummary(change, {
  ...labels,
  language: labels?.language ?? arenaLanguageCopy,
});

const HostProposalCard = ({ controller, ...props }: Omit<RoomProposalHostReviewProps, 'onResolve' | 'labels' | 'reviewIdentity'> & {
  readonly controller: ProposalController;
}) => {
  const labels = useArenaProposalChangeLabels(props.currentConfig, props.proposal.changes);
  return <RoomProposalHostReview {...props} labels={labels} reviewIdentity={controller} onResolve={controller.resolveProposal} />;
};

const HostProposalInbox = ({
  state,
  controller,
}: {
  readonly state: ArenaRoomControllerState;
  readonly controller: ProposalController;
}) => {
  const session = state.session;
  if (!session) return null;
  const disabled = state.proposalOperation !== null || state.proposalResultUnknown || state.proposalTracking?.phase === 'ended-needs-read';
  const proposals = session.snapshot.proposals;
  return (
    <section aria-labelledby="arena-proposal-inbox-heading" className="rounded-xl border border-gray-200 bg-white/50 p-3 dark:border-gray-700 dark:bg-gray-950/20">
      <div>
        <h3 id="arena-proposal-inbox-heading" className="text-sm font-semibold text-gray-950 dark:text-gray-100">
          待处理提案 ({proposals.length})
        </h3>
        <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
          在当前房间提案窗口逐项审阅配置变更，不占用主编辑区。
        </p>
      </div>
      {state.proposalOutcome ? <p role="status" className="mt-3 text-sm">{state.proposalOutcome}</p> : null}
      {state.proposalResultUnknown || state.proposalTracking?.phase === 'ended-needs-read' ? (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
          <p>{state.proposalTracking?.phase === 'ended-needs-read' ? '已结束本机跟踪，不取消服务器操作；请先重新读取房间状态。' : '上次审阅结果未知，已冻结重复处理。'}</p>
          <button type="button" className={buttonClassName({ className: 'mt-2' })} onClick={controller.reconnect}>
            重新连接并对账
          </button>
          {state.proposalTracking?.phase === 'unknown' ? (
            <button type="button" className={buttonClassName({ className: 'mt-2 ml-2' })}
              onClick={() => controller.endProposalTracking(state.proposalTracking!.id)}>
              结束本机跟踪（不取消服务器操作）
            </button>
          ) : null}
        </div>
      ) : null}
      {state.error && !state.proposalResultUnknown ? (
        <div role="alert" className="mt-3 rounded-lg border border-red-300 p-3 text-sm text-red-800 dark:text-red-200">
          <p>{state.error}</p>
          <button type="button" className={buttonClassName({ className: 'mt-2' })}
            disabled={disabled} onClick={controller.reconnect}>重新连接并核对房间状态</button>
        </div>
      ) : null}
      <p className="mt-3 text-xs text-gray-600 dark:text-gray-400">
        接受时服务器会再次校验这些修改是否仍然适用。
      </p>
      {proposals.length === 0 ? (
        <p className="mt-3 text-sm text-gray-600 dark:text-gray-400">
          暂无待处理提案。成员在主编辑区编辑并提交提案后会出现在这里；接受后的内容才会进入本局配置。
        </p>
      ) : (
        <ul className="mt-3 space-y-3" aria-label="待审阅提案">
          {proposals.map((proposal) => (
            <HostProposalCard
              key={`${session.roomId}:${session.roomEpoch}:${proposal.proposalId}:${proposal.updatedAt ?? proposal.createdAt}`}
              proposal={proposal}
              roomId={session.snapshot.roomId}
              revision={session.snapshot.revision}
              roomEpoch={session.roomEpoch}
              currentConfig={session.snapshot.sharedConfig}
              authorDisplayName={session.snapshot.members.find((member) => member.userId === proposal.authorUserId)?.displayName ?? '未知成员'}
              controller={controller}
              disabled={disabled}
            />
          ))}
        </ul>
      )}
    </section>
  );
};

const MemberProposalEntry = ({
  state,
  controller,
  workspace,
}: {
  readonly state: ArenaRoomControllerState;
  readonly controller: ProposalController;
  readonly workspace: ArenaRoomProposalWorkspace;
}) => {
  const [confirmResync, setConfirmResync] = useState(false);
  const session = state.session;
  const editor = workspace.editor;
  const editorState = useSyncExternalStore(
    editor?.store.subscribe ?? (() => () => undefined),
    editor?.store.getState ?? (() => null),
    editor?.store.getInitialState ?? (() => null),
  );
  if (!session) return null;

  return (
    <section aria-labelledby="arena-proposal-editor-heading" className="rounded-xl border border-gray-200 bg-white/50 p-3 dark:border-gray-700 dark:bg-gray-950/20">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 id="arena-proposal-editor-heading" className="text-sm font-semibold text-gray-950 dark:text-gray-100">
            配置提案
          </h3>
          <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
            {editorState
              ? '主编辑区已进入提案模式'
              : '同步房间当前设置后，主编辑区会切换到提案模式。'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonClassName()}
            onClick={() => {
              if (editorState?.dirty) {
                setConfirmResync(true);
                return;
              }
              workspace.syncFromRoom();
            }}
          >
            {editorState?.dirty
              ? '丢弃草稿并重新同步'
              : editorState ? '重新同步房间配置' : '同步房间配置'}
          </button>
        </div>
      </div>
      {confirmResync ? (
        <div
          role="alertdialog"
          aria-labelledby="arena-proposal-resync-confirm-heading"
          aria-describedby="arena-proposal-resync-confirm-description"
          className="mt-3 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/30 dark:text-red-100"
        >
          <p id="arena-proposal-resync-confirm-heading" className="font-semibold">确认重新同步？</p>
          <p id="arena-proposal-resync-confirm-description" className="mt-1">
            当前未提交修改将被丢弃，并以房间最新配置重新建立提案草稿。
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClassName({ variant: 'danger' })}
              onClick={() => {
                setConfirmResync(false);
                workspace.syncFromRoom();
              }}
            >
              确认丢弃并同步
            </button>
            <button type="button" className={buttonClassName()} onClick={() => setConfirmResync(false)}>
              保留草稿
            </button>
          </div>
        </div>
      ) : null}
      {editorState?.replacementRequired ? (
        <p role="alert" className="mt-3 rounded-lg border border-red-300 bg-red-50 p-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200">
          房间实例已变化，旧草稿禁止提交；请重新同步。
        </p>
      ) : editorState?.stale ? (
        <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
          房间设置已更新；草稿仍可提交，冲突项将由房主审阅决定。
        </p>
      ) : null}
      <ArenaMemberProposalStatus state={state} controller={controller} />
      <p className="mt-3 text-xs text-gray-600 dark:text-gray-400">
        只想围观也完全可以：不提交提案，等房主开始生成即可。
      </p>
    </section>
  );
};

export function ArenaMemberProposalStatus({
  state,
  controller,
}: {
  readonly state: ArenaRoomControllerState;
  readonly controller: Pick<ArenaRoomController, 'endProposalTracking' | 'reconnect' | 'withdrawProposal'>;
}) {
  const session = state.session;
  if (!session || session.self.role !== 'member') return null;
  const disabled = state.proposalOperation !== null || state.proposalResultUnknown || state.proposalTracking?.phase === 'ended-needs-read';
  const proposals = session.snapshot.proposals.filter((proposal) => (
    proposal.authorUserId === session.self.userId
  ));
  return (
    <>
      {state.proposalOutcome ? <p role="status" className="mt-3 text-sm">{state.proposalOutcome}</p> : null}
      {state.proposalResultUnknown || state.proposalTracking?.phase === 'ended-needs-read' ? (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
          <p>{state.proposalTracking?.phase === 'ended-needs-read' ? '已结束本机跟踪，不取消服务器操作；请先重新读取房间状态。' : '上次提案请求结果未知，已冻结重复提交。'}</p>
          <button type="button" className={buttonClassName({ className: 'mt-2' })} onClick={controller.reconnect}>
            重新连接并对账
          </button>
          {state.proposalTracking?.phase === 'unknown' ? (
            <button type="button" className={buttonClassName({ className: 'mt-2 ml-2' })}
              onClick={() => controller.endProposalTracking(state.proposalTracking!.id)}>
              结束本机跟踪（不取消服务器操作）
            </button>
          ) : null}
        </div>
      ) : null}

      {proposals.length > 0 ? (
        <div className="mt-4">
          <h4 className="text-sm font-semibold text-gray-950 dark:text-gray-100">我的待处理提案</h4>
          <ul className="mt-2 space-y-2">
            {proposals.map((proposal) => (
              <li key={proposal.proposalId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 p-2 dark:border-gray-700">
                <span className="text-xs text-gray-600 dark:text-gray-400" title={proposal.proposalId}>
                  提交于 {proposal.createdAt}
                </span>
                <button
                  type="button"
                  className={buttonClassName({ variant: 'danger' })}
                  disabled={disabled}
                  onClick={() => { void controller.withdrawProposal(proposal.proposalId); }}
                >
                  撤回提案
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

export function ArenaProposalPanel(props: ArenaProposalPanelProps) {
  const session = props.state.session;
  if (!session || props.state.phase === 'closed' || props.state.phase === 'replacement') return null;
  return session.self.role === 'host' ? (
    <HostProposalInbox state={props.state} controller={props.controller} />
  ) : (
    <MemberProposalEntry
      state={props.state}
      controller={props.controller}
      workspace={props.workspace}
    />
  );
}

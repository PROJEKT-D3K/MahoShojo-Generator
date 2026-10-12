'use client';

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import {
  createRoomProposalArenaEditorSession,
  type RoomProposalArenaEditorSession,
} from '@/components/arena/editor';
import type {
  ArenaRoomGenerationHistoryResponse,
  ArenaRoomGenerationHistoryViewResponse,
} from '@mahoshojo/contracts/arena-room';

import { createArenaRoomClient } from '@/lib/arena-room/client';
import { getAuthIdentitySnapshot, subscribeAuthIdentity, type AuthIdentity } from '@/lib/auth-identity';
import {
  arenaRoomHostWorkspaceAuthorityFromSession,
  createArenaRoomHostWorkspace,
} from '@/lib/arena-room/host-workspace';
import {
  createArenaRoomController,
  type ArenaRoomController,
  type ArenaRoomSocket,
} from '@/lib/arena-room/controller';
import { useArenaRoomHostReconciliation } from './useArenaRoomHostReconciliation';
import { useArenaRoomLatestCompletedHistory } from './useArenaRoomLatestCompletedHistory';
import { useArenaRoomNarrativeHistoryResultWriter } from './useArenaRoomNarrativeHistoryResultWriter';

type UseArenaRoomOptions = {
  readonly enabled: boolean;
  readonly authenticated: boolean;
  readonly origin: string;
};

type LifecycleToken = {
  readonly controller: ArenaRoomController;
  readonly token: symbol;
};

export type ArenaRoomProposalWorkspace = Readonly<{
  editor: RoomProposalArenaEditorSession | null;
  syncFromRoom(): void;
}>;

export type ArenaRoomGenerationHistoryReader = Readonly<{
  list(): Promise<ArenaRoomGenerationHistoryResponse>;
  read(generationId: string): Promise<ArenaRoomGenerationHistoryViewResponse>;
}>;

/**
 * 房间面板 UI 桥：房间配置/提案 Modal 的开关状态放在页面级 runtime 上，
 * 供顶部入口（ArenaMultiplayerPanelView）与底部大按钮（BattleActions）共享，
 * 避免复制两套 modal state 和业务逻辑。
 */
export type ArenaRoomPanelUi = Readonly<{
  configOpen: boolean;
  proposalsOpen: boolean;
  setConfigOpen(open: boolean): void;
  setProposalsOpen(open: boolean): void;
}>;

export const useArenaRoom = (options: UseArenaRoomOptions) => {
  const identity = useSyncExternalStore(
    subscribeAuthIdentity,
    getAuthIdentitySnapshot,
    getAuthIdentitySnapshot,
  );
  const { client, controller, hostWorkspace } = useMemo(() => {
    const client = createArenaRoomClient({ origin: options.origin, identity });
    const nextController = createArenaRoomController({
      client,
      identity,
      createSocket: (url, protocol) => (
        new WebSocket(url, protocol) as unknown as ArenaRoomSocket
      ),
    });
    return {
      client,
      controller: nextController,
      hostWorkspace: createArenaRoomHostWorkspace(),
    };
  }, [identity, options.origin]);
  const lifecycle = useRef<LifecycleToken | null>(null);
  const proposalEditorRef = useRef<RoomProposalArenaEditorSession | null>(null);
  const [proposalEditorState, setProposalEditorState] = useState<{
    identity: AuthIdentity;
    editor: RoomProposalArenaEditorSession | null;
  }>({ identity, editor: null });
  const setProposalEditor = useCallback((editor: RoomProposalArenaEditorSession | null) => {
    if (identity.isCurrent()) setProposalEditorState({ identity, editor });
  }, [identity]);
  const proposalEditor = proposalEditorState.identity === identity && identity.isCurrent()
    ? proposalEditorState.editor : null;
  const [panelUiState, setPanelUiState] = useState<{ identity: AuthIdentity; configOpen: boolean; proposalsOpen: boolean }>({
    identity,
    configOpen: false,
    proposalsOpen: false,
  });

  useEffect(() => {
    const clearRoomWorkspace = () => {
      hostWorkspace.retainFor(null);
      proposalEditorRef.current?.dispose();
      proposalEditorRef.current = null;
    };
    const unsubscribe = subscribeAuthIdentity(() => {
      if (!identity.isCurrent()) clearRoomWorkspace();
    });
    return () => {
      unsubscribe();
      clearRoomWorkspace();
    };
  }, [hostWorkspace, identity]);

  useEffect(() => {
    setProposalEditorState({ identity, editor: null });
    setPanelUiState({ identity, configOpen: false, proposalsOpen: false });
  }, [identity]);

  useEffect(() => {
    controller.setAccess({
      enabled: options.enabled,
      authenticated: options.authenticated,
    });
  }, [controller, options.authenticated, options.enabled]);

  useEffect(() => {
    const token = Symbol('arena-room-controller-lifecycle');
    lifecycle.current = { controller, token };
    return () => {
      queueMicrotask(() => {
        const active = lifecycle.current;
        if (
          !active
          || active.controller !== controller
          || active.token === token
        ) {
          controller.dispose();
        }
      });
    };
  }, [controller]);

  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useArenaRoomNarrativeHistoryResultWriter(state, undefined, identity);

  useEffect(() => {
    if (identity.isCurrent()) {
      hostWorkspace.retainFor(arenaRoomHostWorkspaceAuthorityFromSession(state.session));
    }
  }, [hostWorkspace, identity, state.session]);

  useEffect(() => {
    if (!identity.isCurrent()) return;
    const session = state.session;
    const editor = proposalEditorRef.current;
    if (!session || session.self.role !== 'member') {
      if (editor) {
        editor.dispose();
        proposalEditorRef.current = null;
        setProposalEditor(null);
      }
      return;
    }
    if (editor) {
      editor.sync(session.snapshot);
      return;
    }
    const next = createRoomProposalArenaEditorSession(session.snapshot);
    proposalEditorRef.current = next;
    setProposalEditor(next);
  }, [identity, setProposalEditor, state.session]);

  useEffect(() => () => {
    proposalEditorRef.current?.dispose();
    proposalEditorRef.current = null;
  }, []);

  const proposalWorkspace = useMemo<ArenaRoomProposalWorkspace>(() => Object.freeze({
    editor: proposalEditor,
    syncFromRoom() {
      if (!identity.isCurrent()) return;
      const session = controller.getSnapshot().session;
      if (!session || session.self.role !== 'member') return;
      proposalEditorRef.current?.dispose();
      const next = createRoomProposalArenaEditorSession(session.snapshot);
      proposalEditorRef.current = next;
      setProposalEditor(next);
    },
  }), [controller, identity, proposalEditor, setProposalEditor]);

  const generationHistory = useMemo<ArenaRoomGenerationHistoryReader>(() => {
    const captureSession = () => {
      if (!identity.isCurrent()) throw new Error('登录身份已变化，请重新进入房间');
      const session = controller.getSnapshot().session;
      if (!session) throw new Error('当前不在多人房间中');
      return session;
    };
    const assertSameSession = (captured: ReturnType<typeof captureSession>) => {
      if (!identity.isCurrent()) throw new Error('登录身份已变化，请重新进入房间');
      const current = controller.getSnapshot().session;
      if (
        !current
        || current.roomId !== captured.roomId
        || current.roomEpoch !== captured.roomEpoch
        || current.self.userId !== captured.self.userId
      ) throw new Error('房间会话已变化，请重新打开历史战报');
      return current;
    };
    return Object.freeze({
      async list() {
        const captured = captureSession();
        const result = await client.listGenerationHistory(captured.roomId);
        assertSameSession(captured);
        if (result.roomEpoch !== captured.roomEpoch) {
          throw new Error('历史战报属于其他房间实例，已拒绝显示');
        }
        return result;
      },
      async read(generationId) {
        const captured = captureSession();
        const result = await client.getGenerationHistoryView(captured.roomId, generationId);
        assertSameSession(captured);
        if (result.roomEpoch !== captured.roomEpoch) {
          throw new Error('历史战报属于其他房间实例，已拒绝显示');
        }
        return result;
      },
    });
  }, [client, controller, identity]);

  const hostReconciliation = useArenaRoomHostReconciliation({
    controller,
    controllerState: state,
    hostWorkspace,
    identity,
  });

  const activeGeneration = state.session?.snapshot.activeGeneration;
  // 服务端历史列表只投影 completed ledger；failed/cancelled 不会改变计数，
  // 因此只有 completed 终态才触发计数刷新。
  const latestHistoryRefreshKey = activeGeneration?.state === 'completed'
    ? activeGeneration.generationId
    : '';

  const latestGenerationHistory = useArenaRoomLatestCompletedHistory({
    reader: generationHistory,
    identity,
    sessionKey: state.session
      ? `${state.session.roomId}\n${state.session.roomEpoch}\n${state.session.self.userId}`
      : null,
    refreshKey: latestHistoryRefreshKey,
    enabled: state.generation.phase === 'idle' && !state.generation.markdown,
  });

  // setter 在同一身份内稳定；旧 UI 闭包不能控制新身份的 Room modal。
  const setPanelUiConfigOpen = useCallback((open: boolean) => {
    if (!identity.isCurrent()) return;
    setPanelUiState((current) => current.identity !== identity
      ? { identity, configOpen: open, proposalsOpen: false }
      : current.configOpen === open
        ? current
        : { ...current, configOpen: open });
  }, [identity]);
  const setPanelUiProposalsOpen = useCallback((open: boolean) => {
    if (!identity.isCurrent()) return;
    setPanelUiState((current) => current.identity !== identity
      ? { identity, configOpen: false, proposalsOpen: open }
      : current.proposalsOpen === open
        ? current
        : { ...current, proposalsOpen: open });
  }, [identity]);

  const panelUi = useMemo<ArenaRoomPanelUi>(() => Object.freeze({
    configOpen: panelUiState.identity === identity && identity.isCurrent() && panelUiState.configOpen,
    proposalsOpen: panelUiState.identity === identity && identity.isCurrent() && panelUiState.proposalsOpen,
    setConfigOpen: setPanelUiConfigOpen,
    setProposalsOpen: setPanelUiProposalsOpen,
  }), [identity, panelUiState, setPanelUiConfigOpen, setPanelUiProposalsOpen]);

  return {
    controller,
    state,
    hostWorkspace,
    hostReconciliation,
    proposalWorkspace,
    generationHistory,
    latestGenerationHistory,
    panelUi,
  };
};

export type ArenaRoomRuntime = ReturnType<typeof useArenaRoom>;

const ArenaRoomContext = createContext<ArenaRoomRuntime | null>(null);

export const ArenaRoomProvider = ({
  children,
  ...options
}: UseArenaRoomOptions & { readonly children: ReactNode }) => {
  const runtime = useArenaRoom(options);
  return createElement(ArenaRoomContext.Provider, { value: runtime }, children);
};

export const useArenaRoomContext = (): ArenaRoomRuntime | null => (
  useContext(ArenaRoomContext)
);

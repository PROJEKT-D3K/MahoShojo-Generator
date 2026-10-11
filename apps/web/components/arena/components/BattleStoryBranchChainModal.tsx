'use client';

import { useMemo } from 'react';
import { BattleStoryBranchChainModal as SharedBranchChainModal, projectBattleStoryBranchSession } from '@mahoshojo/ui-web/arena-story-session';
import type { BattleStorySessionRecord } from '@/lib/ai-session/battle-story/types';

type BattleStoryBranchChainModalProps = {
  isOpen: boolean;
  sessions: BattleStorySessionRecord[];
  activeSession: BattleStorySessionRecord | null;
  onSelectSession: (sessionId: string) => void;
  onClose: () => void;
};

export function BattleStoryBranchChainModal(props: BattleStoryBranchChainModalProps) {
  const { sessions, activeSession } = useMemo(() => ({
    sessions: props.isOpen ? props.sessions.map(projectBattleStoryBranchSession) : [],
    activeSession: props.isOpen && props.activeSession ? projectBattleStoryBranchSession(props.activeSession) : null,
  }), [props.isOpen, props.sessions, props.activeSession]);
  return <SharedBranchChainModal {...props} sessions={sessions} activeSession={activeSession}
    scopeNote="仅展示当前已加载目录中的父链与子分支，目录最多载入最近 100 个会话。未载入的父会话不会被当作根会话。" />;
}

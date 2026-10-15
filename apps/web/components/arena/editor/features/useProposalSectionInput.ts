'use client';
import { mapSharedConfigToArenaMemberView, collectArenaMemberReferenceRequests, type ArenaMemberSectionInput } from '@mahoshojo/ui-web/arena-room';
import type { ArenaMemberProposalActions } from '@mahoshojo/multiplayer-core/member-proposal';
import { useArenaEditorSelector, useArenaEditorSession } from '../context';
import type { RoomProposalArenaEditorSession } from '../types';
import { useArenaRoomReferenceNames, resolveArenaRoomReferenceName } from '@/lib/arena-room/reference-presentation';

/** Compatibility for Web feature entry points; business actions and safe view remain shared. */
export function useProposalSectionInput(disabled: boolean, onActionError: (message: string) => void): ArenaMemberSectionInput | null {
  const session = useArenaEditorSession();
  useArenaEditorSelector(value => value);
  const model = session.mode === 'room-proposal' ? (session as RoomProposalArenaEditorSession).memberModel : null;
  const state = model ? mapSharedConfigToArenaMemberView(model.store.getState().editor.workingConfig) : null;
  const names = useArenaRoomReferenceNames(state ? collectArenaMemberReferenceRequests(state) : []);
  if (!model || !state) return null;
  const actions = Object.fromEntries(Object.entries(model.actions).map(([key, action]) => [key, (...args: unknown[]) => {
    if (disabled || model.store.getState().disposed || model.store.getState().editor.replacementRequired) return;
    try { (action as (...values: unknown[]) => void)(...args); }
    catch { onActionError('该修改不满足房间安全配置约束'); }
  }])) as ArenaMemberProposalActions;
  return { state, actions, disabled, resolveName: request => resolveArenaRoomReferenceName(request, names) ?? undefined };
}

/** A completed body is independent of role resolution and local save acknowledgement. */
export type BattleStoryRoleResolution =
  | { status: 'unresolved'; message?: string }
  | { status: 'not-requested' }
  | { status: 'accepted'; warning?: string }
  | { status: 'http-failure'; warning: string }
  | { status: 'user-kept-original'; warning: string }
  /** Headerless Web compatibility: older successful generations may omit generationId. */
  | { status: 'legacy-no-generation'; warning: string };

export type BattleStoryCompletedOutput<TOutput> = {
  readonly output: TOutput;
  role: BattleStoryRoleResolution;
};

/** Host-owned identity, in-flight and freeze fences must all permit a new role decision. */
export const canResolveBattleStoryRoles = (input: {
  role: BattleStoryRoleResolution;
  contextCurrent: boolean;
  roleBusy: boolean;
  commitFrozen: boolean;
}): boolean => input.role.status === 'unresolved'
  && input.contextCurrent && !input.roleBusy && !input.commitFrozen;

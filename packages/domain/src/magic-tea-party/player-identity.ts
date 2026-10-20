/** Current player selection is valid only while that role participates in this session. */
export const resolveMagicTeaPartyPlayerIdentity = (params: {
  roles: readonly { id: string; name: string }[];
  playerRoleId?: string | null;
  userDisplayName?: string | null;
}): { playerRoleId: string | null; speakerName: string } => {
  const role = params.playerRoleId ? params.roles.find(item => item.id === params.playerRoleId) : undefined;
  return role
    ? { playerRoleId: role.id, speakerName: role.name.trim() || role.id }
    : { playerRoleId: null, speakerName: params.userDisplayName?.trim() || '旅人' };
};

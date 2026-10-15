import { getOwnedCardMetadataSession, type OwnedCardMetadataPort } from '@mahoshojo/ui-web/cloud-save';
import { authStorage, dataCardApi, type OwnedDataCardWriteGuard } from './auth';
import type { AuthIdentity } from './auth-identity';

/** Freeze the same authenticated owner across preview and write, including cookie-only epochs. */
export function createWebOwnedCardMetadataPort(expectedUserId: number, identity: AuthIdentity,
  options: Pick<OwnedCardMetadataPort, 'isBlocked' | 'onBusyChange' | 'onSaved'> = {},
): OwnedCardMetadataPort {
  let guard: OwnedDataCardWriteGuard | null = null;
  const getGuard = async () => {
    if (!identity.isCurrent()) return null;
    if (guard) return guard;
    const auth = await authStorage.getAuth();
    if (!identity.isCurrent() || auth?.userId !== expectedUserId) return null;
    guard = { expectedUserId, expectedAuth: auth, isCurrent: identity.isCurrent };
    return guard;
  };
  return {
    ...options, session: getOwnedCardMetadataSession(identity, identity.epoch, expectedUserId), isCurrent: identity.isCurrent,
    async read(id) {
      const frozen = await getGuard();
      if (!frozen) return { kind: 'rejected', message: '登录状态已改变，请重新打开数据卡管理' };
      const result = await dataCardApi.readOwnedMetadataTarget(id, frozen);
      return result.success && result.target ? { kind: 'ready', target: result.target }
        : { kind: 'rejected', message: result.error?.replace(/替换目标/g, '数据卡信息').replace(/安全替换/g, '安全信息编辑') ?? '读取云端信息失败，输入已保留' };
    },
    async write(target, draft) {
      const frozen = await getGuard();
      if (!frozen) return { kind: 'conflict', message: '登录状态已改变，尚未发送请求；输入已保留' };
      const result = await dataCardApi.updateOwnedCardMetadata(target, draft, frozen);
      return result.success ? { kind: 'saved' } : { kind: result.uncertain ? 'uncertain' : result.conflict ? 'conflict' : 'rejected', message: result.error ?? '修改失败，输入已保留' };
    },
  };
}

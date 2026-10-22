import {
  DesktopControlWebPackageInstanceRequestSchema,
  DesktopControlWebPackageInstanceResponseSchema,
  type DesktopControlWebPackageInstanceRequest,
  type DesktopControlWebPackageInstanceResponse,
} from '@mahoshojo/contracts/desktop-ipc';
import type { StructuredInvokeFn } from './local-archive-bridge';

export const CONTROL_WEB_PACKAGE_INSTANCE_COMMAND = 'control_web_package_instance' as const;

/** Main UI only. Both the request and receipt stay tied to the Native-issued instance. */
export async function controlWebPackageWindow(
  invoke: StructuredInvokeFn,
  request: DesktopControlWebPackageInstanceRequest,
): Promise<DesktopControlWebPackageInstanceResponse> {
  const frozen = DesktopControlWebPackageInstanceRequestSchema.parse(request);
  const response = DesktopControlWebPackageInstanceResponseSchema.parse(
    await invoke(CONTROL_WEB_PACKAGE_INSTANCE_COMMAND, { request: frozen }),
  );
  if (response.instanceId !== frozen.instanceId) throw new Error('作品窗口回执与当前实例不匹配。');
  return response;
}

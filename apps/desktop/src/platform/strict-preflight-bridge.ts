import { DesktopStrictPreflightRequestSchema, DesktopStrictPreflightResponseSchema, STRICT_PREFLIGHT_MAX_BYTES, type DesktopStrictPreflightRequest, type DesktopStrictPreflightResponse } from '@mahoshojo/contracts/arena-strict-preflight';
import { DesktopCloudError, toCloudError, type InvokeFn } from './cloud-bridge';

export async function readStrictPreflight(invoke: InvokeFn, request: DesktopStrictPreflightRequest): Promise<DesktopStrictPreflightResponse> {
  const parsed = DesktopStrictPreflightRequestSchema.safeParse(request);
  if (!parsed.success || new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength > STRICT_PREFLIGHT_MAX_BYTES) {
    throw new DesktopCloudError('cloud_arena_strict_preflight', 'invalid-request', '严格排位预检输入超出允许范围');
  }
  let raw: unknown;
  try { raw = await invoke('cloud_arena_strict_preflight', { request: parsed.data }); }
  catch (cause) { throw toCloudError('cloud_arena_strict_preflight', cause); }
  const result = DesktopStrictPreflightResponseSchema.safeParse(raw);
  if (!result.success || result.data.viewerUserId !== parsed.data.expectedUserId) {
    throw new DesktopCloudError('cloud_arena_strict_preflight', 'invalid-response', '服务器尚未提供此版本的账号绑定预检，请稍后重试');
  }
  return result.data;
}

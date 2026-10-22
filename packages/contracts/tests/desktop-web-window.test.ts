import { describe, expect, it } from 'vitest';
import { DesktopControlWebPackageInstanceRequestSchema as Request, DesktopControlWebPackageInstanceResponseSchema as Response } from '../src/desktop-ipc';

describe('受限作品窗口控制合同', () => {
  it('只接受 Native instance 与封闭操作，全屏必须显式指定布尔值', () => {
    for (const action of ['status', 'focus', 'reload', 'close']) expect(Request.parse({ instanceId: 'wpk-7', action })).toEqual({ instanceId: 'wpk-7', action });
    for (const fullscreen of [true, false]) expect(Request.parse({ instanceId: 'wpk-7', action: 'set-fullscreen', fullscreen })).toHaveProperty('fullscreen', fullscreen);
    for (const request of [
      { instanceId: 'main-ui', action: 'close' },
      { instanceId: 'wpk-7', action: 'navigate', url: 'https://example.invalid' },
      { instanceId: 'wpk-7', action: 'close', label: 'main-ui' },
      { instanceId: 'wpk-7', action: 'reload', script: 'alert(1)' },
      { instanceId: 'wpk-7', action: 'set-fullscreen' },
      { instanceId: 'wpk-7', action: 'set-fullscreen', fullscreen: 'true' },
      { instanceId: 'wpk-7', action: 'status', fullscreen: false },
    ]) expect(Request.safeParse(request).success).toBe(false);
  });
  it('关闭回执不伪装为打开或携带陈旧全屏状态', () => {
    expect(Response.parse({ instanceId: 'wpk-7', status: 'closed' })).toEqual({ instanceId: 'wpk-7', status: 'closed' });
    expect(Response.safeParse({ instanceId: 'wpk-7', status: 'open' }).success).toBe(false);
    expect(Response.safeParse({ instanceId: 'wpk-7', status: 'closed', fullscreen: false }).success).toBe(false);
    expect(Response.parse({ instanceId: 'wpk-7', status: 'open', fullscreen: true })).toHaveProperty('fullscreen', true);
  });
});

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(), launch: vi.fn(), loadPlaywright: vi.fn(), mkdir: vi.fn(), write: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn, execSync: () => 'test-sha' }));
vi.mock('node:module', () => ({ createRequire: () => mocks.loadPlaywright }));
vi.mock('node:fs', async () => ({
  ...await vi.importActual<typeof import('node:fs')>('node:fs'),
  mkdirSync: mocks.mkdir, writeFileSync: mocks.write,
}));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const originalPlatform = process.platform;
let kill: ReturnType<typeof vi.spyOn>;
const server = () => Object.assign(new EventEmitter(), {
  pid: 81234 as number | undefined, stdout: new EventEmitter(), stderr: new EventEmitter(),
});
const report = (archive = false) => {
  const call = [...mocks.write.mock.calls].reverse().find(([file]) => archive
    ? /report-.*\.json$/.test(String(file)) : String(file).replaceAll('\\', '/').endsWith('/report.json'));
  expect(call).toBeTruthy();
  return JSON.parse(call![1]);
};
const run = async (...args: string[]) => {
  process.argv = ['node', 'lifecycle-test', ...args];
  const { main } = await import('../scripts/review-visual.mjs');
  const result = main().then(() => undefined, (error: unknown) => error);
  await vi.runAllTimersAsync();
  return result;
};
const readyAfterSpawn = () => {
  let attempts = 0;
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (++attempts <= 2) throw new Error('initially unavailable');
    return { status: 200 };
  }));
};

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  Object.defineProperty(process, 'platform', { value: 'linux' });
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200 })));
  mocks.spawn.mockImplementation(server);
  mocks.loadPlaywright.mockReturnValue({ chromium: { launch: mocks.launch } });
  process.exitCode = 0;
});
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('visual review 启动和收尾故障', () => {
  it('外部服务上浏览器启动失败仍写报告，绝不回收外部进程', async () => {
    const failure = new Error('browser launch failed');
    mocks.launch.mockRejectedValue(failure);
    expect(await run('--no-server')).toBe(failure);
    expect(report()).toMatchObject({ server: 'external', matrix: [], errors: [{ stage: 'browser-launch' }], totals: { findings: { fail: 1 } } });
    expect(mocks.write).toHaveBeenCalledTimes(2);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('复用探测到的外部服务也不获得进程清理权', async () => {
    mocks.launch.mockRejectedValue(new Error('launch failed'));
    await run();
    expect(report().server).toBe('external');
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it('Playwright 模块加载失败也在报告与自启服务清理范围内', async () => {
    readyAfterSpawn();
    const failure = new Error('Cannot find module playwright');
    mocks.loadPlaywright.mockImplementation(() => { throw failure; });
    expect(await run()).toBe(failure);
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledExactlyOnceWith(-81234, 'SIGTERM');
    expect(report()).toMatchObject({ errors: [{ stage: 'browser-launch' }] });
    expect(process.exitCode).toBe(1);
  });

  it('自启服务后 launch 失败，回收仅属于该次启动的进程组', async () => {
    readyAfterSpawn();
    const failure = new Error('browser launch failed');
    mocks.launch.mockRejectedValue(failure);
    expect(await run()).toBe(failure);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawn.mock.calls[0][2]).toMatchObject({ detached: true });
    expect(kill).toHaveBeenCalledExactlyOnceWith(-81234, 'SIGTERM');
    expect(report()).toMatchObject({ server: 'spawned-next-dev', errors: [{ stage: 'browser-launch' }] });
    expect(process.exitCode).toBe(1);
  });

  it.each([false, true])('readiness 超时也写失败报告；管理服务=%s', async (manageServer) => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unavailable'); }));
    expect(await run(...(manageServer ? [] : ['--no-server']))).toBeInstanceOf(Error);
    expect(report()).toMatchObject({ errors: [{ stage: 'server-readiness' }], matrix: [] });
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledTimes(manageServer ? 1 : 0);
    expect(process.exitCode).toBe(1);
  });

  it('spawn 错误不作为未捕获事件丢失，也不尝试清理无 PID 进程', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unavailable'); }));
    const failure = new Error('spawn ENOENT');
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(server(), { pid: undefined });
      queueMicrotask(() => child.emit('error', failure));
      return child;
    });
    expect(await run()).toBe(failure);
    expect(report().errors[0].detail).toContain('spawn ENOENT');
    expect(kill).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('浏览器、服务与报告各自收尾，后续错误不能遮盖原巡检失败', async () => {
    readyAfterSpawn();
    const failure = new Error('page context failed');
    const close = vi.fn().mockRejectedValue(new Error('browser close failed'));
    mocks.launch.mockResolvedValue({ newContext: vi.fn().mockRejectedValue(failure), close });
    kill.mockImplementation(() => { throw new Error('server cleanup failed'); });
    mocks.write.mockImplementation((file) => {
      if (String(file).replaceAll('\\', '/').endsWith('/report.json')) throw new Error('latest report write failed');
    });
    expect(await run()).toBe(failure);
    expect(close).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledOnce();
    expect(mocks.write).toHaveBeenCalledTimes(2);
    expect(report(true).errors.map((item: { stage: string }) => item.stage)).toEqual([
      'page-audit', 'browser-cleanup', 'server-cleanup', 'report-write',
    ]);
    expect(process.exitCode).toBe(1);
  });

  it('Windows 仅按自启 PID 等待 taskkill，失败仍保留 launch 原因', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    readyAfterSpawn();
    const failure = new Error('browser launch failed');
    mocks.launch.mockRejectedValue(failure);
    mocks.spawn.mockImplementation((command) => {
      const child = server();
      if (command === 'taskkill') queueMicrotask(() => child.emit('exit', 5));
      return child;
    });
    expect(await run()).toBe(failure);
    expect(mocks.spawn).toHaveBeenLastCalledWith('taskkill', ['/pid', '81234', '/t', '/f'], { stdio: 'ignore' });
    expect(mocks.spawn.mock.calls[0][2]).toMatchObject({ detached: false });
    expect(report().errors.map((item: { stage: string }) => item.stage)).toEqual(['browser-launch', 'server-cleanup']);
    expect(kill).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('Windows 自启服务 readiness 失败也走相同的进程树清理', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unavailable'); }));
    mocks.spawn.mockImplementation((command) => {
      const child = server();
      if (command === 'taskkill') queueMicrotask(() => child.emit('exit', 0));
      return child;
    });
    expect(await run()).toBeInstanceOf(Error);
    expect(mocks.spawn).toHaveBeenLastCalledWith('taskkill', ['/pid', '81234', '/t', '/f'], { stdio: 'ignore' });
    expect(report()).toMatchObject({ errors: [{ stage: 'server-readiness' }] });
    expect(kill).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('context.close 失败仍保留已完成的部分矩阵', async () => {
    const failure = new Error('context close failed');
    const close = vi.fn().mockResolvedValue(undefined);
    mocks.launch.mockResolvedValue({ close, newContext: async () => ({
      close: async () => { throw failure; },
      newPage: async () => ({ goto: async () => ({ ok: () => false, status: () => 500 }) }),
    }) });
    expect(await run('--no-server')).toBe(failure);
    expect(report()).toMatchObject({ matrix: [{ findings: [{ kind: 'navigation' }] }], errors: [{ stage: 'page-audit' }], totals: { conditions: 1, findings: { fail: 2 } } });
    expect(close).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  });

  it('已执行的页面失败仍作为 matrix 失败退出，不伪装成启动成功或视觉通过', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    mocks.launch.mockResolvedValue({ close, newContext: async () => ({
      close: vi.fn(), newPage: async () => ({ goto: async () => ({ ok: () => false, status: () => 500 }) }),
    }) });
    expect(await run('--no-server', '--routes', '/dev/showroom')).toBeUndefined();
    expect(report()).toMatchObject({ errors: [], totals: { conditions: 6, findings: { fail: 6 } } });
    expect(close).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  });

  it('无故障的 stub 巡检保留完整矩阵和零退出；此处没有实际渲染页面', async () => {
    mocks.launch.mockResolvedValue({ close: vi.fn(), newContext: async () => ({
      close: vi.fn(), newPage: async () => ({
        goto: async () => ({ ok: () => true }), evaluate: async () => [], reload: vi.fn(),
        waitForLoadState: async () => {}, waitForTimeout: async () => {},
      }),
    }) });
    expect(await run('--no-server', '--routes', '/dev/showroom')).toBeUndefined();
    expect(report()).toMatchObject({ errors: [], totals: { conditions: 6, findings: { fail: 0 } } });
    expect(mocks.write).toHaveBeenCalledTimes(2);
    expect(kill).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it('归档写失败会补记到可写的 canonical report，并保持非零退出', async () => {
    const failure = new Error('archive write failed');
    mocks.launch.mockResolvedValue({ close: vi.fn() });
    mocks.write.mockImplementation((file) => {
      if (/report-.*\.json$/.test(String(file))) throw failure;
    });
    expect(await run('--no-server', '--routes', ',')).toBe(failure);
    expect(mocks.write).toHaveBeenCalledTimes(3);
    expect(report()).toMatchObject({ errors: [{ stage: 'report-write' }], totals: { findings: { fail: 1 } } });
    expect(process.exitCode).toBe(1);
  });
});

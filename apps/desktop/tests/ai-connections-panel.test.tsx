// @vitest-environment jsdom
// AiConnectionsPanel 连接测试的 run-identity 回归（D5.0b-r2）：
// P1 测试在途 → 用户切到 P2 → P1 的迟到终态不得写进 P2 的 UI。
// 同时钉住「取消测试」真实 abort 语义与切换时的清理行为。

import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiExecutionResult } from '@mahoshojo/ai-core/stream-events';
import type { DirectProviderProfileV1 } from '@mahoshojo/contracts/provider-profile';
import { DESKTOP_AI_CONFIG_STORAGE_KEY } from '../src/features/ai-config/desktop-ai-config-store';
import { getDesktopAiConfigStore, resetDesktopAiConfigStoreForTests } from '../src/features/ai-config/use-desktop-ai-config';
import { AiConnectionsPanel } from '../src/features/ai-config/AiConnectionsPanel';

const mocks = vi.hoisted(() => ({ execute: vi.fn(), responsesPreset: false }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === 'has_provider_secret') return false;
    return undefined;
  }),
}));

const profiles: Record<string, DirectProviderProfileV1> = {
  p1: {
    version: 1,
    id: 'p1',
    name: '一号',
    adapter: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434/v1',
    modelId: 'm1',
    createdAt: '2026-10-05T00:00:00.000Z',
    updatedAt: '2026-10-05T00:00:00.000Z',
  },
  p2: {
    version: 1,
    id: 'p2',
    name: '二号',
    adapter: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:1234/v1',
    modelId: 'm2',
    createdAt: '2026-10-05T00:00:00.000Z',
    updatedAt: '2026-10-05T00:00:00.000Z',
  },
};

vi.mock('../src/platform/provider-profile-bridge', () => ({
  listProviderProfileIds: async () => ['p1', 'p2'],
  getProviderProfile: async (_invoke: unknown, id: string) => profiles[id] ?? null,
  saveProviderProfile: async () => undefined,
  deleteProviderProfile: async () => undefined,
  validateProviderExecutionProfile: async (_invoke: unknown, doc: unknown) => doc,
}));

// 只替换测试目录输入；实际能力判定、复制 mapper 和连接编辑器保持真实实现。
vi.mock('../src/features/ai-config/desktop-ai-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/features/ai-config/desktop-ai-config')>();
  return {
    ...actual,
    listDesktopPresetEntries: (hidden: ReadonlySet<string>) => {
      if (!mocks.responsesPreset) return actual.listDesktopPresetEntries(hidden);
      return [actual.describeDesktopPresetEntry({
        id: 'fixture-responses-preset', name: '合成 Responses 预设', description: '仅测试目录输入',
        docsUrl: 'https://example.com/protocol', baseUrl: 'https://legacy.example/v1', type: 'openai',
        endpointKind: 'provider-public',
        direct: { adapter: 'openai-responses', baseUrl: 'https://responses.example/v1', reviewedAt: '2026-10-23' },
        models: [{ value: 'fixture-response-model', label: '合成模型', description: '仅测试模型' }],
      }, false)];
    },
  };
});

vi.mock('../src/platform/desktop-ai-execution', () => ({
  createDesktopAiExecutionPort: () => ({ execute: mocks.execute }),
}));

let root: Root;
let container: HTMLDivElement;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
const button = (name: string) =>
  [...container.querySelectorAll('button')].find((item) => item.textContent === name);
const cancelledResult: AiExecutionResult = {
  status: 'cancelled',
  requestId: 'r1',
  contractVersion: 1,
  mode: 'direct-local',
  reason: 'aborted',
};

const selectConnection = async (profileId: string) => {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!;
  await act(async () => trigger.click());
  await settle();
  const profiles = getDesktopAiConfigStore().getSnapshot().profiles;
  const profile = profiles.find((item) => item.id === profileId)!;
  const option = [...container.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.includes(profile.name))!;
  await act(async () => option.click());
  await settle();
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.responsesPreset = false;
  window.localStorage.clear();
  window.localStorage.setItem(DESKTOP_AI_CONFIG_STORAGE_KEY, JSON.stringify({
    version: 2,
    selection: { executionPreference: 'client', clientConnectionId: 'p1' },
    hiddenPresetIds: [],
  }));
  resetDesktopAiConfigStoreForTests();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const mount = async () => {
  await act(async () => root.render(<StrictMode><AiConnectionsPanel /></StrictMode>));
  await settle();
};

describe('AiConnectionsPanel connection test', () => {
  it('copies a Responses preset into the actual editor without downgrading its protocol', async () => {
    mocks.responsesPreset = true;
    await mount();
    await act(async () => button('复制为自定义连接')!.click());
    const protocol = [...container.querySelectorAll('label')]
      .find((label) => label.textContent?.includes('API 协议'))?.querySelector('select');
    expect(protocol?.value).toBe('openai-responses');
    const values = [...container.querySelectorAll<HTMLInputElement>('input')].map((input) => input.value);
    expect(values).toContain('https://responses.example/v1');
    expect(values).toContain('fixture-response-model');
    expect(values).not.toContain('https://legacy.example/v1');
    // 复制只创建草稿，不隐式保存或更换当前连接。
    expect(getDesktopAiConfigStore().getSnapshot().selection.clientConnectionId).toBe('p1');
    expect(getDesktopAiConfigStore().getSnapshot().profiles).toHaveLength(2);
  });


  it('cancels a running test via the cancel button', async () => {
    let finish!: (result: AiExecutionResult) => void;
    mocks.execute.mockImplementation(
      () => new Promise<AiExecutionResult>((resolve) => { finish = resolve; }),
    );
    await mount();

    await act(async () => button('测试当前连接')!.click());
    await settle();
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(button('取消测试')).toBeTruthy();

    await act(async () => button('取消测试')!.click());
    expect(mocks.execute.mock.calls[0]![1].aborted).toBe(true);
    await act(async () => finish(cancelledResult));
    await settle();
    expect(container.textContent).toContain('测试已取消');
    expect(button('测试当前连接')).toBeTruthy();
  });

  it('discards the late terminal state of a test whose target was switched away', async () => {
    let finishP1!: (result: AiExecutionResult) => void;
    mocks.execute.mockImplementation(
      () => new Promise<AiExecutionResult>((resolve) => { finishP1 = resolve; }),
    );
    await mount();

    await act(async () => button('测试当前连接')!.click());
    await settle();
    expect(mocks.execute).toHaveBeenCalledTimes(1);

    // 切到 p2：效果应立即 abort P1 并把测试 UI 复位为 idle。
    await selectConnection('p2');
    expect(mocks.execute.mock.calls[0]![1].aborted).toBe(true);
    expect(container.textContent).not.toContain('测试已取消');

    // P1 的 cancelled 迟到达：run identity 已过期，不得在新目标上显示「测试已取消」。
    await act(async () => finishP1(cancelledResult));
    await settle();
    expect(container.textContent).not.toContain('测试已取消');
    expect(container.textContent).toContain('二号');
    expect(button('测试当前连接')).toBeTruthy();
  });
});

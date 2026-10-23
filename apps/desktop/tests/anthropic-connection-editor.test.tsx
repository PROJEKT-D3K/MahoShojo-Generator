// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectProviderProfileV1Schema } from '@mahoshojo/contracts/provider-profile';
import { getModelGenerationCapabilities } from '@mahoshojo/ai-core/generation-settings';
import { ConnectionEditor, draftFromProfile, saveConnectionDraft } from '../src/features/ai-config/connection-editor';
import { DesktopAiConfigStore } from '../src/features/ai-config/desktop-ai-config-store';
import { resolveDesktopAiTarget } from '../src/features/ai-config/desktop-ai-config';
import { getDesktopGenerationCapabilities } from '../src/features/providers/protocol-capabilities';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });

const draft = { id: 'messages-ui', name: 'Messages', baseUrl: 'https://model.example/prefix/v1/', modelId: 'model-default' };
const button = (label: string) => [...container.querySelectorAll('button')].find((item) => item.textContent === label)!;
const select = async (value: string) => {
  await act(async () => {
    const select = container.querySelector('select')!;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
};
const render = async (onSave: Parameters<typeof ConnectionEditor>[0]['onSave']) => {
  await act(async () => root.render(<ConnectionEditor
    editing={{ draft, presetModels: null, isExisting: false, hasKeyRef: false }}
    existingSecretKnown={false} saving={false} saveLabel="保存并使用" onCancel={vi.fn()} onSave={onSave}
  />));
};

describe('Messages shared connection editor and capabilities', () => {
  it('saves, restarts, selects a custom model and switches protocols without changing historical overrides', async () => {
    const documents = new Map<string, string>();
    const overlay = new Map<string, string>();
    const deps = {
      storage: { getItem: (key: string) => overlay.get(key) ?? null, setItem: (key: string, value: string) => { overlay.set(key, value); }, removeItem: (key: string) => { overlay.delete(key); } },
      invoke: async (command: string, args?: Record<string, unknown>) => {
        if (command === 'list_provider_profile_ids') return [...documents.keys()];
        if (command === 'get_provider_profile') return documents.get(args?.profileId as string) ?? null;
        if (command === 'validate_provider_execution_profile') return JSON.parse(args?.document as string);
        if (command === 'save_provider_profile') {
          const profile = DirectProviderProfileV1Schema.parse(JSON.parse(args?.document as string));
          documents.set(profile.id, JSON.stringify(profile)); return undefined;
        }
        if (command === 'has_provider_secret') return false;
        throw new Error(`Unexpected command ${command}`);
      },
    };
    const store = new DesktopAiConfigStore(deps);
    store.init();
    await vi.waitFor(() => expect(store.getSnapshot().profilesState).toBe('ready'));
    await render((draft) => saveConnectionDraft(store, draft, { activate: true }));
    expect(container.querySelector('select')!.value).toBe('openai-compatible');
    expect([...container.querySelectorAll('option')].map(option => option.value)).not.toContain('google');
    await select('anthropic');
    for (const hint of ['API 根路径', '/messages', '2026-10-21', '4096', 'x-api-key', 'temperature', 'Thinking / effort', '非供应商结构化输出保证']) {
      expect(container.textContent).toContain(hint);
    }
    await act(async () => button('保存并使用').click());
    const original = DirectProviderProfileV1Schema.parse(JSON.parse(documents.get(draft.id)!));
    expect(original).toMatchObject({ adapter: 'anthropic', baseUrl: draft.baseUrl });
    const overrides = { temperature: 0.9, maxOutputTokens: 6000, thinking: { mode: 'enabled' as const, effort: 'high' as const } };
    store.addCustomModel(draft.id, 'arbitrary-model');
    store.selectModel(draft.id, 'arbitrary-model');
    store.setGenerationOverrides(draft.id, 'arbitrary-model', overrides);
    const restarted = new DesktopAiConfigStore(deps);
    restarted.init();
    await vi.waitFor(() => expect(restarted.getSnapshot().profilesState).toBe('ready'));
    const state = restarted.getSnapshot();
    const target = resolveDesktopAiTarget(state.selection, state.profiles, state.generationOverrides, state.modelsByProfileId);
    expect(target).toMatchObject({ mode: 'direct-remote', modelId: 'arbitrary-model', generationOverrides: overrides, unavailableReason: null });
    expect(draftFromProfile(target.profile!).adapter).toBe('anthropic');
    await restarted.saveConnection({ ...draftFromProfile(target.profile!), adapter: 'openai-compatible' });
    expect(restarted.getSnapshot().generationOverrides[draft.id]?.['arbitrary-model']).toEqual(overrides);
    await restarted.saveConnection({ ...draftFromProfile(original), adapter: 'anthropic' });
    expect(restarted.getSnapshot().generationOverrides[draft.id]?.['arbitrary-model']).toEqual(overrides);
    expect(restarted.getSnapshot().modelsByProfileId[draft.id]?.selectedModelId).toBe('arbitrary-model');
  });

  it('retains the Messages draft and error on a failed save', async () => {
    const onSave = vi.fn(async () => { throw new Error('版本 header 冲突'); });
    await render(onSave);
    await select('anthropic');
    await act(async () => button('保存并使用').click());
    expect(container.querySelector('select')!.value).toBe('anthropic');
    expect(container.querySelector<HTMLInputElement>('input[placeholder="https://api.anthropic.com/v1"]')!.value).toBe(draft.baseUrl);
    expect(container.textContent).toContain('保存失败：版本 header 冲突');
    expect(onSave).toHaveBeenCalledExactlyOnceWith({ ...draft, adapter: 'anthropic', allowPublicHttp: undefined });
  });

  it('overlays protocol constraints even when the custom identity happens to match a known model capability', () => {
    const prior = getModelGenerationCapabilities('openrouter', 'anthropic/claude-sonnet-4.6');
    const projected = getDesktopGenerationCapabilities('openrouter', 'anthropic/claude-sonnet-4.6', 'anthropic');
    expect(projected.temperature).toMatchObject({ support: 'unsupported', disabled: true });
    expect(projected.thinking).toMatchObject({ support: 'unsupported', canDisable: false });
    expect(projected.maxOutputTokens).toMatchObject({ support: 'supported' });
    expect(projected.maxOutputTokens).not.toHaveProperty('max');
    expect(getDesktopGenerationCapabilities('openrouter', 'anthropic/claude-sonnet-4.6', 'openai-compatible')).toEqual(prior);
    expect(getDesktopGenerationCapabilities('openrouter', 'anthropic/claude-sonnet-4.6', 'openai-responses')).toEqual(prior);
  });
});

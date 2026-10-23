// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectProviderProfileV1Schema } from '@mahoshojo/contracts/provider-profile';
import { ConnectionEditor, draftFromProfile, saveConnectionDraft, type EditingState } from '../src/features/ai-config/connection-editor';
import { DesktopAiConfigStore } from '../src/features/ai-config/desktop-ai-config-store';
import { resolveDesktopAiTarget } from '../src/features/ai-config/desktop-ai-config';

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

const draft = { id: 'google-cloudflare', name: 'My Gemini', baseUrl: 'https://model.example/prefix/v1beta/', modelId: 'gemini-3.6-flash' };
const button = (label: string) => [...container.querySelectorAll('button')].find((item) => item.textContent === label)!;
const select = async (value: string) => {
  await act(async () => {
    const select = container.querySelector('select')!;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
};
const input = async (element: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const render = async (onSave: Parameters<typeof ConnectionEditor>[0]['onSave'], editing: EditingState = { draft, presetModels: null, isExisting: false, hasKeyRef: false }) => {
  await act(async () => root.render(<ConnectionEditor key={editing.isExisting ? 'edit' : 'new'}
    editing={editing} existingSecretKnown={editing.hasKeyRef} saving={false}
    saveLabel="保存连接" onCancel={vi.fn()} onSave={onSave}
  />));
};
const createStorage = () => {
  const documents = new Map<string, string>();
  const overlay = new Map<string, string>();
  const secrets = new Set<string>();
  const flags = { failSave: false };
  const deps = {
    storage: { getItem: (key: string) => overlay.get(key) ?? null, setItem: (key: string, value: string) => { overlay.set(key, value); }, removeItem: (key: string) => { overlay.delete(key); } },
    invoke: async (command: string, args?: Record<string, unknown>) => {
      if (command === 'list_provider_profile_ids') return [...documents.keys()];
      if (command === 'get_provider_profile') return documents.get(args?.profileId as string) ?? null;
      if (command === 'validate_provider_execution_profile') return JSON.parse(args?.document as string);
      if (command === 'save_provider_profile') {
        if (flags.failSave) throw new Error('保存事务失败');
        const profile = DirectProviderProfileV1Schema.parse(JSON.parse(args?.document as string));
        documents.set(profile.id, JSON.stringify(profile)); return undefined;
      }
      if (command === 'set_provider_secret') { secrets.add(args?.secretRef as string); return undefined; }
      if (command === 'delete_provider_secret') { secrets.delete(args?.secretRef as string); return undefined; }
      if (command === 'has_provider_secret') return secrets.has(args?.secretRef as string);
      throw new Error(`Unexpected command ${command}`);
    },
  };
  return { deps, documents, overlay, secrets, flags };
};

describe('GenerateContent shared connection editor', () => {
  it('saves and reopens Google, adds a same-name model and preserves preferences across protocol changes and restart', async () => {
    const native = createStorage();
    const store = new DesktopAiConfigStore(native.deps);
    store.init();
    await vi.waitFor(() => expect(store.getSnapshot().profilesState).toBe('ready'));
    await render((draft) => saveConnectionDraft(store, draft, { activate: true }));
    await select('google');
    for (const hint of ['streamGenerateContent', 'x-goog-api-key', '0–2', '暂不发送 Thinking', '跟随上游默认', '本地 JSON/schema 校验', '不要在 URL 中放 API Key']) {
      expect(container.textContent).toContain(hint);
    }
    expect(container.textContent).not.toContain('4096');
    await act(async () => button('保存连接').click());
    const original = DirectProviderProfileV1Schema.parse(JSON.parse(native.documents.get(draft.id)!));
    expect(original).toMatchObject({ adapter: 'google', baseUrl: draft.baseUrl });
    const overrides = { temperature: 1.3, maxOutputTokens: 6000, thinking: { mode: 'disabled' as const } };
    store.addCustomModel(draft.id, 'gemini-3.8-flash');
    expect(() => store.addCustomModel(draft.id, 'gemini-3.8-flash')).toThrow('该模型已在当前连接的模型列表中');
    store.selectModel(draft.id, 'gemini-3.8-flash');
    store.setGenerationOverrides(draft.id, 'gemini-3.8-flash', overrides);
    expect(store.getSnapshot().modelsByProfileId[draft.id]?.customModelIds).toEqual(['gemini-3.8-flash']);
    const restarted = new DesktopAiConfigStore(native.deps);
    restarted.init();
    await vi.waitFor(() => expect(restarted.getSnapshot().profilesState).toBe('ready'));
    const state = restarted.getSnapshot();
    const target = resolveDesktopAiTarget(state.selection, state.profiles, state.generationOverrides, state.modelsByProfileId);
    expect(target).toMatchObject({ mode: 'direct-remote', modelId: 'gemini-3.8-flash', generationOverrides: overrides, unavailableReason: null });
    await render((draft) => saveConnectionDraft(restarted, draft), { draft: draftFromProfile(target.profile!), presetModels: null, isExisting: true, hasKeyRef: false });
    expect(container.querySelector('select')!.value).toBe('google');
    await select('openai-compatible');
    await act(async () => button('保存连接').click());
    expect(restarted.getSnapshot().generationOverrides[draft.id]?.['gemini-3.8-flash']).toEqual(overrides);
    await select('google');
    await act(async () => button('保存连接').click());
    expect(restarted.getSnapshot().profiles[0]?.adapter).toBe('google');
    expect(restarted.getSnapshot().generationOverrides[draft.id]?.['gemini-3.8-flash']).toEqual(overrides);
    expect(restarted.getSnapshot().modelsByProfileId[draft.id]?.selectedModelId).toBe('gemini-3.8-flash');
  });

  it('retains a failed replacement-key draft while the persisted Google profile and original key remain intact', async () => {
    const native = createStorage();
    const store = new DesktopAiConfigStore(native.deps);
    store.init();
    await vi.waitFor(() => expect(store.getSnapshot().profilesState).toBe('ready'));
    await store.saveConnection({ ...draft, adapter: 'google', apiKey: 'synthetic-original-key' });
    const original = DirectProviderProfileV1Schema.parse(JSON.parse(native.documents.get(draft.id)!));
    native.flags.failSave = true;
    await render((draft) => saveConnectionDraft(store, draft), { draft: draftFromProfile(original), presetModels: null, isExisting: true, hasKeyRef: true });
    await input(container.querySelector<HTMLInputElement>('input[type="password"]')!, 'synthetic-replacement-key');
    await act(async () => button('保存连接').click());
    expect(container.textContent).toContain('保存失败：save_provider_profile: 本机通信失败（ipc-call-failed）');
    expect(container.querySelector('select')!.value).toBe('google');
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('synthetic-replacement-key');
    expect(JSON.parse(native.documents.get(draft.id)!)).toEqual(original);
    expect([...native.secrets]).toEqual([original.apiKeyRef]);
    expect(JSON.stringify([...native.overlay])).not.toContain('synthetic-replacement-key');
  });
});

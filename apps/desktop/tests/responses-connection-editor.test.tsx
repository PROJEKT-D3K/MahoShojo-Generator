// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectProviderProfileV1Schema, type DirectProviderProfileV1 } from '@mahoshojo/contracts/provider-profile';
import { ConnectionEditor, draftFromProfile, saveConnectionDraft } from '../src/features/ai-config/connection-editor';
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
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const freshDraft = () => ({ id: 'responses-ui', name: 'Responses UI', baseUrl: 'http://127.0.0.1:18080/v1', modelId: 'synthetic-model' });
const renderEditor = async (onSave: Parameters<typeof ConnectionEditor>[0]['onSave'], onCancel = vi.fn()) => {
  await act(async () => root.render(<ConnectionEditor
    editing={{ draft: freshDraft(), presetModels: null, isExisting: false, hasKeyRef: false }}
    existingSecretKnown={false} saving={false} saveLabel="保存并使用" onCancel={onCancel} onSave={onSave}
  />));
};
const selectResponses = async () => {
  const select = container.querySelector('select')!;
  await act(async () => {
    select.value = 'openai-responses';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
};
const button = (label: string) => [...container.querySelectorAll('button')].find((item) => item.textContent === label)!;

describe('Responses shared connection editor', () => {
  it('submits the chosen protocol through real save, activation and reopened draft', async () => {
    const documents = new Map<string, string>();
    const overlay = new Map<string, string>();
    const calls: string[] = [];
    const store = new DesktopAiConfigStore({
      storage: { getItem: (key) => overlay.get(key) ?? null, setItem: (key, value) => { overlay.set(key, value); }, removeItem: (key) => { overlay.delete(key); } },
      invoke: async (command, args) => {
        calls.push(command);
        if (command === 'list_provider_profile_ids') return [...documents.keys()];
        if (command === 'get_provider_profile') return documents.get(args?.profileId as string) ?? null;
        if (command === 'validate_provider_execution_profile') return JSON.parse(args?.document as string);
        if (command === 'save_provider_profile') {
          const profile = DirectProviderProfileV1Schema.parse(JSON.parse(args?.document as string));
          documents.set(profile.id, JSON.stringify(profile));
          return undefined;
        }
        if (command === 'has_provider_secret') return false;
        throw new Error(`Unexpected command ${command}`);
      },
    });
    store.init();
    await vi.waitFor(() => expect(store.getSnapshot().profilesState).toBe('ready'));
    await renderEditor((draft) => saveConnectionDraft(store, draft, { activate: true }));
    expect([...container.querySelectorAll('option')].map((option) => option.value)).toEqual(['openai-compatible', 'openai-responses', 'anthropic']);
    await selectResponses();
    await act(async () => button('保存并使用').click());
    const profile = DirectProviderProfileV1Schema.parse(JSON.parse(documents.get('responses-ui')!));
    expect(profile.adapter).toBe('openai-responses');
    expect(calls.indexOf('validate_provider_execution_profile')).toBeLessThan(calls.indexOf('save_provider_profile'));
    expect(calls).not.toContain('set_provider_secret');
    expect(store.getSnapshot().selection.clientConnectionId).toBe(profile.id);
    expect(resolveDesktopAiTarget(store.getSnapshot().selection, [profile], {}, {}).unavailableReason).toBeNull();
    await act(async () => root.render(<ConnectionEditor key="reopened"
      editing={{ draft: draftFromProfile(profile), presetModels: null, isExisting: true, hasKeyRef: false }}
      existingSecretKnown={false} saving={false} saveLabel="保存连接" onCancel={vi.fn()} onSave={vi.fn()}
    />));
    expect(container.querySelector('select')!.value).toBe('openai-responses');
  });

  it('treats a protocol-only change as unsaved and preserves it when discard is refused', async () => {
    const cancel = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await renderEditor(vi.fn(), cancel);
    await selectResponses();
    await act(async () => button('取消').click());
    expect(confirm).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
    expect(container.querySelector('select')!.value).toBe('openai-responses');
  });

  it('copies Responses identity into the draft without copying plaintext credentials', () => {
    const profile: DirectProviderProfileV1 = { version: 1, ...freshDraft(), adapter: 'openai-responses', apiKeyRef: 'provider:responses-ui:api-key', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' };
    expect(draftFromProfile(profile)).toMatchObject({ adapter: 'openai-responses', modelId: profile.modelId, baseUrl: profile.baseUrl });
    expect(draftFromProfile(profile)).not.toHaveProperty('apiKey');
  });
});

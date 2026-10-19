import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getModelGenerationCapabilities } from '../packages/ai-core/src/generation-settings/model-capabilities';
import { AI_PROVIDER_PRESETS, AI_PROVIDER_MODEL_ALIASES, describeAiPresetModelDirectWire } from '../packages/ai-core/src/provider-catalog';

describe('native provider authority', () => {
  it('runs the real Node CLI with transitive TS schemas from any working directory', () => {
    expect(() => execFileSync(process.execPath, [
      fileURLToPath(new URL('../scripts/generate-desktop-provider-catalog.mjs', import.meta.url)),
      '--check',
    ], { cwd: tmpdir(), stdio: 'pipe' })).not.toThrow();
  });
  const native = JSON.parse(readFileSync(new URL('../apps/desktop/src-tauri/src/generated/provider-presets.json', import.meta.url), 'utf8'));
  it('tracks every preset and its verified protocol exactly', () => {
    expect(native.map((entry: { id: string }) => entry.id)).toEqual(AI_PROVIDER_PRESETS.map((preset) => preset.id));
    for (const preset of AI_PROVIDER_PRESETS) {
      const entry = native.find((value: { id: string }) => value.id === preset.id);
      expect(entry.baseUrl).toBe(preset.baseUrl);
      expect(entry.providerType).toBe(preset.type);
      expect(entry.modelAliases).toEqual(AI_PROVIDER_MODEL_ALIASES[preset.id] ?? {});
      expect(entry.endpointKind).toBe(preset.endpointKind);
      expect(entry.structuredOutput).toBe(preset.structuredOutput);
      // 已核验 wire 与 preset.baseUrl 分轨时生成 directBaseUrl（如 Google openai 面）。
      expect(entry.directBaseUrl ?? null).toBe(preset.direct?.baseUrl ?? null);
      expect(entry.models.map((model: { id: string }) => model.id)).toEqual(preset.models.map((model) => model.value));
      for (const model of [...preset.models, { value: 'not-a-catalog-model' }]) {
        const wire = describeAiPresetModelDirectWire(preset, model.value);
        const nativeModel = entry.models.find((value: { id: string }) => value.id === model.value);
        expect(nativeModel?.omitTemperature === true).toBe(
          getModelGenerationCapabilities(preset.id, model.value).temperature.support === 'unsupported',
        );
        const modelDirect = preset.models.find((value) => value.value === model.value)?.direct;
        expect(nativeModel?.directBaseUrl ?? null).toBe(
          modelDirect !== undefined && modelDirect !== 'none' ? modelDirect.baseUrl ?? null : null,
        );
        const nativeAdapter = nativeModel?.adapter ?? entry.adapter;
        const nativeSupports = entry.endpointKind === 'provider-public' && nativeAdapter === 'openai-compatible';
        expect(nativeSupports, `${preset.id}/${model.value}`).toBe(wire.status === 'verified' && wire.adapter === 'openai-compatible');
      }
    }
  });
});

import { getModelGenerationCapabilities } from '@mahoshojo/ai-core/generation-settings';
import { resolveGenerationSettings } from '../src/node-runtime/generation-settings/resolve';

const resolve = (providerId: string, thinking: { mode: 'disabled' } | { mode: 'enabled'; effort: 'minimal' | 'low' | 'medium' | 'high' }) =>
  resolveGenerationSettings({
    providerId, modelId: 'gemini-3.8-flash',
    userOverrides: { temperature: 0.7, maxOutputTokens: 100_000, thinking },
  });

describe('Gemini 3.8 Flash 精确能力', () => {
  it('Google 原生仅 low/medium/high，不能关闭，不发送 temperature，输出上限 65536', () => {
    const caps = getModelGenerationCapabilities('google-cloudflare', 'gemini-3.8-flash');
    expect(caps.thinking.efforts).toEqual(['low', 'medium', 'high']);
    expect(caps.thinking.canDisable).toBe(false);
    const disabled = resolve('google-cloudflare', { mode: 'disabled' });
    expect(disabled.standardOptions).toEqual({ maxOutputTokens: 65_536 });
    expect(disabled.providerOptions).toBeUndefined();
    expect(disabled.thinkingResolution.disposition).toBe('cannot-disable');
    for (const effort of ['low', 'medium', 'high'] as const) {
      expect(resolve('google-cloudflare', { mode: 'enabled', effort }).providerOptions).toMatchObject({
        google: { thinkingConfig: { thinkingLevel: effort } },
      });
    }
  });

  it('minimal 不穿透 Google wire，3.6 Flash 仍保留既有 minimal', () => {
    const result = resolve('google-cloudflare', { mode: 'enabled', effort: 'minimal' });
    expect(result.diagnostics.warnings).toHaveLength(1);
    expect(JSON.stringify(result.providerOptions)).not.toContain('minimal');
    expect(getModelGenerationCapabilities('google-cloudflare', 'gemini-3.6-flash').thinking.efforts).toContain('minimal');
  });

  it('system 仅通用上限，Kouri等中转不继承 Google 专属参数', () => {
    const system = resolve('system', { mode: 'enabled', effort: 'high' });
    expect(system.standardOptions).toEqual({ maxOutputTokens: 65_536 });
    expect(system.providerOptions).toBeUndefined();
    for (const providerId of ['kourichat', 'poe', 'intern-discovery', 'sta1n']) {
      expect(resolve(providerId, { mode: 'enabled', effort: 'high' }).providerOptions).toBeUndefined();
    }
  });
});

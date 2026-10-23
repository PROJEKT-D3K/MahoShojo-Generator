import { describe, expect, it } from 'vitest';
import { getModelGenerationCapabilities } from '@mahoshojo/ai-core/generation-settings';
import {
  DESKTOP_DIRECT_ADAPTERS,
  DESKTOP_EDITABLE_PROFILE_ADAPTERS,
  DESKTOP_PRESET_DIRECT_ADAPTERS,
  getDesktopGenerationCapabilities,
} from '../src/features/providers/protocol-capabilities';

describe('GenerateContent custom protocol capabilities', () => {
  it('opens custom execution and editing without expanding preset protocol eligibility', () => {
    expect(DESKTOP_DIRECT_ADAPTERS.has('google')).toBe(true);
    expect(DESKTOP_EDITABLE_PROFILE_ADAPTERS.has('google')).toBe(true);
    expect(DESKTOP_PRESET_DIRECT_ADAPTERS.has('google')).toBe(false);
  });

  it.each(['gemini-3.6-flash', 'gemini-2.5-flash', 'arbitrary-model'])('does not borrow preset parameter authority for the same custom model name %s', (modelId) => {
    const projected = getDesktopGenerationCapabilities('google-cloudflare', modelId, 'google');
    expect(projected.temperature).toMatchObject({ support: 'unknown', min: 0, max: 2 });
    expect(projected.temperature.disabled).not.toBe(true);
    expect(projected.thinking).toMatchObject({ support: 'unsupported', canDisable: false });
    expect(projected.thinking.hint).toContain('已保存的推理偏好保留');
    expect(projected.maxOutputTokens).toMatchObject({ support: 'supported' });
    expect(projected.maxOutputTokens).not.toHaveProperty('max');
    expect(projected.maxOutputTokens.hint).toContain('跟随上游默认');
    expect(projected.maxOutputTokens.hint).not.toContain('4096');
    expect(getDesktopGenerationCapabilities('google-cloudflare', modelId)).toEqual(getModelGenerationCapabilities('google-cloudflare', modelId));
  });
});

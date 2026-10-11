import { z } from 'zod/v3';
import { findAiProviderPreset } from '@mahoshojo/ai-core/provider-catalog';
import { getModelGenerationCapabilities } from '@mahoshojo/ai-core/generation-settings';
import { createNodeStructuredAiRuntime, createNodeRawStreamAiRuntime } from '../src/node-runtime';
import { resolveGenerationSettings } from '../src/node-runtime/generation-settings/resolve';

const config = {
  systemPrompt: 'Return the requested record.',
  promptBuilder: () => 'The result is true.',
  schema: z.object({ ok: z.boolean() }),
  taskName: '预设文本 JSON 兼容测试',
};

describe.each(['intern-discovery', 'sta1n'])('%s 显式能力与真实 SDK 出站', (providerId) => {
  const preset = findAiProviderPreset(providerId)!;
  it.each([...preset.models.map((model) => model.value), 'custom-model'])(
    '%s 不继承同名官方模型的 thinking wire 或上下文上限', (modelId) => {
      expect(getModelGenerationCapabilities(preset.id, modelId).maxOutputTokens.max).toBeUndefined();
      for (const thinking of [{ mode: 'default' }, { mode: 'disabled' }, { mode: 'enabled', effort: 'high' }] as const) {
        const resolved = resolveGenerationSettings({ providerId: preset.id, modelId, userOverrides: { thinking } });
        expect(resolved.providerOptions).toBeUndefined();
        expect(resolved.thinkingResolution.disposition).toBe(thinking.mode === 'default' ? 'default' : providerId === 'intern-discovery' ? 'unsupported' : 'unknown');
      }
    },
  );

  it.each([preset.models[0].value, 'custom-model'])(
    '%s 首次请求即文本 JSON，不发送 schema/tools/思考字段，仍本地校验', async (modelId) => {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
        id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: modelId,
        choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }), { headers: { 'content-type': 'application/json' } }));
      const runtime = createNodeStructuredAiRuntime({ providers: [], fetch: fetchImpl });
      await expect(runtime.generateWithAI('input', config, {
        providerOverride: {
          name: preset.name, providerId: preset.id, baseUrl: preset.baseUrl, type: preset.type,
          model: modelId, apiKey: 'mock-key', retryCount: 1,
          generationOverrides: { thinking: { mode: 'enabled', effort: 'high' } },
        },
      })).resolves.toEqual({ ok: true });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(String(url)).toBe(`${preset.baseUrl}/chat/completions`);
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe(modelId);
      for (const field of ['response_format', 'tools', 'tool_choice', 'reasoning', 'reasoning_effort', 'thinking', 'output_config']) {
        expect(body).not.toHaveProperty(field);
      }
      expect(body.messages).toEqual([{ role: 'user', content: expect.stringContaining('ok') }]);
    },
  );
  it('无效 schema 文本仍拒绝，不重放已发送的请求', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      id: 'invalid-json-test', object: 'chat.completion', created: 1, model: preset.models[0].value,
      choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":"wrong-type"}' }, finish_reason: 'stop' }],
    }), { headers: { 'content-type': 'application/json' } }));
    const runtime = createNodeStructuredAiRuntime({ providers: [], fetch: fetchImpl });
    await expect(runtime.generateWithAI('input', config, {
      providerOverride: {
        name: preset.name, providerId: preset.id, baseUrl: preset.baseUrl, type: preset.type,
        model: preset.models[0].value, apiKey: 'mock-key', retryCount: 1,
      },
    })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('SSE 使用 Chat 且不添加结构化或思考请求参数', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      'data: ' + JSON.stringify({ id: 'stream-test', model: preset.models[0].value, choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    ));
    const runtime = createNodeRawStreamAiRuntime({ providers: [], fetch: fetchImpl });
    const result = await runtime.generateWithStreamAI({ prompt: 'Hello' }, {
      providerOverride: {
        name: preset.name, providerId: preset.id, baseUrl: preset.baseUrl, type: preset.type,
        model: preset.models[0].value, apiKey: 'mock-key', retryCount: 1,
        generationOverrides: { thinking: { mode: 'disabled' } },
      },
    });
    expect(await result.response.text()).toBe('Hello');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe(`${preset.baseUrl}/chat/completions`);
    const body = JSON.parse(String(init.body));
    expect(body.stream).toBe(true);
    for (const field of ['response_format', 'tools', 'tool_choice', 'reasoning', 'reasoning_effort', 'thinking', 'output_config']) {
      expect(body).not.toHaveProperty(field);
    }
  });
});


it.each([
  { providerId: 'kourichat', baseUrl: 'https://api.kourichat.com/v1' },
  { providerId: 'intern-discovery', baseUrl: 'https://example.invalid/v1' },
  { providerId: 'custom-endpoint', baseUrl: 'https://discovery-api.intern-ai.org.cn/v1' },
])('旧预设与不匹配身份保持原结构化策略：$providerId/$baseUrl', async ({ providerId, baseUrl }) => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
    id: 'legacy-test', object: 'chat.completion', created: 1, model: 'plain-model',
    choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }],
  }), { headers: { 'content-type': 'application/json' } }));
  const runtime = createNodeStructuredAiRuntime({ providers: [], fetch: fetchImpl });
  await expect(runtime.generateWithAI('input', config, {
    providerOverride: { name: 'Existing', providerId, baseUrl, type: 'openai', model: 'plain-model', apiKey: 'mock-key', retryCount: 1 },
    generationSettingsContext: { providerId: 'intern-discovery' },
  })).resolves.toEqual({ ok: true });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
  expect(JSON.parse(String(init.body)).response_format.type).toBe('json_schema');
});

import { afterEach, expect, it, vi } from 'vitest';
import { AI_PROVIDER_CATALOG } from '@mahoshojo/ai-core/provider-catalog';
import { buildNovelAIPromptRewriteInstruction, NOVELAI_TEXT_PROVIDERS, rewriteNovelAIPrompt } from '@/lib/tachie/novelai-prompt';

const openAIResponse = (text = '1girl, blue hair, masterpiece', finish = 'stop') => ({
  id: 'test', object: 'chat.completion', created: 1, model: 'test',
  choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finish }],
  usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const getConfig = (type: 'openai' | 'deepseek' = 'openai') => {
  const provider = NOVELAI_TEXT_PROVIDERS.find((item) => item.type === type)!;
  return { provider, config: { providerId: provider.id, modelId: provider.models[0].value, apiKey: 'text-secret' } };
};
afterEach(() => vi.unstubAllGlobals());

it('按 V4.5 Curated / V5 Curated 分别设置语言、长度和质量规则', () => {
  const v45 = buildNovelAIPromptRewriteInstruction('nai-diffusion-4-5-curated', { addQualityTags: true });
  const v5 = buildNovelAIPromptRewriteInstruction('nai-diffusion-5-curated');
  const curated = buildNovelAIPromptRewriteInstruction('nai-diffusion-5-curated');
  expect(v45).toContain('512'); expect(v45).toContain('Translate Chinese'); expect(v45).toContain('rating:general');
  expect(v5).toContain('703'); expect(v5).toContain('spatial relationships'); expect(v5).not.toContain('location, very aesthetic');
  expect(curated).toContain('703'); expect(curated).toContain('220 English words');
  expect(() => buildNovelAIPromptRewriteInstruction('nai-diffusion-5-full')).toThrow('目前支持');
  expect(() => buildNovelAIPromptRewriteInstruction('constructor')).toThrow('目前支持');
});

it.each(['openai', 'deepseek'] as const)('%s 发出一次浏览器直连文本请求', async (type) => {
  const { provider, config } = getConfig(type);
  const body = openAIResponse();
  const fetchMock = vi.fn().mockImplementation(async () => response(body)); vi.stubGlobal('fetch', fetchMock);
  const controller = new AbortController();
  const result = await rewriteNovelAIPrompt(config, 'nai-diffusion-4-5-curated', '蓝发少女', controller.signal);
  expect(result).toBe('1girl, blue hair, masterpiece');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(new URL(String(url)).origin).toBe(new URL(provider.baseUrl).origin);
  expect(String(url)).toBe(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`);
  expect(init).toMatchObject({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal });
  expect(init.body).toContain('蓝发少女'); expect(init.body).toContain('512');
  const headers = new Headers(init.headers);
  expect(headers.get('cookie')).toBeNull();
  expect(headers.get('authorization')).toBe('Bearer text-secret');
});

it('OpenAI 推理模型使用兼容的角色与 completion 预算', async () => {
  const fetchMock = vi.fn().mockResolvedValue(response(openAIResponse())); vi.stubGlobal('fetch', fetchMock);
  await rewriteNovelAIPrompt({ ...getConfig().config, modelId: 'gpt-5.4' }, 'nai-diffusion-5-curated', 'source', new AbortController().signal);
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body).toMatchObject({ model: 'gpt-5.4', max_completion_tokens: 4096, messages: [{ role: 'developer' }, { role: 'user' }] });
  expect(body).not.toHaveProperty('max_tokens');
});

it('Google 官方预设直连走 OpenAI-compat 面而非 Gemini 原生 baseUrl', async () => {
  const provider = NOVELAI_TEXT_PROVIDERS.find((item) => item.id === 'google-cloudflare')!;
  expect(provider).toBeTruthy();
  const fetchMock = vi.fn().mockResolvedValue(response(openAIResponse())); vi.stubGlobal('fetch', fetchMock);
  await rewriteNovelAIPrompt(
    { providerId: provider.id, modelId: 'gemini-2.5-flash', apiKey: 'text-secret' },
    'nai-diffusion-5-curated', 'source', new AbortController().signal,
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  const body = JSON.parse(init.body);
  expect(body).toMatchObject({ model: 'gemini-2.5-flash', max_completion_tokens: 4096 });
  expect(body).not.toHaveProperty('max_tokens');
});

it('项目转发端点 mystery 不作为直连供应商，也不接受旧配置绕过', async () => {
  const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
  const provider = AI_PROVIDER_CATALOG.find((item) => item.id === 'mystery')!;
  expect(NOVELAI_TEXT_PROVIDERS.some((item) => item.id === 'mystery')).toBe(false);
  await expect(rewriteNovelAIPrompt({ providerId: 'mystery', modelId: provider.models[0].value, apiKey: 'secret' }, 'nai-diffusion-5-curated', 'source', new AbortController().signal)).rejects.toThrow('直连协议');
  expect(fetchMock).not.toHaveBeenCalled();
});

it('缺少 Content-Length 的超大响应也被限制', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...openAIResponse(), extra: 'x'.repeat(512 * 1024) })));
  await expect(rewriteNovelAIPrompt(getConfig().config, 'nai-diffusion-5-curated', 'source', new AbortController().signal)).rejects.toThrow('原提示词已保留');
});

it.each([401, 429, 500])('HTTP %i 不重试，不回显供应商错误或 Key', async (status) => {
  const fetchMock = vi.fn().mockImplementation(async () => response({ error: { message: 'text-secret leaked prompt', type: 'error', code: 'bad' } }, status));
  vi.stubGlobal('fetch', fetchMock);
  const error = await rewriteNovelAIPrompt(getConfig().config, 'nai-diffusion-5-curated', 'source', new AbortController().signal).catch((cause) => cause);
  expect(error).toBeInstanceOf(Error); expect(error.message).not.toContain('text-secret');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('截断输出不作为可应用的成功结果', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(openAIResponse('partial', 'length'))));
  await expect(rewriteNovelAIPrompt(getConfig().config, 'nai-diffusion-5-curated', 'source', new AbortController().signal)).rejects.toThrow('原提示词已保留');
});

it('取消原样传递到请求，不回放', async () => {
  const controller = new AbortController();
  const fetchMock = vi.fn().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    controller.abort();
  }));
  vi.stubGlobal('fetch', fetchMock);
  await expect(rewriteNovelAIPrompt(getConfig().config, 'nai-diffusion-5-curated', 'source', controller.signal)).rejects.toThrow('已取消');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('禁止隐式使用系统模型，也不允许空内容请求', async () => {
  const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
  await expect(rewriteNovelAIPrompt({ providerId: 'system', modelId: 'default', apiKey: '' }, 'nai-diffusion-5-curated', 'source', new AbortController().signal)).rejects.toThrow('自备 Key');
  await expect(rewriteNovelAIPrompt(getConfig().config, 'nai-diffusion-5-curated', '', new AbortController().signal)).rejects.toThrow('提示词');
  expect(fetchMock).not.toHaveBeenCalled();
});


it('采用标签、场景、逐人外观分工，并约束叙事阶段和 NovelAI 语法', () => {
  const instruction = buildNovelAIPromptRewriteInstruction('nai-diffusion-5-curated');
  expect(instruction).toContain('three compact blocks');
  expect(instruction).toContain('one English sentence per visible character');
  expect(instruction).toContain('latest clearly described visual moment');
  expect(instruction).toContain('rear view');
  expect(instruction).toContain('do not mix attributes between characters');
  expect(instruction).toContain('Preserve user-supplied NovelAI emphasis');
  expect(instruction).toContain('-1.5::monochrome::');
  expect(instruction).toContain('No tag database or model knowledge check');
  expect(instruction).toContain('Never put tags after Text:');
  expect(instruction).toContain('ultra complexity is not a universal quality improvement');
  expect(instruction).toContain('For a character-only description, keep a simple portrait');
  expect(instruction).toContain('Only for an explicit comic or multi-panel request');
  expect(instruction).toContain('static multi-view display');
  expect(instruction).toContain('This takes precedence over reorganization');
  expect(instruction).toContain('Only when monochrome or selective color is explicitly requested');
  expect(instruction).toContain('does not extract quoted lettering automatically');
});

it('默认不添加质量预设，显式开启后使用对应 Curated 质量词并去重', () => {
  const defaultInstruction = buildNovelAIPromptRewriteInstruction('nai-diffusion-5-curated');
  expect(defaultInstruction).toContain('Do not add a quality preset');
  expect(defaultInstruction).not.toContain('very aesthetic, masterpiece, no text');
  const enabled = buildNovelAIPromptRewriteInstruction('nai-diffusion-5-curated', { addQualityTags: true });
  expect(enabled).toContain('very aesthetic, masterpiece, no text');
  expect(enabled).toContain('deduplicating');
  expect(enabled).toContain('Omit a tag if it conflicts');
  expect(buildNovelAIPromptRewriteInstruction('nai-diffusion-4-5-curated')).toContain('Do not introduce V5-only');
});

it('补充要求和原文分别传入一次请求，兼容纯文本围栏并保留权重', async () => {
  const expected = '1girl, 1.2::red ribbon::, -1.5::monochrome::';
  const fetchMock = vi.fn().mockResolvedValue(response(openAIResponse('```text\n' + expected + '\n```')));
  vi.stubGlobal('fetch', fetchMock);
  const result = await rewriteNovelAIPrompt(getConfig().config, 'nai-diffusion-5-curated', '红发少女', new AbortController().signal, { requirements: '背面视角', addQualityTags: true });
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(JSON.parse(body.messages[1].content)).toEqual({ source: '红发少女', visualRequirements: '背面视角' });
  expect(body.messages[0].content).toContain('very aesthetic, masterpiece, no text');
  expect(result).toBe(expected);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each(['nai-diffusion-4-5-curated', 'nai-diffusion-5-curated'])('%s 在首次请求中保护完整画师串，包含无前缀别名及精确权重', async (model) => {
  const artists = '(artist:tianliang duohe fangdongye:0.9),artist:ciloranko,artist:noyu,noyu23386566,ningen mame,(artist:sho:0.826446),(sho lwlw:0.909091),(artist:kedama_milk:0.5),artist:dino,(artist:fkey:0.8),';
  const source = `${artists}\n蓝发少女站在雨中`;
  const output = '0.9::artist:tianliang duohe fangdongye::,artist:ciloranko,artist:noyu,noyu23386566,ningen mame,0.826446::artist:sho::,0.909091::sho lwlw::,0.5::artist:kedama_milk::,artist:dino,0.8::artist:fkey::\n1girl, blue hair, standing, rain';
  const fetchMock = vi.fn().mockResolvedValue(response(openAIResponse(output)));
  vi.stubGlobal('fetch', fetchMock);
  expect(await rewriteNovelAIPrompt(getConfig().config, model, source, new AbortController().signal, { addQualityTags: true })).toBe(output);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const { messages } = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(JSON.parse(messages[1].content).source).toBe(source);
  for (const rule of [
    'Artist preservation has priority over length targets',
    'unprefixed names or handles within the same artist list',
    'relative order, repetitions, emphasis scope and exact numeric weight without rounding',
    'Keep a leading artist block at the start',
    '(artist:name:0.9) becomes 0.9::artist:name::',
    'never the artist list, its aliases or weights',
    'preservation only outside protected artist entries',
  ]) expect(messages[0].content).toContain(rule);
});

it('过长补充要求与围栏内空输出不作为成功结果', async () => {
  const fetchMock = vi.fn().mockResolvedValue(response(openAIResponse('```text\n  \n```')));
  vi.stubGlobal('fetch', fetchMock);
  await expect(rewriteNovelAIPrompt(getConfig().config, 'nai-diffusion-5-curated', 'source', new AbortController().signal, { requirements: 'x'.repeat(2001) })).rejects.toThrow('补充要求');
  expect(fetchMock).not.toHaveBeenCalled();
  await expect(rewriteNovelAIPrompt(getConfig().config, 'nai-diffusion-5-curated', 'source', new AbortController().signal)).rejects.toThrow('原提示词已保留');
});

it.each([
  ['nai-diffusion-4-5-curated', 180, 118],
  ['nai-diffusion-5-curated', 220, 374],
] as const)('%s 将所有兼容性规则前置到唯一一次请求，响应不再校验或改写', async (model, wordBudget, textLimit) => {
  const output = `Prompt: ${'word '.repeat(221)}(red hair:1.2), no text, depthness, source#holding | BREAK\nCharacter 1: red hair\nUC: blur\ntext"hello"\nText: 欢迎${'a'.repeat(375)}`;
  const fetchMock = vi.fn().mockResolvedValue(response(openAIResponse(output)));
  vi.stubGlobal('fetch', fetchMock);
  expect(await rewriteNovelAIPrompt(getConfig().config, model, '角色与招牌', new AbortController().signal)).toBe(output);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const { messages } = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(messages).toHaveLength(2);
  const instruction = messages[0].content;
  for (const rule of [
    `never exceed ${wordBudget}`, `up to ${textLimit} rendered text characters`,
    'A1111 (tag:weight)', 'source#/target#/mutual# and BREAK',
    'Character N:, Base Prompt:, Prompt:, UC: and Negative Prompt:',
    'replace paragraph pipes with blank lines', 'convert legacy text"..."',
    'remove no text', 'alpha transparency', 'translate non-English lettering into English',
    'shorten overlong lettering', 'FIRST and ONLY response',
  ]) expect(instruction).toContain(rule);
});

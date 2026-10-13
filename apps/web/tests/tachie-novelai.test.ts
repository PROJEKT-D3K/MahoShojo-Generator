import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_NOVELAI_SETTINGS, generateNovelAIImage } from '@/lib/tachie/novelai';
import { generateTachieWithProgress } from '@/lib/tachie/manager';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const jsonResponse = (data: unknown) => new Response(JSON.stringify(data), {
  status: 201, headers: { 'Content-Type': 'application/json' },
});
afterEach(() => vi.unstubAllGlobals());

describe('NovelAI browser direct generation', () => {
  it('从共享管理器直连官方接口，映射参数和 PNG，保留 seed=0，不附加项目凭据', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ images: [{ image: png, seed: 0 }] }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const progress = vi.fn();
    const result = await generateTachieWithProgress({
      source: 'novelai', novelaiToken: ' Bearer test-token ', prompt: '  1girl  ',
      novelaiSettings: { ...DEFAULT_NOVELAI_SETTINGS, seed: '42', size: '1216x832', negativePrompt: 'blurry' },
      signal: controller.signal,
      accessKey: 'must-not-send', modelscopeToken: 'must-not-send',
    }, progress);
    expect(result).toMatchObject({ success: true, imageUrl: `data:image/png;base64,${png}`, seed: 0, prompt: '1girl' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://image.novelai.net/ai/generate-image');
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal });
    expect(init.headers).toEqual({ Authorization: 'Bearer test-token', 'Content-Type': 'application/json', Accept: 'application/json' });
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ action: 'generate', input: '1girl', model: 'nai-diffusion-4-5-curated', parameters: {
      width: 1216, height: 832, seed: 42, steps: 28, scale: 7, n_samples: 1, image_format: 'png',
      negative_prompt: 'blurry', v4_prompt: { caption: { base_caption: '1girl', char_captions: [] } },
      v4_negative_prompt: { caption: { base_caption: 'blurry', char_captions: [] } },
    } });
    expect(init.body).not.toContain('must-not-send');
    expect(progress).toHaveBeenLastCalledWith(100, '生成完成！');
  });

  it('V5 Curated 使用结构化提示词字段，留空种子生成 uint32', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ images: [{ image: png }] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await generateNovelAIImage('token', '1girl', { ...DEFAULT_NOVELAI_SETTINGS, model: 'nai-diffusion-5-curated' });
    const parameters = JSON.parse(fetchMock.mock.calls[0][1].body).parameters;
    expect(parameters.v4_prompt.caption.base_caption).toBe('1girl');
    expect(parameters.seed).toBe(result.seed);
    expect(result.seed).toBeGreaterThanOrEqual(0);
    expect(result.seed).toBeLessThanOrEqual(0xffffffff);
  });

  it.each(['nai-diffusion-4-5-full', 'nai-diffusion-5-full', 'nai-diffusion-3', 'custom-model'])('拒绝非 Curated 模型 %s', async (model) => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(generateNovelAIImage('token', '1girl', { ...DEFAULT_NOVELAI_SETTINGS, model })).rejects.toThrow('仅支持');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['https://proxy.example/novelai/', 'https://proxy.example/novelai/ai/generate-image'],
    ['http://localhost:8080', 'http://localhost:8080/ai/generate-image'],
    ['', 'https://image.novelai.net/ai/generate-image'],
  ])('Base URL 覆盖保留路径前缀：%s', async (baseUrl, expected) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ images: [{ image: png }] }));
    vi.stubGlobal('fetch', fetchMock);
    await generateNovelAIImage('user-token', '1girl', { ...DEFAULT_NOVELAI_SETTINGS, baseUrl });
    expect(fetchMock.mock.calls[0][0]).toBe(expected);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'omit', redirect: 'error', headers: { Authorization: 'Bearer user-token' } });
  });

  it.each(['javascript:alert(1)', 'ftp://host', 'https://user:password@host', 'https://host/?key=value', 'https://host/#fragment', '/relative'])('无效 Base URL 不发送凭据：%s', async (baseUrl) => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(generateNovelAIImage('token', '1girl', { ...DEFAULT_NOVELAI_SETTINGS, baseUrl })).rejects.toThrow('Base URL');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([{ steps: 0 }, { steps: NaN }, { scale: 11 }, { seed: '-1' }, { seed: '4294967296' }, { size: '9999x9999' }])('无效参数在请求前失败 %j', async (patch) => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(generateNovelAIImage('token', '1girl', { ...DEFAULT_NOVELAI_SETTINGS, ...patch })).rejects.toThrow('请检查');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 402, 403, 429, 500])('HTTP %i 不重试且不泄漏服务商响应', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('secret-token raw request', { status }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await generateTachieWithProgress({ source: 'novelai', novelaiToken: 'secret-token', prompt: '1girl' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('NovelAI');
    expect(result.error).not.toContain('secret-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([{ images: [] }, { images: [{ image: 'https://evil.example/image.png' }] }, { images: [{ image: 'PHN2Zz48L3N2Zz4=' }] }])('拒绝无效结果 %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(body)));
    await expect(generateNovelAIImage('token', '1girl', DEFAULT_NOVELAI_SETTINGS)).rejects.toThrow('NovelAI');
  });

  it('有界读取 chunked 响应，超限取消流', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(25 * 1024 * 1024)); }, cancel });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { headers: { 'Content-Type': 'application/json' } })));
    await expect(generateNovelAIImage('token', '1girl', DEFAULT_NOVELAI_SETTINGS)).rejects.toThrow('24 MiB');
    expect(cancel).toHaveBeenCalled();
  });

  it('网络失败与取消均不自动重试', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch secret-token'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateNovelAIImage('secret-token', '1girl', DEFAULT_NOVELAI_SETTINGS)).rejects.toThrow('网络或跨域');
    const controller = new AbortController(); controller.abort();
    await expect(generateNovelAIImage('secret-token', '1girl', DEFAULT_NOVELAI_SETTINGS, controller.signal)).rejects.toThrow('已取消等待');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

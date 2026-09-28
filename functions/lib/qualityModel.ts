import { qualityPrompts } from './qualityPrompts.generated';
import { QUALITY_STAGES, QUALITY_IMAGE_CONTENT_TYPE, validateQualityResult, type QualityRequest, type ModelReply } from '../../src/recognition/qualityProtocol';

export interface QualityEnvironment { GEMINI_API_KEY?: string; GEMINI_MODEL?: string; DASHSCOPE_API_KEY?: string; QWEN_MODEL?: string }
/** Scan for invalid bytes without a backtracking match proportional to the image size. */
export function validImageBase64(value: unknown): value is string {
  if (typeof value !== 'string' || !value.length || value.length >= 26_000_000 || value.length % 4 !== 0) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return !/[^A-Za-z0-9+/]/.test(value.slice(0, value.length - padding));
}
export function missingQualityConfig(env: QualityEnvironment) {
  return ['GEMINI_API_KEY', 'DASHSCOPE_API_KEY'].filter(k => {
    const value = env[k as keyof QualityEnvironment]; return !value || /your[-_]/i.test(value);
  });
}
export function validateQualityRequest(value: any): asserts value is QualityRequest {
  if (!value || !QUALITY_STAGES.includes(value.stage)) throw new Error('未知识别步骤');
  if (value.stage === 'mapping') {
    if (value.images?.length || !Array.isArray(value.source) || !value.source.length || value.source.length > 1500) throw new Error('整理步骤只接受完整原文列表');
  } else if (value.source !== undefined || !Array.isArray(value.images) || value.images.length !== (value.stage === 'preflight' ? 4 : 1)
    || !value.images.every(validImageBase64)) throw new Error('图像读取必须使用完整页面');
}

export function decodeQualityRequest(body: string, contentType: string): QualityRequest {
  let input: any;
  if (contentType.split(';')[0].trim() === QUALITY_IMAGE_CONTENT_TYPE) {
    const [stage, ...images] = body.split('\n'); input = { stage, images };
    if (stage === 'mapping') throw new Error('整理步骤必须使用完整原文列表');
  } else input = JSON.parse(body); // Compatibility for pages loaded before deployment.
  validateQualityRequest(input); return input;
}

/** Called only after decodeQualityRequest validates every base64 byte. Validated
 * image strings contain no JSON metacharacters and can be copied unchanged. */
function qwenBody(input: QualityRequest, model: string, prompt: string) {
  const config = JSON.stringify({ model, response_format: { type: 'json_object' }, reasoning_effort: 'low',
    vl_high_resolution_images: true, temperature: 0, max_tokens: 16000 });
  return config.slice(0, -1) + ',"messages":[{"role":"user","content":[{"type":"text","text":'
    + JSON.stringify(prompt) + '},{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,'
    + input.images![0] + '"}}]}]}';
}
function geminiBody(input: QualityRequest, prompt: string) {
  const parts = [JSON.stringify({ text: prompt })];
  if (input.stage === 'mapping') parts.push(JSON.stringify({ text: JSON.stringify(input.source) }));
  else input.images!.forEach((data, index) => {
    if (input.stage === 'preflight') parts.push(JSON.stringify({ text: `候选${'ABCD'[index]}` }));
    parts.push('{"inlineData":{"mimeType":"image/jpeg","data":"' + data + '"}}');
  });
  const generationConfig = { temperature: 0, thinkingConfig: { thinkingLevel: 'low' }, responseMimeType: 'application/json',
    maxOutputTokens: input.stage === 'mapping' ? 65536 : input.stage === 'preflight' ? 2048 : 24000 };
  return '{"contents":[{"role":"user","parts":[' + parts.join(',') + ']}],"generationConfig":' + JSON.stringify(generationConfig) + '}';
}

export async function runQualityModel(input: QualityRequest, env: QualityEnvironment, signal: AbortSignal, fetcher = fetch): Promise<ModelReply> {
  // The HTTP route validates the envelope exactly once before starting the stream.
  const missing = missingQualityConfig(env);
  if (missing.length) throw new Error(`识别服务缺少配置：${missing.join('、')}`);
  const policy = qualityPrompts[input.stage];
  const isQwen = ['primary', 'context', 'primaryRecovery'].includes(input.stage);
  const model = (isQwen ? env.QWEN_MODEL : env.GEMINI_MODEL) || (isQwen ? 'qwen3.8-flash' : 'gemini-3.8-flash');
  if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error('模型配置格式错误');
  let text = '', finishReason = '', usage: unknown;
  if (isQwen) {
    const response = await fetcher('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.DASHSCOPE_API_KEY}` },
      body: qwenBody(input, model, policy.prompt)
    });
    if (!response.ok) throw new Error(`Qwen 服务请求失败（HTTP ${response.status}）`);
    const value: any = await response.json();
    text = value.choices?.[0]?.message?.content || ''; finishReason = value.choices?.[0]?.finish_reason || ''; usage = value.usage;
    if (finishReason !== 'stop') throw new Error('Qwen 输出未完成，已保留之前的页面进度');
  } else {
    const response = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
      method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY! },
      body: geminiBody(input, policy.prompt)
    });
    if (!response.ok) throw new Error(`Gemini 服务请求失败（HTTP ${response.status}）`);
    if (!response.body) throw new Error('Gemini 返回空响应');
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
    const line = (s: string) => {
      if (!s.startsWith('data:')) return;
      const value = JSON.parse(s.slice(5));
      if (value.error) throw new Error('Gemini 输出中断');
      usage = value.usageMetadata || usage;
      for (const candidate of value.candidates || []) {
        finishReason = candidate.finishReason || finishReason;
        for (const part of candidate.content?.parts || []) if (!part.thought) text += part.text || '';
      }
      if (text.length > 12_000_000) throw new Error('模型结果超过安全大小限制');
    };
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let n: number; while ((n = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, n).trim()); buffer = buffer.slice(n + 1); }
      }
      buffer += decoder.decode(); if (buffer.trim()) line(buffer.trim());
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (finishReason !== 'STOP') throw new Error('Gemini 输出未完成，已保留之前的页面进度');
  }
  let result: any;
  try { result = JSON.parse(text); } catch { throw new Error('模型未返回完整 JSON，未将片段当作成功结果'); }
  if (input.stage === 'context' && result && Object.keys(result).length === 1 && Array.isArray(result.nearTableText)) result.tables = [];
  validateQualityResult(input.stage, result);
  return { result, finishReason, usage, model, promptSHA256: policy.sha256 };
}

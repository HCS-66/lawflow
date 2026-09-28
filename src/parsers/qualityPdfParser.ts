import { createPdfPageImageRenderer } from './pdfPageImageRenderer';
import type { GeminiProgressInfo } from './geminiPdfParser';
import { runQualityWorkflow } from '../recognition/qualityWorkflow';
import { QUALITY_REVISION, validateQualityResult, type ModelReply, type QualityRequest } from '../recognition/qualityProtocol';
import type { QualityCheckpointStore } from '../store/qualityCheckpointStore';
import { qualityToWeb } from '../recognition/qualityWebAdapter';

export async function requestQualityModel(input: QualityRequest, signal: AbortSignal): Promise<ModelReply> {
  const response = await fetch('/api/recognize-quality', { method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  if (!response.ok) {
    let message = `识别服务请求失败（HTTP ${response.status}）`;
    const body = await response.text();
    if (/1102|Worker exceeded resource limits|exceeded.*(?:CPU|memory)/i.test(body)) message = '图像处理超过当前服务器的运行资源限制（Cloudflare 1102），已保存的识别进度仍可继续';
    else { try { message = JSON.parse(body).error || message; } catch { /* Never display provider response bodies. */ } }
    throw new Error(message);
  }
  if (!response.body) throw new Error('识别服务没有返回数据');
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', completed: ModelReply | undefined;
  const line = (s: string) => {
    if (!s.startsWith('data:')) return;
    const value = JSON.parse(s.slice(5));
    if (value.type === 'error') throw new Error(value.message);
    if (value.type === 'complete') completed = value;
  };
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let n: number; while ((n = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, n).trim()); buffer = buffer.slice(n + 1); }
    }
    buffer += decoder.decode(); if (buffer.trim()) line(buffer.trim());
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  signal.throwIfAborted();
  if (!completed || !['STOP', 'stop'].includes(completed.finishReason)) throw new Error('识别响应中断，可继续之前的进度');
  validateQualityResult(input.stage, completed.result); return completed;
}

export async function parsePdfWithQualityPipeline(file: File, onProgress: (p: GeminiProgressInfo) => void, signal: AbortSignal,
  options: { store: QualityCheckpointStore; onResumeWarning?: (message: string) => void }) {
  const config = await fetch('/api/recognize-quality', { signal, cache: 'no-store' });
  const status = await config.json();
  if (!config.ok || !status.ready) throw new Error(`识别服务尚未配置完整：${(status.missing || []).join('、')}`);
  if (status.revision !== QUALITY_REVISION) throw new Error('识别流程已更新，请刷新网页后重试');
  const renderer = await createPdfPageImageRenderer(file);
  let cacheWarning = false;
  let resumed = false;
  const warn = () => { if (!cacheWarning) { cacheWarning = true; options.onResumeWarning?.('浏览器未能保存识别证据，请释放存储空间后重试。'); } };
  const base64 = async (blob: Blob): Promise<string> => {
    const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = '';
    for (let n = 0; n < bytes.length; n += 32768) binary += String.fromCharCode(...bytes.subarray(n, n + 32768));
    return btoa(binary);
  };
  const hash = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(v => v.toString(16).padStart(2, '0')).join('');
  let percent = 0;
  try {
    const delivery = await runQualityWorkflow({ totalPages: renderer.totalPages, signal,
      progress: (statusText, next, totalTransactions = 0) => {
        percent = Math.max(percent, Math.round(next)); onProgress({ statusText, percent, totalTransactions, isStreaming: next < 100 });
      },
      preflightImages: async page => {
        signal.throwIfAborted();
        const original = await renderer.renderPage(page, 0, 150 / 72);
        const bitmap = await createImageBitmap(original.file), canvas = document.createElement('canvas');
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(bitmap, 0, 0); bitmap.close();
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let dark160 = 0, dark210 = 0;
        for (let i = 0; i < data.length; i += 4) { const g = Math.round(data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114); if (g < 160) dark160++; if (g < 210) dark210++; }
        const pixels = data.length / 4; canvas.width = canvas.height = 1;
        const images = [await base64(original.file)];
        for (const rotation of [90, 180, 270]) images.push(await base64((await renderer.renderPage(page, rotation, 150 / 72)).file));
        return { images, metrics: { darkFraction160: dark160 / pixels, darkFraction210: dark210 / pixels, hasPdfText: await renderer.hasText(page) } };
      },
      image: async (page, rotation, dpi) => { signal.throwIfAborted(); return base64((await renderer.renderPage(page, rotation, dpi / 72)).file); },
      call: async (input, page) => {
        signal.throwIfAborted(); const key = `${input.stage}:${page}:${await hash(JSON.stringify(input))}`;
        const expectedModel = ['primary', 'context', 'primaryRecovery'].includes(input.stage) ? status.models?.qwen : status.models?.gemini;
        try { const saved = await options.store.read(key);
          if (saved && saved.promptSHA256 === status.prompts?.[input.stage] && saved.model === expectedModel) {
            validateQualityResult(input.stage, saved.result);
            if (!resumed) { resumed = true; options.onResumeWarning?.('已恢复这个原始文件的识别进度，已完成的步骤会直接复用。'); }
            return saved;
          }
        } catch { warn(); }
        let reply: ModelReply | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          try { reply = await requestQualityModel(input, signal); break; }
          catch (error) {
            signal.throwIfAborted(); if (attempt === 2 || /配置|401|403/.test(String(error))) throw error;
            await new Promise<void>((resolve, reject) => {
              const stop = () => { clearTimeout(timer); reject(signal.reason); };
              const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, 1000 * 2 ** attempt);
              signal.addEventListener('abort', stop, { once: true });
            });
          }
        }
        if (!reply) throw new Error('识别未完成');
        // Evidence is required, not an optional resume optimization.
        try { await options.store.write(key, reply); } catch { warn(); throw new Error('原文证据未能保存，请释放浏览器空间后继续'); }
        return reply;
      }
    });
    await options.store.saveDelivery(delivery);
    return qualityToWeb(delivery.result, delivery.registry, file.name, renderer.totalPages);
  } finally { await renderer.destroy(); }
}

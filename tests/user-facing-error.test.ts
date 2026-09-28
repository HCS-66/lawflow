import test from 'node:test';
import assert from 'node:assert/strict';
import { importErrorForUser } from '../src/utils/userFacingError';
import { recognitionModeForPdf } from '../src/parsers/geminiPdfParser';

test('upload errors hide service internals and explain impact', () => {
  const result = importErrorForUser(
    new Error('Gemini 响应异常（503）：upstream unavailable'),
    '银行流水.pdf'
  );
  assert.equal(result.title, '未能导入“银行流水.pdf”');
  assert.equal(result.retryable, true);
  assert.match(result.message, /暂时不可用/);
  assert.doesNotMatch(result.message, /503|upstream/);
  assert.doesNotMatch(result.details, /Gemini|Qwen|OpenAI|Anthropic|Claude/i);
  assert.match(result.impact, /原有数据未受影响/);
});

test('oversized upload errors provide a concrete recovery action', () => {
  const result = importErrorForUser(new Error('上传文件超过 75MB 限制'), '大文件.pdf');
  assert.equal(result.retryable, false);
  assert.match(result.message, /压缩|拆分/);
});

test('server resource exhaustion is retryable and does not mislabel a file as oversized', () => {
  for (const message of ['Cloudflare 1102', '图像处理超过了当前服务器的运行资源限制']) {
    const result = importErrorForUser(new Error(message), '流水.pdf');
    assert.equal(result.diagnosticCode, 'WORKER_RESOURCE_LIMIT');
    assert.equal(result.retryable, true);
    assert.match(result.message, /运行资源/);
    assert.doesNotMatch(result.message, /75MB|压缩|拆分/);
  }
});

test('gateway timeout identifies the final normalization stage instead of blaming the PDF', () => {
  const result = importErrorForUser(new Error('服务返回异常（524）'), '长流水.pdf');
  assert.match(result.message, /最终整理等待超时/);
  assert.equal(result.diagnosticCode, 'NORMALIZATION_GATEWAY_TIMEOUT');
  assert.doesNotMatch(result.message, /不清晰|方向/);
});

test('premature stream completion exposes a concrete diagnostic instead of blaming document clarity', () => {
  const error = Object.assign(new Error('识别数据流提前结束，未收到最终完成结果'), {
    diagnosticCode: 'STREAM_ENDED_BEFORE_COMPLETE',
    diagnosis: '已接收约 486 笔中间结果，文件 128 页，耗时约 100 秒，请求编号 request-1'
  });
  const result = importErrorForUser(error, '长卷宗.pdf');
  assert.equal(result.diagnosticCode, 'STREAM_ENDED_BEFORE_COMPLETE');
  assert.match(result.message, /最终结果生成前结束/);
  assert.match(result.diagnosis || '', /486.*128.*100/);
  assert.doesNotMatch(result.message, /清晰/);
});

test('every PDF uses the same segmented recognition pipeline', () => {
  assert.equal(recognitionModeForPdf(3), 'SEGMENTED');
  assert.equal(recognitionModeForPdf(20), 'SEGMENTED');
  assert.equal(recognitionModeForPdf(300), 'SEGMENTED');
});

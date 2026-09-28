export interface UserFacingError {
  title: string;
  message: string;
  impact: string;
  retryable: boolean;
  details: string;
  diagnosticCode?: string;
  diagnosis?: string;
}

export function importErrorForUser(error: unknown, fileName: string): UserFacingError {
  const rawDetails = error instanceof Error ? error.message : String(error || '未知错误');
  const diagnosticCode = typeof (error as any)?.diagnosticCode === 'string' ? (error as any).diagnosticCode : undefined;
  const diagnosis = typeof (error as any)?.diagnosis === 'string' ? (error as any).diagnosis : undefined;
  const details = rawDetails
    .replace(/Gemini(?:\s*[\w.-]+)?/gi, '识别服务')
    .replace(/Qwen(?:\s*[\w.-]+)?/gi, '识别服务')
    .replace(/OpenAI|Anthropic|Claude/gi, '识别服务');
  const base = {
    title: `未能导入“${fileName}”`,
    impact: '本次文件没有写入案件，案件中原有数据未受影响。',
    details,
    diagnosticCode,
    diagnosis
  };

  if (diagnosticCode === 'OUTPUT_LIMIT_REACHED') {
    return {
      ...base,
      message: '识别服务的单次输出已达到长度上限，因此只返回了前半部分，完整流水尚未生成。',
      retryable: true
    };
  }
  if (diagnosticCode === 'STREAM_ENDED_BEFORE_COMPLETE') {
    return {
      ...base,
      message: '长文件识别连接在最终结果生成前结束。已读取的数字只是中间进度，并未形成可导入的完整结果。',
      retryable: true
    };
  }
  if (diagnosticCode === 'STREAM_TRANSPORT_INTERRUPTED' || diagnosticCode === 'UPSTREAM_STREAM_INTERRUPTED') {
    return {
      ...base,
      message: '识别数据流在完成前中断。请查看下方诊断信息确认中断位置。',
      retryable: true
    };
  }
  if (diagnosticCode === 'INVALID_STRUCTURED_OUTPUT' || diagnosticCode === 'EMPTY_MODEL_RESPONSE' || diagnosticCode === 'MODEL_STOPPED_EARLY') {
    return {
      ...base,
      message: '识别服务已返回内容，但没有形成完整可用的结构化流水。',
      retryable: true
    };
  }

  if (/Cloudflare\s*1102|服务器的运行资源限制/i.test(details)) {
    return { ...base, message: '图像处理超过了当前服务器的运行资源限制，已保存的识别进度仍可继续。',
      impact: '本次文件尚未写入案件；请重试，若反复出现需调整识别服务的运行资源。',
      retryable: true, diagnosticCode: 'WORKER_RESOURCE_LIMIT' };
  }
  if (/75\s*MB|文件体积|413|超过.*限制/i.test(details)) {
    return {
      ...base,
      message: '文件超过 75MB。请压缩扫描件，或拆分成多个 PDF 后分别上传。',
      retryable: false
    };
  }
  if (/不支持.*格式|415|仅支持 PDF|文件格式/i.test(details)) {
    return {
      ...base,
      message: '文件格式不受支持。请上传 Excel、CSV 或 PDF；图片请先合并为 PDF。',
      retryable: false
    };
  }
  if (/401|403|身份验证|登录|access/i.test(details)) {
    return {
      ...base,
      message: '当前登录状态已失效或没有识别权限。请重新登录后再试。',
      retryable: false
    };
  }
  if (/429|频繁|繁忙|限流|rate.?limit/i.test(details)) {
    return {
      ...base,
      message: '识别服务当前任务较多。请稍等片刻后重新识别。',
      retryable: true
    };
  }
  if (/\b524\b/.test(details)) {
    return {
      ...base,
      message: '文件内容已提取，但整份流水的最终整理等待超时，尚未形成可导入结果。',
      retryable: true,
      diagnosticCode: diagnosticCode || 'NORMALIZATION_GATEWAY_TIMEOUT',
      diagnosis: diagnosis || '结构化整理耗时超过网关同步等待时间'
    };
  }
  if (/超时|timeout|网络|连接|Failed to fetch|传输中断|数据流/i.test(details)) {
    return {
      ...base,
      message: '识别过程中网络连接中断。请检查网络后重新识别。',
      retryable: true
    };
  }
  if (/未返回有效|未能.*捕获|无法识别|内容损坏|结构化结果/i.test(details)) {
    return {
      ...base,
      message: '未能从文件中读取出完整流水。请确认 PDF 可以正常打开、页面方向正确且表格清晰。',
      retryable: true
    };
  }
  if (/500|502|503|504|服务.*异常|服务.*失败/i.test(details)) {
    return {
      ...base,
      message: '识别服务暂时不可用。请稍后重新识别。',
      retryable: true
    };
  }
  return {
    ...base,
    message: '识别未能完成。请重新识别；如果仍然失败，请检查文件是否可以正常打开。',
    retryable: true
  };
}

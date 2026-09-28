import type { PDFDocumentProxy } from 'pdfjs-dist';

let pdfjsPromise: Promise<any> | null = null;
async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import('pdfjs-dist');
      const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.js?url')).default;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

const MAX_IMAGE_PIXELS = 12_000_000;
const MAX_IMAGE_EDGE = 5_000;
const MAX_IMAGE_BYTES = 18 * 1024 * 1024;

export interface PdfPageImage {
  id: string;
  file: File;
  pageStart: number;
  pageEnd: number;
  totalPages: number;
  rotation: number;
  scale: number;
}

export interface PdfPageImageRenderer {
  totalPages: number;
  renderPage(pageNumber: number, rotation?: number, scale?: number): Promise<PdfPageImage>;
  hasText(pageNumber: number): Promise<boolean>;
  destroy(): Promise<void>;
}

export async function getPdfPageCount(file: File): Promise<number> {
  const pdfjs = await getPdfjs();
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdfjs/standard_fonts/' });
  try {
    const document = await loadingTask.promise;
    if (!document.numPages) throw new Error('PDF 中没有可读取的页面');
    return document.numPages;
  } finally {
    await loadingTask.destroy();
  }
}

export async function createPdfPageImageRenderer(file: File): Promise<PdfPageImageRenderer> {
  const pdfjs = await getPdfjs();
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdfjs/standard_fonts/' });
  const document = await loadingTask.promise;
  if (!document.numPages) throw new Error('PDF 中没有可读取的页面');

  return {
    totalPages: document.numPages,
    renderPage: (pageNumber, rotation = 0, scale = 2.35) => renderPage(document, file.name, pageNumber, rotation, scale),
    hasText: async pageNumber => {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      return content.items.some((item: any) => typeof item.str === 'string' && item.str.trim());
    },
    destroy: async () => {
      await loadingTask.destroy();
    }
  };
}

async function renderPage(
  document: PDFDocumentProxy, sourceFileName: string, pageNumber: number, rotation: number, scale: number
): Promise<PdfPageImage> {
  if (pageNumber < 1 || pageNumber > document.numPages) throw new Error(`PDF 第 ${pageNumber} 页不存在`);
  const page = await document.getPage(pageNumber);
  const normalizedRotation = ((rotation % 360) + 360) % 360;
  const baseViewport = page.getViewport({ scale: 1, rotation: (page.rotate + normalizedRotation) % 360 });
  const requestedWidth = baseViewport.width * scale;
  const requestedHeight = baseViewport.height * scale;
  const edgeFactor = Math.min(1, MAX_IMAGE_EDGE / Math.max(requestedWidth, requestedHeight));
  const pixelFactor = Math.min(1, Math.sqrt(MAX_IMAGE_PIXELS / Math.max(1, requestedWidth * requestedHeight)));
  const safeScale = scale * Math.min(edgeFactor, pixelFactor);
  const viewport = page.getViewport({ scale: safeScale, rotation: (page.rotate + normalizedRotation) % 360 });
  const canvas = documentCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error(`第 ${pageNumber} 页无法创建图像画布`);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  let blob: Blob;
  try {
    await page.render({ canvasContext: context, viewport, background: '#ffffff' }).promise;
    blob = await canvasBlob(canvas, 'image/jpeg', 0.92);
    if (blob.size > MAX_IMAGE_BYTES) blob = await canvasBlob(canvas, 'image/jpeg', 0.78);
    if (blob.size > MAX_IMAGE_BYTES) throw new Error(`第 ${pageNumber} 页图像体积过大，请降低原件分辨率后重试`);
  } finally {
    page.cleanup();
    canvas.width = 1;
    canvas.height = 1;
  }
  const baseName = sourceFileName.replace(/\.pdf$/i, '');
  return {
    id: `P${pageNumber}-R${normalizedRotation}-S${scale}`,
    file: new File([blob], `${baseName}_page_${pageNumber}.jpg`, { type: 'image/jpeg' }),
    pageStart: pageNumber,
    pageEnd: pageNumber,
    totalPages: document.numPages,
    rotation: normalizedRotation,
    scale: safeScale
  };
}

function documentCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('页面图片生成失败')), type, quality));
}

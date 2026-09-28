import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FileWarning, LoaderCircle, RotateCw, ZoomIn, ZoomOut } from 'lucide-react';
import { SourceRegion } from '../types/transaction';
import { rotateSourceRegion } from '../utils/sourceLocator';

let pdfjsLibPromise: Promise<any> | null = null;
async function getPdfjs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = (async () => {
      const pdfjs = await import('pdfjs-dist');
      const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.js?url')).default;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    })();
  }
  return pdfjsLibPromise;
}

interface PdfEvidencePageProps {
  file: File | null;
  pageNumber?: number;
  sourceRegion?: SourceRegion;
  rowLabel?: string;
}

export const PdfEvidencePage: React.FC<PdfEvidencePageProps> = ({ file, pageNumber = 1, sourceRegion, rowLabel }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1.15);
  const [rotation, setRotation] = useState(0);
  const [status, setStatus] = useState<'LOADING' | 'READY' | 'MISSING' | 'ERROR'>(file ? 'LOADING' : 'MISSING');
  const [pageCount, setPageCount] = useState(0);
  const [pdfDocument, setPdfDocument] = useState<any>(null);
  const displayedRegion = useMemo(
    () => sourceRegion ? rotateSourceRegion(sourceRegion, rotation) : undefined,
    [sourceRegion, rotation]
  );

  useEffect(() => {
    let cancelled = false;
    let loadingTask: any = undefined;
    if (!file) {
      setStatus('MISSING');
      setPdfDocument(null);
      setPageCount(0);
      return;
    }
    setStatus('LOADING');
    setPdfDocument(null);
    setPageCount(0);
    (async () => {
      try {
        const pdfjs = await getPdfjs();
        loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()),
          cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdfjs/standard_fonts/' });
        const document = await loadingTask.promise;
        if (cancelled) return;
        setPageCount(document.numPages);
        setPdfDocument(document);
      } catch (error: any) {
        if (!cancelled && error?.name !== 'RenderingCancelledException') setStatus('ERROR');
      }
    })();
    return () => {
      cancelled = true;
      loadingTask?.destroy();
    };
  }, [file]);

  useEffect(() => {
    if (!pdfDocument) return;
    let cancelled = false;
    let renderTask: any = undefined;
    let page: any = undefined;
    setStatus('LOADING');
    (async () => {
      try {
        const safePage = Math.min(Math.max(pageNumber, 1), pdfDocument.numPages);
        page = await pdfDocument.getPage(safePage);
        if (cancelled || !canvasRef.current) return;
        const viewport = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 });
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const canvas = canvasRef.current;
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('无法创建页面画布');
        renderTask = page.render({ canvasContext: context, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
        await renderTask.promise;
        if (!cancelled) setStatus('READY');
      } catch (error: any) {
        if (!cancelled && error?.name !== 'RenderingCancelledException') setStatus('ERROR');
      }
    })();
    return () => {
      cancelled = true;
      renderTask?.cancel();
      page?.cleanup?.();
    };
  }, [pdfDocument, pageNumber, scale, rotation]);

  useEffect(() => {
    if (status !== 'READY' || !displayedRegion || !scrollRef.current || !pageRef.current || !highlightRef.current) return;
    const frame = requestAnimationFrame(() => {
      const container = scrollRef.current;
      const page = pageRef.current;
      const highlight = highlightRef.current;
      if (!container || !page || !highlight) return;
      const target = page.offsetTop + highlight.offsetTop + highlight.offsetHeight / 2 - container.clientHeight / 2;
      container.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [displayedRegion, pageNumber, scale, rotation, status]);

  if (!file) {
    return (
      <div className="h-[620px] flex flex-col items-center justify-center text-center p-8 bg-slate-50 text-slate-500">
        <FileWarning className="w-9 h-9 text-amber-500 mb-3" />
        <div className="text-sm font-semibold text-slate-700">当前案件未保存这份原始PDF</div>
        <div className="text-xs mt-2 max-w-sm">请返回上传步骤，重新选择同名原始文件。重新解析时会恢复已经完成的页段。</div>
      </div>
    );
  }

  return (
    <div className="bg-slate-100 h-[620px] flex flex-col">
      <div className="h-11 px-3 bg-white border-b border-slate-200 flex items-center justify-between text-xs">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-medium text-slate-700">原始PDF第 {pageNumber} 页{pageCount ? ` / 共 ${pageCount} 页` : ''}</span>
          {displayedRegion && (
            <span className={`truncate rounded-full px-2 py-0.5 text-[10px] font-semibold ${displayedRegion.origin === 'ESTIMATED' ? 'bg-amber-100 text-amber-800' : 'bg-rose-100 text-rose-700'}`}>
              {displayedRegion.origin === 'ESTIMATED' ? '参考位置' : '识别定位'}{rowLabel ? ` · ${rowLabel}` : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setScale(value => Math.max(0.65, value - 0.2))} className="p-1.5 rounded hover:bg-slate-100" title="缩小"><ZoomOut className="w-4 h-4" /></button>
          <span className="w-12 text-center text-slate-500">{Math.round(scale * 100)}%</span>
          <button onClick={() => setScale(value => Math.min(2.5, value + 0.2))} className="p-1.5 rounded hover:bg-slate-100" title="放大"><ZoomIn className="w-4 h-4" /></button>
          <button onClick={() => setRotation(value => (value + 90) % 360)} className="p-1.5 rounded hover:bg-slate-100" title="顺时针旋转"><RotateCw className="w-4 h-4" /></button>
        </div>
      </div>
      <div ref={scrollRef} className="relative flex-1 overflow-auto p-4">
        {status === 'LOADING' && <div className="absolute inset-0 flex items-center justify-center pointer-events-none"><LoaderCircle className="w-7 h-7 animate-spin text-blue-600" /></div>}
        {status === 'ERROR' && <div className="text-center text-sm text-rose-600 py-12">原始页面显示失败，请确认PDF文件可以正常打开。</div>}
        <div ref={pageRef} className={`relative mx-auto w-fit bg-white shadow-md ${status === 'READY' ? 'block' : 'invisible'}`}>
          <canvas ref={canvasRef} className="block" />
          {displayedRegion && (
            <div
              ref={highlightRef}
              role="note"
              aria-label={displayedRegion.origin === 'ESTIMATED' ? '待核对行参考位置' : '待核对原始行'}
              className={`pointer-events-none absolute z-10 ${displayedRegion.origin === 'ESTIMATED'
                ? 'border-2 border-dashed border-amber-500 bg-amber-300/20'
                : 'border-2 border-rose-600 bg-rose-400/20 ring-2 ring-white/90'}`}
              style={{
                left: `${displayedRegion.x * 100}%`,
                top: `${displayedRegion.y * 100}%`,
                width: `${displayedRegion.width * 100}%`,
                height: `${displayedRegion.height * 100}%`
              }}
            >
              <span className={`absolute -top-6 left-0 whitespace-nowrap rounded px-2 py-1 text-[10px] font-bold text-white shadow ${displayedRegion.origin === 'ESTIMATED' ? 'bg-amber-600' : 'bg-rose-600'}`}>
                {displayedRegion.origin === 'ESTIMATED' ? '大致位置，请按内容核对' : '系统定位，请核对这一行'}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

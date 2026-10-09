import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, CircleAlert, LoaderCircle, Minus, Plus } from 'lucide-react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type PDFDocumentLoadingTask, type RenderTask } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { AppError, WorkspaceFile } from '../shared/types';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_CANVAS_EDGE = 2048;

async function boundedPDF(url: string, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    let message = `The file could not be loaded (${response.status}).`;
    try { const error = await response.json() as AppError; if (error.message) message = error.message; } catch { /* Non-JSON proxy errors still have a useful HTTP status. */ }
    throw new Error(message);
  }
  if (Number(response.headers.get('content-length')) > MAX_PDF_BYTES) {
    await response.body?.cancel();
    throw new Error('This PDF is larger than the 25 MiB preview limit. Download it to view the full document.');
  }
  if (!response.body) throw new Error('The PDF file was empty.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_PDF_BYTES) {
        await reader.cancel();
        throw new Error('This PDF is larger than the 25 MiB preview limit. Download it to view the full document.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return data;
}

function messageFor(error: unknown): string {
  if (error instanceof Error && error.name === 'PasswordException') return 'This PDF is password protected. Download it to open with your PDF reader.';
  return error instanceof Error ? error.message : 'This PDF could not be previewed. Download it to open with your PDF reader.';
}

export default function PdfPreview({ file, contentURL = `/api/files/content?path=${encodeURIComponent(file.path)}`, downloadURL = `/api/files/download?path=${encodeURIComponent(file.path)}` }: { file: WorkspaceFile; contentURL?: string; downloadURL?: string }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pageText, setPageText] = useState('');
  const [width, setWidth] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    observer.observe(node);
    setWidth(node.clientWidth);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | undefined;
    const controller = new AbortController();
    setDocument(null); setLoading(true); setError(null); setPageNumber(1); setZoom(1); setPageText('');
    if (file.size > MAX_PDF_BYTES) {
      setError('This PDF is larger than the 25 MiB preview limit. Download it to view the full document.');
      setLoading(false);
      return () => { cancelled = true; controller.abort(); };
    }
    void (async () => {
      const data = await boundedPDF(contentURL, controller.signal);
      if (cancelled) return;
      const settings = { data, isEvalSupported: false, enableXfa: false, useSystemFonts: true, maxImageSize: 16 * 1024 * 1024, canvasMaxAreaInBytes: 16 * 1024 * 1024 };
      loadingTask = getDocument(settings);
      const pdf = await loadingTask.promise;
      if (cancelled) return;
      setDocument(pdf); setLoading(false);
    })().catch(error => {
      if (!cancelled) { setError(messageFor(error)); setLoading(false); }
    });
    return () => {
      cancelled = true;
      controller.abort();
      renderTaskRef.current?.cancel();
      if (loadingTask) void loadingTask.destroy().catch(() => {});
    };
  }, [file.path, file.size, file.modifiedAt, contentURL]);

  useEffect(() => {
    if (!document || !width) return;
    let cancelled = false;
    let task: RenderTask | undefined;
    const previousTask = renderTaskRef.current;
    previousTask?.cancel();
    setRendering(true); setError(null); setPageText('');
    void (async () => {
      // Wait for cancellation before reusing the same canvas for a new page.
      if (previousTask) await previousTask.promise.catch(() => {});
      if (cancelled) return;
      const page = await document.getPage(pageNumber);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      const cssScale = Math.min(1.25, Math.max(100, width - 48) / base.width) * zoom;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const scale = Math.min(cssScale * pixelRatio, MAX_CANVAS_EDGE / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      if (!canvas) return;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas preview is unavailable in this browser. Download the PDF to view it.');
      canvas.width = Math.max(1, Math.min(MAX_CANVAS_EDGE, Math.ceil(viewport.width)));
      canvas.height = Math.max(1, Math.min(MAX_CANVAS_EDGE, Math.ceil(viewport.height)));
      canvas.style.width = `${Math.ceil(base.width * cssScale)}px`;
      canvas.style.height = `${Math.ceil(base.height * cssScale)}px`;
      task = page.render({ canvas, canvasContext: context, viewport, background: '#ffffff' });
      renderTaskRef.current = task;
      await task.promise;
      if (cancelled) return;
      setRendering(false);
      const text = await page.getTextContent();
      if (!cancelled) setPageText(text.items.flatMap(item => 'str' in item ? [item.str] : []).join(' ').slice(0, 20000));
    })().catch(error => {
      if (!cancelled) { setError(messageFor(error)); setRendering(false); }
    });
    return () => { cancelled = true; task?.cancel(); };
  }, [document, pageNumber, zoom, width]);

  return <div className="pdf-preview">
    <div className="pdf-toolbar" aria-label="PDF preview controls">
      <button className="icon-button" type="button" aria-label="Previous PDF page" onClick={() => setPageNumber(page => Math.max(1, page - 1))} disabled={!document || pageNumber <= 1}><ChevronLeft size={17} /></button>
      <span className="pdf-page-count">Page {pageNumber} of {document?.numPages ?? '—'}</span>
      <button className="icon-button" type="button" aria-label="Next PDF page" onClick={() => setPageNumber(page => Math.min(document?.numPages ?? 1, page + 1))} disabled={!document || pageNumber >= document.numPages}><ChevronRight size={17} /></button>
      <span className="pdf-toolbar-divider" />
      <button className="icon-button" type="button" aria-label="Zoom out PDF" onClick={() => setZoom(value => Math.max(.5, value - .25))} disabled={!document || zoom <= .5}><Minus size={15} /></button>
      <span className="pdf-zoom">{Math.round(zoom * 100)}%</span>
      <button className="icon-button" type="button" aria-label="Zoom in PDF" onClick={() => setZoom(value => Math.min(2.5, value + .25))} disabled={!document || zoom >= 2.5}><Plus size={15} /></button>
      {rendering && <LoaderCircle size={13} className="spin pdf-render-status" aria-label="Rendering PDF page" />}
    </div>
    <div className="pdf-page-scroll" ref={scrollRef} aria-busy={loading || rendering}>
      {loading && <div className="preview-loading"><LoaderCircle size={24} className="spin" /><span>Loading PDF</span></div>}
      {error && <div className="pdf-preview-error" role="alert"><CircleAlert size={26} strokeWidth={1.6} /><strong>Preview unavailable</strong><p>{error}</p><a className="button secondary" href={downloadURL} download={file.name}>Download PDF</a></div>}
      <div className={`pdf-page ${rendering ? 'pdf-page-rendering' : ''}`} hidden={!document || !!error}><canvas ref={canvasRef} aria-label={`PDF page ${pageNumber} of ${document?.numPages ?? 0}`} role="img" /><p className="sr-only">{pageText}</p></div>
    </div>
  </div>;
}

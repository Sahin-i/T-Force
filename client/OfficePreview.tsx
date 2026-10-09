import { Component, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { CircleAlert, FileSpreadsheet, LoaderCircle } from 'lucide-react';
import type { Cell, CellValue, Worksheet, Workbook } from 'exceljs';
import type { WorkspaceFile } from '../shared/types';
import { boundedOfficeFile, columnName, inspectOfficeArchive, validateWorkbook, MAX_OFFICE_BYTES, MAX_PREVIEW_COLUMNS, MAX_PREVIEW_ROWS } from './office-preview-utils';
import './office-preview.css';

const DOCX_FRAME = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data: blob:; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;min-height:100%;background:#eef0ec;color:#172018}body{font-family:Arial,sans-serif}.office-docx-wrapper{padding:24px!important;background:#eef0ec!important}.office-docx-wrapper>section.office-docx{margin:0 auto 24px!important;box-shadow:0 2px 12px #17311912!important;max-width:100%;box-sizing:border-box}img,svg{max-width:100%}a{color:inherit;text-decoration:underline}@media(max-width:800px){.office-docx-wrapper{padding:16px!important}.office-docx-wrapper>section.office-docx{width:100%!important;padding:28px!important}}@media(max-width:480px){.office-docx-wrapper{padding:8px!important}.office-docx-wrapper>section.office-docx{padding:20px!important}}</style></head><body><main id="document" aria-label="Document pages"></main></body></html>`;

function PreviewError({ file, message, downloadURL = `/api/files/download?path=${encodeURIComponent(file.path)}` }: { file: WorkspaceFile; message: string; downloadURL?: string }) {
  return <div className="office-preview-error" role="alert"><CircleAlert size={27} strokeWidth={1.6} /><strong>Preview unavailable</strong><p>{message}</p><a className="button secondary" href={downloadURL} download={file.name}>Download file</a></div>;
}

function cssColor(value?: { argb?: string }): string | undefined {
  const color = value?.argb;
  return color && /^[a-f\d]{6}(?:[a-f\d]{2})?$/i.test(color) ? `#${color.slice(-6)}` : undefined;
}

function cellStyle(cell: Cell): CSSProperties {
  const fill = cell.fill?.type === 'pattern' ? cssColor(cell.fill.fgColor) : undefined;
  const align = cell.alignment?.horizontal;
  const value = cell.value;
  const numeric = typeof value === 'number' || value instanceof Date || (value && typeof value === 'object' && 'result' in value && typeof value.result === 'number');
  const style: CSSProperties = {
    fontWeight: cell.font?.bold ? 650 : undefined,
    fontStyle: cell.font?.italic ? 'italic' : undefined,
    color: cssColor(cell.font?.color),
    backgroundColor: fill,
    textAlign: align === 'left' || align === 'center' || align === 'right' ? align : numeric ? 'right' : undefined,
    whiteSpace: cell.alignment?.wrapText ? 'pre-wrap' : 'nowrap',
  };
  if (cell.font?.underline) style.textDecoration = 'underline';
  return style;
}

function scalarText(value: CellValue | undefined, format = 'General'): string {
  if (value === undefined || value === null) return '';
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString().replace('T00:00:00.000Z', '').replace('T', ' ').replace('.000Z', ' UTC') : 'Invalid date';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    const section = format.split(';')[value < 0 ? 1 : 0] ?? format.split(';')[0];
    const decimalDigits = Math.min(10, section.match(/\.([0#]+)/)?.[1].length ?? 0);
    const percent = /%/.test(section);
    const currency = section.match(/(?:\[\$([^\]-]+)(?:-[^\]]+)?\]|["']([^"']*[£€$¥][^"']*)["']|([£€$¥]))/);
    if (percent || currency || /[0#],?[0#]*\.0|#,##0/.test(section)) {
      const number = (percent ? value * 100 : value).toLocaleString('en-US', { minimumFractionDigits: decimalDigits, maximumFractionDigits: decimalDigits, useGrouping: section.includes(',') });
      const symbol = currency ? currency[1] ?? currency[2] ?? currency[3] ?? '' : '';
      return `${symbol}${number}${percent ? '%' : ''}`;
    }
    return String(value);
  }
  if (typeof value === 'string') return value;
  if ('richText' in value) return value.richText.map(item => item.text).join('');
  if ('hyperlink' in value) return value.text;
  if ('error' in value) return value.error;
  return '';
}

function cellContent(cell: Cell): { text: string; formula?: string } {
  const value = cell.value;
  if (value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) {
    const formula = cell.formula || ('formula' in value ? value.formula : value.sharedFormula);
    return { text: value.result === undefined ? 'No cached result' : scalarText(value.result, cell.numFmt), formula: `=${formula}` };
  }
  return { text: scalarText(value, cell.numFmt) };
}

function WorkbookPreview({ workbook }: { workbook: Workbook }) {
  const sheets = workbook.worksheets;
  const [sheetId, setSheetId] = useState(sheets[0]?.id ?? 0);
  const [selectedCell, setSelectedCell] = useState<{ address: string; text: string; formula?: string; format?: string } | null>(null);
  const sheet = sheets.find(item => item.id === sheetId) ?? sheets[0];
  const preview = useMemo(() => sheet ? worksheetPreview(sheet) : null, [sheet]);
  if (!sheet || !preview) return <p className="office-empty">This workbook has no worksheets.</p>;
  const partial = sheet.rowCount > MAX_PREVIEW_ROWS || sheet.columnCount > MAX_PREVIEW_COLUMNS;
  return <div className="workbook-preview">
    <div className="workbook-toolbar"><FileSpreadsheet size={16} /><strong>{sheet.name}</strong><span>{sheet.rowCount.toLocaleString()} rows · {sheet.columnCount.toLocaleString()} columns</span></div>
    <div className="workbook-formula" aria-live="polite"><span className="workbook-address">{selectedCell?.address ?? 'Cell'}</span><span>{selectedCell ? (selectedCell.formula ?? selectedCell.text) || 'Empty cell' : 'Select a cell to inspect its value or formula.'}</span>{selectedCell?.format && selectedCell.format !== 'General' && <small>Format: {selectedCell.format}</small>}</div>
    <div className="workbook-grid-scroll">
      {sheet.actualRowCount === 0 ? <p className="office-empty">This worksheet is empty.</p> : <table className="workbook-grid" aria-label={`${sheet.name} worksheet`}><colgroup><col className="workbook-row-number" />{Array.from({ length: preview.columns }, (_, index) => <col key={index} style={{ width: `${Math.min(320, Math.max(90, (sheet.getColumn(index + 1).width ?? 12) * 8))}px` }} />)}</colgroup><thead><tr><th scope="col" aria-label="Row number" />{Array.from({ length: preview.columns }, (_, index) => <th scope="col" key={index}>{columnName(index + 1)}</th>)}</tr></thead><tbody>{preview.rows.map((row, index) => <tr key={index}><th scope="row">{index + 1}</th>{row.map(item => {
        const { cell, rowSpan, colSpan } = item;
        const { text, formula } = cellContent(cell);
        return <td key={cell.address} rowSpan={rowSpan} colSpan={colSpan} className={selectedCell?.address === cell.address ? 'workbook-selected-cell' : ''} style={cellStyle(cell)}><button type="button" className="workbook-cell" title={formula ? `${cell.address}: ${formula}\n${text}` : `${cell.address}: ${text}`} onClick={() => setSelectedCell({ address: cell.address, text, formula, format: cell.numFmt })}><span>{text.length > 4000 ? `${text.slice(0, 4000)}…` : text}</span>{formula && <span className="workbook-formula-indicator" aria-label="Formula cell" />}</button></td>;
      })}</tr>)}</tbody></table>}
    </div>
    <div className="workbook-sheet-tabs" role="tablist" aria-label="Workbook worksheets">{sheets.map(item => <button key={item.id} type="button" role="tab" aria-selected={item.id === sheet.id} className={item.id === sheet.id ? 'selected' : ''} onClick={() => { setSheetId(item.id); setSelectedCell(null); }}>{item.name}{item.state !== 'visible' && <small> hidden</small>}</button>)}</div>
    <p className="office-preview-note">{partial && <>Showing the first {preview.rows.length} rows and {preview.columns} columns. Download the workbook to see all cells. </>}Formulas display saved results and are not recalculated in the preview.</p>
  </div>;
}

function worksheetPreview(sheet: Worksheet): { rows: { cell: Cell; rowSpan?: number; colSpan?: number }[][]; columns: number } {
  const rowCount = Math.min(MAX_PREVIEW_ROWS, sheet.rowCount);
  const columns = Math.min(MAX_PREVIEW_COLUMNS, Math.max(1, sheet.columnCount));
  const merges = new Map<string, { rowSpan: number; colSpan: number }>();
  // Only visible cells participate; a merge crossing the preview boundary is clipped.
  for (let row = 1; row <= rowCount; row++) for (let column = 1; column <= columns; column++) {
    const cell = sheet.getCell(row, column);
    if (!cell.isMerged) continue;
    const master = cell.master;
    const span = merges.get(master.address) ?? { rowSpan: 1, colSpan: 1 };
    span.rowSpan = Math.max(span.rowSpan, row - Number(master.row) + 1);
    span.colSpan = Math.max(span.colSpan, column - Number(master.col) + 1);
    merges.set(master.address, span);
  }
  return { columns, rows: Array.from({ length: rowCount }, (_, index) => {
    const row: { cell: Cell; rowSpan?: number; colSpan?: number }[] = [];
    for (let column = 1; column <= columns; column++) {
      const cell = sheet.getCell(index + 1, column);
      if (cell.isMerged && cell.address !== cell.master.address) continue;
      row.push({ cell, ...merges.get(cell.address) });
    }
    return row;
  }) };
}

function OfficePreviewContent({ file, contentURL, downloadURL }: { file: WorkspaceFile; contentURL: string; downloadURL: string }) {
  const word = /\.docx$/i.test(file.name);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [workbook, setWorkbook] = useState<Workbook | null>(null);
  const [frameReady, setFrameReady] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true); setError(null); setWorkbook(null);
    if (word && !frameReady) return () => { cancelled = true; controller.abort(); };
    void (async () => {
      if (file.size > MAX_OFFICE_BYTES) throw new Error('This file is larger than the 25 MiB preview limit. Download it to view the full document.');
      const data = await boundedOfficeFile(contentURL, controller.signal);
      if (cancelled) return;
      const entries = inspectOfficeArchive(data, word ? 'docx' : 'xlsx');
      if (word) {
        const { renderAsync } = await import('docx-preview');
        if (cancelled) return;
        const frameDocument = frameRef.current?.contentDocument;
        const container = frameDocument?.getElementById('document');
        if (!container || !frameDocument) throw new Error('The document viewer could not be opened. Download the file to view it.');
        // Render into a detached tree so any document links can be removed before
        // they become interactive. The frame blocks scripts and external content.
        const body = frameDocument.createElement('div');
        const styles = frameDocument.createElement('div');
        await renderAsync(data, body, styles, {
          className: 'office-docx', inWrapper: true, breakPages: true,
          ignoreLastRenderedPageBreak: false, ignoreFonts: true,
          renderAltChunks: false, renderComments: false, useBase64URL: true,
        });
        if (cancelled) return;
        for (const node of body.querySelectorAll('script, iframe, object, embed, form, input, button, meta, link')) node.remove();
        for (const node of body.querySelectorAll('*')) {
          for (const attribute of Array.from(node.attributes)) {
            if (/^on/i.test(attribute.name) || /^(?:href|xlink:href|srcdoc|action|formaction)$/i.test(attribute.name)) node.removeAttribute(attribute.name);
            if (attribute.name === 'src' && !/^data:image\/(?:png|jpeg|gif|webp|bmp|svg\+xml);/i.test(attribute.value)) node.removeAttribute(attribute.name);
          }
        }
        container.replaceChildren(styles, body);
        if (!body.querySelector('section')) throw new Error('This document does not contain any previewable pages.');
      } else {
        validateWorkbook(entries);
        const ExcelJS = await import('exceljs');
        if (cancelled) return;
        const book = new ExcelJS.default.Workbook();
        await book.xlsx.load(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer, { ignoreNodes: ['drawing', 'extLst'] });
        if (cancelled) return;
        setWorkbook(book);
      }
      setLoading(false);
    })().catch(error => {
      if (!cancelled) { setError(error instanceof Error ? error.message : 'This file could not be previewed. Download it to open in your office app.'); setLoading(false); }
    });
    return () => { cancelled = true; controller.abort(); frameRef.current?.contentDocument?.getElementById('document')?.replaceChildren(); };
  }, [file.path, file.size, file.modifiedAt, word, frameReady, contentURL]);

  return <div className={`office-preview ${word ? 'word-preview' : ''}`} aria-busy={loading}>
    {loading && <div className="preview-loading"><LoaderCircle size={24} className="spin" /><span>Loading {word ? 'document' : 'workbook'}</span></div>}
    {error && <PreviewError file={file} message={error} downloadURL={downloadURL} />}
    {word && <iframe ref={frameRef} className="office-docx-frame" title={`Document preview: ${file.name}`} sandbox="allow-same-origin" srcDoc={DOCX_FRAME} onLoad={() => setFrameReady(true)} hidden={loading || !!error} />}
    {!word && workbook && <WorkbookPreview key={`${file.path}:${file.modifiedAt}`} workbook={workbook} />}
    {word && !loading && !error && <p className="office-preview-note">Document preview. Complex formatting may differ from the original.</p>}
  </div>;
}

class OfficePreviewBoundary extends Component<{ file: WorkspaceFile; children: ReactNode; downloadURL: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <div className="office-preview"><PreviewError file={this.props.file} downloadURL={this.props.downloadURL} message="This file contains content that could not be previewed. Download it to open in your office app." /></div> : this.props.children;
  }
}

export default function OfficePreview({ file, contentURL = `/api/files/content?path=${encodeURIComponent(file.path)}`, downloadURL = `/api/files/download?path=${encodeURIComponent(file.path)}` }: { file: WorkspaceFile; contentURL?: string; downloadURL?: string }) {
  return <OfficePreviewBoundary key={`${file.path}:${file.modifiedAt}`} file={file} downloadURL={downloadURL}><OfficePreviewContent file={file} contentURL={contentURL} downloadURL={downloadURL} /></OfficePreviewBoundary>;
}

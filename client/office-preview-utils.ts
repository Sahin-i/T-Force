import { Unzip, UnzipInflate } from 'fflate';

export const MAX_OFFICE_BYTES = 25 * 1024 * 1024;
export const MAX_PREVIEW_ROWS = 200;
export const MAX_PREVIEW_COLUMNS = 50;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 512;
const ARCHIVE_LIMIT_MESSAGE = 'This file is too complex for a browser preview. Download it to open in your office app.';

// Validate both the ZIP directory and actual inflation. A compressed-size limit
// alone is insufficient for office files; highly compressed XML can be enormous.
export function inspectOfficeArchive(data: Uint8Array, type: 'docx' | 'xlsx'): Record<string, Uint8Array> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let end = -1;
  for (let offset = data.length - 22; offset >= Math.max(0, data.length - 65557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === data.length) { end = offset; break; }
  }
  if (end < 0) throw new Error('This file is not a readable office document. It may be damaged or password protected.');
  const count = view.getUint16(end + 10, true);
  const directoryBytes = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || count !== view.getUint16(end + 8, true)) throw new Error('Multi-part office archives cannot be previewed. Download the file to open it.');
  if (count > MAX_ARCHIVE_ENTRIES || offset === 0xffffffff || directoryBytes === 0xffffffff || offset + directoryBytes > end) throw new Error(ARCHIVE_LIMIT_MESSAGE);
  let declaredBytes = 0;
  const names = new Set<string>();
  const expectedSizes = new Map<string, number>();
  const decoder = new TextDecoder();
  const directoryEnd = offset + directoryBytes;
  for (let entry = 0; entry < count; entry++) {
    if (offset + 46 > directoryEnd || view.getUint32(offset, true) !== 0x02014b50) throw new Error('This office file has a damaged archive directory.');
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const expandedBytes = view.getUint32(offset + 24, true);
    const nameBytes = view.getUint16(offset + 28, true);
    const extraBytes = view.getUint16(offset + 30, true);
    const commentBytes = view.getUint16(offset + 32, true);
    const next = offset + 46 + nameBytes + extraBytes + commentBytes;
    if (next > directoryEnd) throw new Error('This office file has a damaged archive entry.');
    if (flags & 1) throw new Error('This document is password protected. Download it to open in your office app.');
    if (method !== 0 && method !== 8) throw new Error('This document uses an unsupported archive format. Download it to open in your office app.');
    declaredBytes += expandedBytes;
    if (expandedBytes > MAX_ENTRY_BYTES || declaredBytes > MAX_ARCHIVE_BYTES) throw new Error(ARCHIVE_LIMIT_MESSAGE);
    const name = decoder.decode(data.subarray(offset + 46, offset + 46 + nameBytes));
    if (names.has(name) || /(?:^|[\\/])\.\.(?:[\\/]|$)|^[\\/]|\0/.test(name)) throw new Error('This office file contains invalid archive entries.');
    names.add(name);
    expectedSizes.set(name, expandedBytes);
    offset = next;
  }
  if (offset !== directoryEnd) throw new Error('This office file has a damaged archive directory.');
  const required = type === 'docx' ? 'word/document.xml' : 'xl/workbook.xml';
  if (!names.has(required) || !names.has('[Content_Types].xml')) throw new Error(`This file does not contain a readable ${type === 'docx' ? 'Word document' : 'Excel workbook'}.`);
  const entries: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  let actualBytes = 0;
  let started = 0;
  let completed = 0;
  const seen = new Set<string>();
  const unzip = new Unzip(file => {
    if (!expectedSizes.has(file.name) || seen.has(file.name) || ++started > MAX_ARCHIVE_ENTRIES) throw new Error('This office file contains inconsistent archive entries.');
    seen.add(file.name);
    let entryBytes = 0;
    const chunks: Uint8Array[] = [];
    file.ondata = (error, chunk, final) => {
      if (error) throw new Error(error.message || 'This office file contains damaged compressed content.');
      entryBytes += chunk.length;
      actualBytes += chunk.length;
      if (entryBytes > MAX_ENTRY_BYTES || actualBytes > MAX_ARCHIVE_BYTES) throw new Error(ARCHIVE_LIMIT_MESSAGE);
      chunks.push(chunk);
      if (!final) return;
      if (entryBytes !== expectedSizes.get(file.name)) throw new Error('This office file contains inconsistent archive sizes.');
      const content = new Uint8Array(entryBytes);
      let position = 0;
      for (const part of chunks) { content.set(part, position); position += part.length; }
      entries[file.name] = content;
      completed++;
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  // Small input chunks keep an individual inflation allocation bounded too.
  for (let position = 0; position < data.length; position += 4096) unzip.push(data.subarray(position, position + 4096), position + 4096 >= data.length);
  if (completed !== count || started !== count) throw new Error('This office file has an incomplete archive.');
  for (const [name, content] of Object.entries(entries)) {
    if (/\.(?:xml|rels)$/i.test(name) && /<!DOCTYPE|<!ENTITY/i.test(decoder.decode(content))) throw new Error('This office document contains unsupported XML declarations. Download it to open in your office app.');
  }
  return entries;
}

export async function boundedOfficeFile(url: string, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    let message = `The file could not be loaded (${response.status}).`;
    try {
      const body = await response.json() as { error?: { message?: string } | string; message?: string };
      message = typeof body.error === 'object' ? body.error.message ?? message : typeof body.error === 'string' ? body.error : body.message ?? message;
    } catch { /* Preserve the HTTP status when a proxy supplies a non-JSON error. */ }
    throw new Error(message);
  }
  if (Number(response.headers.get('content-length')) > MAX_OFFICE_BYTES) {
    await response.body?.cancel();
    throw new Error('This file is larger than the 25 MiB preview limit. Download it to view the full document.');
  }
  if (!response.body) throw new Error('The file was empty.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_OFFICE_BYTES) {
        await reader.cancel();
        throw new Error('This file is larger than the 25 MiB preview limit. Download it to view the full document.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return data;
}

export function columnName(value: number): string {
  let result = '';
  while (value > 0) { value--; result = String.fromCharCode(65 + value % 26) + result; value = Math.floor(value / 26); }
  return result;
}

export function validateWorkbook(entries: Record<string, Uint8Array>): void {
  const decoder = new TextDecoder();
  let cells = 0;
  let sheets = 0;
  let mergedCells = 0;
  const sharedStrings = entries['xl/sharedStrings.xml'];
  if (sharedStrings && (decoder.decode(sharedStrings).match(/<(?:\w+:)?si\b/g) ?? []).length > 200000) throw new Error('This workbook contains too many text values for a browser preview. Download it to view the full workbook.');
  for (const [name, bytes] of Object.entries(entries)) {
    if (!/^xl\/worksheets\/[^/]+\.xml$/i.test(name)) continue;
    if (++sheets > 50) throw new Error('This workbook has too many worksheets for a browser preview. Download it to view the full workbook.');
    const xml = decoder.decode(bytes);
    cells += (xml.match(/<(?:\w+:)?c\b/g) ?? []).length;
    if (cells > 200000) throw new Error('This workbook contains too many cells for a browser preview. Download it to view the full workbook.');
    // Quoted XML attributes may contain '>' or numeric character references.
    // Validate the decoded addresses ExcelJS will use, including absolute refs.
    for (const tag of xml.matchAll(/<(?:\w+:)?(row|c|mergeCell)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/g)) {
      const attribute = tag[0].match(new RegExp(`\\s${tag[1] === 'mergeCell' ? 'ref' : 'r'}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
      if (!attribute) continue;
      const reference = decodeXMLAttribute(attribute[1] ?? attribute[2]);
      if (tag[1] === 'row') {
        const row = Number(reference);
        if (!/^\d+$/.test(reference) || !Number.isSafeInteger(row) || row < 1 || row > 1048576) throw new Error('This workbook contains an invalid cell or row address.');
      } else if (tag[1] === 'c') {
        const cell = reference.match(/^\$?([A-Z]+)\$?(\d+)$/i);
        if (!cell || Number(cell[2]) < 1 || Number(cell[2]) > 1048576) throw new Error('This workbook contains an invalid cell or row address.');
        if (columnNumber(cell[1]) > 16384) throw new Error('This workbook contains an invalid column address.');
      } else {
        const range = reference.match(/^\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/i);
        if (!range) throw new Error('This workbook contains an invalid merged-cell range.');
        const startColumn = columnNumber(range[1]);
        const endColumn = columnNumber(range[3] ?? range[1]);
        const startRow = Number(range[2]);
        const endRow = Number(range[4] ?? range[2]);
        if (startColumn > endColumn || startRow < 1 || startRow > endRow || endColumn > 16384 || endRow > 1048576) throw new Error('This workbook contains an invalid merged-cell range.');
        mergedCells += (endColumn - startColumn + 1) * (endRow - startRow + 1);
        if (mergedCells > 200000) throw new Error('This workbook has merged ranges too large for a browser preview. Download it to view the full workbook.');
      }
    }
  }
}

function columnNumber(value: string): number {
  let result = 0;
  for (const letter of value.toUpperCase()) result = result * 26 + letter.charCodeAt(0) - 64;
  return result;
}

function decodeXMLAttribute(value: string): string {
  return value.replace(/&([^;]+);/g, (_, entity: string) => {
    if (entity.startsWith('#')) {
      const number = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return Number.isInteger(number) && number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '\ufffd';
    }
    return ({ amp: '&', lt: '<', gt: '>', apos: "'", quot: '"' } as Record<string, string>)[entity] ?? '\ufffd';
  });
}

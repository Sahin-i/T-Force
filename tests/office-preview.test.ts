import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { inspectOfficeArchive, columnName, validateWorkbook } from '../client/office-preview-utils.js';

const docxEntries = { '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8('<document><p>Curiosity</p></document>') };

test('office preview validates ordinary archives and preserves their document data', () => {
  const docx = zipSync({ ...docxEntries, 'word/media/': new Uint8Array(0) });
  const inspected = inspectOfficeArchive(docx, 'docx');
  assert.equal(new TextDecoder().decode(inspected['word/document.xml']), '<document><p>Curiosity</p></document>');
  assert.equal(inspected['word/media/'].length, 0);
  const xlsx = zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'xl/workbook.xml': strToU8('<workbook/>') });
  assert.ok(inspectOfficeArchive(xlsx, 'xlsx')['xl/workbook.xml']);
});

test('office preview rejects corrupt, wrong-format and password-protected archives', () => {
  assert.throws(() => inspectOfficeArchive(strToU8('not a zip'), 'docx'), /not a readable/);
  const docx = zipSync(docxEntries);
  assert.throws(() => inspectOfficeArchive(docx, 'xlsx'), /does not contain a readable Excel/);
  const truncated = docx.subarray(0, docx.length - 5);
  assert.throws(() => inspectOfficeArchive(truncated, 'docx'), /not a readable/);
  const encrypted = docx.slice();
  const view = new DataView(encrypted.buffer);
  for (let index = 0; index < encrypted.length - 46; index++) {
    if (view.getUint32(index, true) === 0x02014b50) { view.setUint16(index + 8, view.getUint16(index + 8, true) | 1, true); break; }
  }
  assert.throws(() => inspectOfficeArchive(encrypted, 'docx'), /password protected/);
});

test('office preview rejects XML entities and archive traversal names', () => {
  const entities = zipSync({ ...docxEntries, 'word/document.xml': strToU8('<!DOCTYPE document [<!ENTITY value "test">]><document/>') });
  assert.throws(() => inspectOfficeArchive(entities, 'docx'), /unsupported XML/);
  const traversal = zipSync({ ...docxEntries, '../other.xml': strToU8('<data/>') });
  assert.throws(() => inspectOfficeArchive(traversal, 'docx'), /invalid archive entries/);
});

test('office preview enforces actual decompression limits even when ZIP metadata lies', () => {
  const oversized = zipSync({ ...docxEntries, 'word/oversized.xml': new Uint8Array(16 * 1024 * 1024 + 1) });
  assert.throws(() => inspectOfficeArchive(oversized, 'docx'), /too complex/);
  const view = new DataView(oversized.buffer);
  for (let index = 0; index < oversized.length - 46; index++) {
    if (view.getUint32(index, true) !== 0x02014b50) continue;
    if (view.getUint32(index + 24, true) > 16 * 1024 * 1024) view.setUint32(index + 24, 1, true);
  }
  assert.throws(() => inspectOfficeArchive(oversized, 'docx'), /too complex/);
});

test('office preview rejects more than 512 archive entries', () => {
  const entries = { ...docxEntries } as Record<string, Uint8Array>;
  for (let entry = 0; entry < 511; entry++) entries[`word/part${entry}.xml`] = strToU8('<part/>');
  assert.throws(() => inspectOfficeArchive(zipSync(entries), 'docx'), /too complex/);
});

test('workbook columns use Excel labels at letter boundaries', () => {
  assert.equal(columnName(1), 'A');
  assert.equal(columnName(26), 'Z');
  assert.equal(columnName(27), 'AA');
  assert.equal(columnName(50), 'AX');
});

test('workbook preview refuses invalid addresses and merged ranges that allocate excessive cells', () => {
  const worksheet = (xml: string) => ({ 'xl/worksheets/sheet1.xml': strToU8(xml) });
  assert.doesNotThrow(() => validateWorkbook(worksheet('<worksheet><row r="1"><c r="A1"/></row><mergeCell ref="A1:D2"/></worksheet>')));
  assert.throws(() => validateWorkbook(worksheet('<worksheet><row r="1048577"/></worksheet>')), /invalid cell or row/);
  assert.throws(() => validateWorkbook(worksheet('<worksheet><c r="XFE1"/></worksheet>')), /invalid column/);
  assert.throws(() => validateWorkbook(worksheet('<worksheet><mergeCell ref="A1:XFD1048576"/></worksheet>')), /merged ranges too large/);
  assert.throws(() => validateWorkbook(worksheet('<worksheet><mergeCell ref = "&#65;1:&#88;FD1048576"/></worksheet>')), /merged ranges too large/);
  assert.throws(() => validateWorkbook(worksheet('<worksheet><mergeCell ref="$A$1:$XFD$1048576"/></worksheet>')), /merged ranges too large/);
  assert.throws(() => validateWorkbook(worksheet('<worksheet><row description=">" r = "1048577"/></worksheet>')), /invalid cell or row/);
  assert.throws(() => validateWorkbook(worksheet('<worksheet><mergeCell ref="A0:B2"/></worksheet>')), /invalid merged-cell/);
});

test('workbook preview enforces text, cells and sheet limits before parsing', () => {
  assert.throws(() => validateWorkbook({ 'xl/sharedStrings.xml': strToU8(`<sst>${'<si><t>text</t></si>'.repeat(200001)}</sst>`) }), /too many text values/);
  assert.throws(() => validateWorkbook({ 'xl/worksheets/sheet1.xml': strToU8(`<worksheet>${'<c r="A1"/>'.repeat(200001)}</worksheet>`) }), /too many cells/);
  const sheets: Record<string, Uint8Array> = {};
  for (let index = 1; index <= 51; index++) sheets[`xl/worksheets/sheet${index}.xml`] = strToU8('<worksheet/>');
  assert.throws(() => validateWorkbook(sheets), /too many worksheets/);
});

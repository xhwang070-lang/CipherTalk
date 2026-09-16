/**
 * Extract plain text from Word / Excel buffers for WeChat bot and inspect_chat_file.
 * Never send the binary to the chat model.
 */
import * as ExcelJS from 'exceljs'
import * as XLSX from 'xlsx'

export type OfficeKind = 'docx' | 'doc' | 'xlsx' | 'xls' | 'csv' | 'unknown'

export type OfficeSheet = {
  name: string
  rows: string[][]
  truncated: boolean
}

export type OfficeExtractResult = {
  ok: boolean
  kind: OfficeKind
  text: string
  sheetNames?: string[]
  sheets?: OfficeSheet[]
  error?: string
}

const MAX_TEXT_CHARS = 80_000
const MAX_SHEETS = 12
const MAX_ROWS = 80
const MAX_COLS = 24
const MAX_CELL_CHARS = 120

function clip(value: string): string {
  const text = String(value || '').replace(/\r\n/g, '\n').trim()
  if (text.length <= MAX_CELL_CHARS) return text
  return `${text.slice(0, MAX_CELL_CHARS)}…`
}

function stripXml(xml: string): string {
  return xml
    .replace(/<w:tab\/>/g, ' ')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

export function officeKindFromName(filename: string): OfficeKind {
  const lower = String(filename || '').toLowerCase()
  if (lower.endsWith('.docx') || lower.endsWith('.docm')) return 'docx'
  if (lower.endsWith('.doc')) return 'doc'
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) return 'xlsx'
  if (lower.endsWith('.xls')) return 'xls'
  if (lower.endsWith('.csv')) return 'csv'
  return 'unknown'
}

export function isOfficeFileName(filename: string): boolean {
  return officeKindFromName(filename) !== 'unknown'
}

export function officeMediaTypeFromName(filename: string): string {
  switch (officeKindFromName(filename)) {
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case 'doc':
      return 'application/msword'
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    case 'xls':
      return 'application/vnd.ms-excel'
    case 'csv':
      return 'text/csv'
    default:
      return 'application/octet-stream'
  }
}

function formatSheets(sheets: OfficeSheet[]): string {
  return sheets.map((sheet) => {
    const body = sheet.rows.map((row) => row.join('\t')).join('\n')
    const more = sheet.truncated ? '\n…（表格已截断）' : ''
    return `工作表：${sheet.name}\n${body}${more}`
  }).join('\n\n')
}

function clipText(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text
  return `${text.slice(0, MAX_TEXT_CHARS)}\n…（正文已截断）`
}

function cellFromExcelJs(value: ExcelJS.CellValue | undefined | null): string {
  if (value == null || value === '') return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return clip(String(value))
  if (value instanceof Date) {
    const y = value.getFullYear()
    const m = String(value.getMonth() + 1).padStart(2, '0')
    const d = String(value.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>
    if (Array.isArray(rec.richText)) {
      return clip((rec.richText as Array<{ text?: string }>).map((part) => part.text || '').join(''))
    }
    if (typeof rec.text === 'string') return clip(rec.text)
    if ('result' in rec) return cellFromExcelJs(rec.result as ExcelJS.CellValue)
    if (typeof rec.hyperlink === 'string') return clip(String(rec.text || rec.hyperlink))
  }
  return clip(String(value))
}

async function extractDocx(buffer: Buffer): Promise<string> {
  const mod = await import('jszip')
  const JSZip = (mod as { default?: typeof import('jszip') }).default || (mod as typeof import('jszip'))
  const zip = await JSZip.loadAsync(buffer)
  const doc = zip.file('word/document.xml')
  if (!doc) throw new Error('不是有效的 Word 文件')
  return stripXml(await doc.async('string'))
}

async function extractDoc(buffer: Buffer): Promise<string> {
  const mod = await import('word-extractor')
  const WordExtractor = mod.default
  const document = await new WordExtractor().extract(buffer)
  return String(document.getBody() || '').replace(/\n{3,}/g, '\n\n').trim()
}

async function extractXlsx(buffer: Buffer): Promise<{ sheetNames: string[]; sheets: OfficeSheet[] }> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  const sheetNames = workbook.worksheets.map((sheet) => sheet.name).slice(0, MAX_SHEETS)
  if (sheetNames.length === 0) throw new Error('工作簿里没有工作表')
  const sheets: OfficeSheet[] = []
  for (const name of sheetNames) {
    const worksheet = workbook.getWorksheet(name)
    if (!worksheet) continue
    const rows: string[][] = []
    let rowCount = 0
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      rowCount = Math.max(rowCount, rowNumber)
      if (rows.length >= MAX_ROWS) return
      const values: string[] = []
      const last = Math.min(row.cellCount || 0, MAX_COLS)
      for (let i = 1; i <= last; i += 1) values.push(cellFromExcelJs(row.getCell(i).value))
      while (values.length > 0 && values[values.length - 1] === '') values.pop()
      rows.push(values)
    })
    sheets.push({
      name,
      rows,
      truncated: rowCount > rows.length,
    })
  }
  return { sheetNames, sheets }
}

function extractXls(buffer: Buffer): { sheetNames: string[]; sheets: OfficeSheet[] } {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, codepage: 936 })
  const sheetNames = (workbook.SheetNames || []).slice(0, MAX_SHEETS)
  if (sheetNames.length === 0) throw new Error('工作簿里没有工作表')
  const sheets: OfficeSheet[] = sheetNames.map((name) => {
    const sheet = workbook.Sheets[name]
    const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' }) as unknown[][]
    const rows = raw.slice(0, MAX_ROWS).map((row) => {
      const values = (Array.isArray(row) ? row : []).slice(0, MAX_COLS).map((cell) => clip(String(cell ?? '')))
      while (values.length > 0 && values[values.length - 1] === '') values.pop()
      return values
    })
    return {
      name,
      rows,
      truncated: raw.length > rows.length,
    }
  })
  return { sheetNames, sheets }
}

function extractCsv(buffer: Buffer): { sheetNames: string[]; sheets: OfficeSheet[] } {
  const raw = buffer.toString('utf8')
  const lines = raw.split(/\r?\n/).filter((line) => line.length > 0)
  const rows = lines.slice(0, MAX_ROWS).map((line) => line.split(',').slice(0, MAX_COLS).map((cell) => clip(cell.replace(/^"|"$/g, ''))))
  return {
    sheetNames: ['Sheet1'],
    sheets: [{
      name: 'Sheet1',
      rows,
      truncated: lines.length > MAX_ROWS,
    }],
  }
}

export async function extractOfficeBuffer(buffer: Buffer, filename: string): Promise<OfficeExtractResult> {
  const kind = officeKindFromName(filename)
  if (kind === 'unknown') {
    return { ok: false, kind, text: '', error: '不是 Word / Excel 文件' }
  }
  try {
    if (kind === 'docx') {
      const text = clipText(await extractDocx(buffer))
      if (!text) return { ok: false, kind, text: '', error: 'Word 里没有可读正文' }
      return { ok: true, kind, text }
    }
    if (kind === 'doc') {
      const text = clipText(await extractDoc(buffer))
      if (!text) return { ok: false, kind, text: '', error: '老版 Word 里没有可读正文' }
      return { ok: true, kind, text }
    }
    const parsed = kind === 'xlsx'
      ? await extractXlsx(buffer)
      : kind === 'xls'
        ? extractXls(buffer)
        : extractCsv(buffer)
    const text = clipText(formatSheets(parsed.sheets))
    if (!text.trim()) return { ok: false, kind, text: '', error: '表格是空的' }
    return {
      ok: true,
      kind,
      text,
      sheetNames: parsed.sheetNames,
      sheets: parsed.sheets,
    }
  } catch (error) {
    return {
      ok: false,
      kind,
      text: '',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function officeResultForModel(filename: string, result: OfficeExtractResult): string {
  if (!result.ok) {
    return `用户发来「${filename}」，但读不出来：${result.error || '未知错误'}。不要编造内容。`
  }
  if (result.kind === 'docx' || result.kind === 'doc') {
    return `用户发来 Word「${filename}」正文：\n${result.text}`
  }
  return `用户发来表格「${filename}」单元格原文：\n${result.text}`
}

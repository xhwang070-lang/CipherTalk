import fs from 'fs'
import path from 'path'
import * as ExcelJS from 'exceljs'
import { ConfigService } from '../config'
import { findAccountDir } from './accountUtils'
import type { Message } from './types'

export const SPREADSHEET_EXTS = new Set(['xlsx', 'xlsm', 'xls', 'csv'])
const PREVIEWABLE_EXTS = new Set(['xlsx', 'xlsm', 'csv'])
const MAX_FILE_BYTES = 40 * 1024 * 1024
const MAX_SHEETS = 24
const DEFAULT_MAX_ROWS = 80
const MAX_ROWS_HARD = 200
const MAX_COLS = 24
const MAX_CELL_CHARS = 120

export type ChatFileKind = 'xlsx' | 'xls' | 'csv' | 'unsupported' | 'missing'

export interface ChatFileSheetPreview {
  name: string
  rows: string[][]
  rowCount: number
  colCount: number
  truncated: boolean
}

export interface ChatFilePreviewResult {
  success: boolean
  exists: boolean
  fileName: string
  filePath?: string
  kind: ChatFileKind
  sizeBytes?: number
  sheetNames: string[]
  sheet?: ChatFileSheetPreview
  error?: string
  hint?: string
}

export interface PreviewChatFileInput {
  sessionId?: string
  localId?: number
  fileName?: string
  fileExt?: string
  createTime?: number
  sheetName?: string
  maxRows?: number
}

function extOf(fileName: string, fileExt?: string): string {
  const fromName = path.extname(fileName || '').replace(/^\./, '').toLowerCase()
  const fromExt = String(fileExt || '').replace(/^\./, '').toLowerCase()
  return fromName || fromExt
}

function kindOf(ext: string): ChatFileKind {
  if (ext === 'xlsx' || ext === 'xlsm') return 'xlsx'
  if (ext === 'xls') return 'xls'
  if (ext === 'csv') return 'csv'
  return 'unsupported'
}

function monthDirFromUnixSeconds(createTime?: number): string {
  const seconds = Number(createTime || 0)
  const date = seconds > 0 ? new Date(seconds * 1000) : new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function formatDate(value: Date): string {
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`
}

export function cellToText(value: ExcelJS.CellValue | undefined | null): string {
  if (value == null || value === '') return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return formatDate(value)
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>
    if (Array.isArray(rec.richText)) {
      return (rec.richText as Array<{ text?: string }>).map((part) => part.text || '').join('')
    }
    if (typeof rec.text === 'string') return rec.text
    if ('result' in rec) return cellToText(rec.result as ExcelJS.CellValue)
    if (typeof rec.hyperlink === 'string') return String(rec.text || rec.hyperlink)
    if (typeof rec.error === 'string') return ''
    if (typeof rec.formula === 'string') return ''
  }
  return String(value)
}

function clipCell(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (normalized.length <= MAX_CELL_CHARS) return normalized
  return `${normalized.slice(0, MAX_CELL_CHARS)}…`
}

function listMonthDirs(base: string, preferredMonth?: string): string[] {
  const dirs: string[] = []
  if (preferredMonth) dirs.push(path.join(base, preferredMonth))
  if (!fs.existsSync(base)) return dirs
  try {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const full = path.join(base, entry.name)
      if (!dirs.includes(full)) dirs.push(full)
    }
  } catch {
    /* ignore unreadable month folders */
  }
  if (!dirs.includes(base)) dirs.push(base)
  return dirs
}

function listCandidateDirs(dbPath: string, accountDir: string, monthDir: string): string[] {
  const bases = [
    path.join(dbPath, accountDir, 'msg', 'file'),
    path.join(dbPath, accountDir, 'FileStorage', 'File'),
    path.join(dbPath, 'FileStorage', 'File'),
  ]
  const dirs: string[] = []
  for (const base of bases) {
    for (const dir of listMonthDirs(base, monthDir)) {
      if (!dirs.includes(dir)) dirs.push(dir)
    }
  }
  return dirs
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isWeChatDuplicateName(name: string, stem: string, ext: string): boolean {
  const pattern = new RegExp(`^${escapeRegExp(stem)}(?:\\(\\d+\\))?${escapeRegExp(ext)}$`, 'i')
  return pattern.test(name)
}

function stemAndExt(fileName: string): { stem: string; ext: string } {
  const ext = path.extname(fileName)
  return { stem: path.basename(fileName, ext), ext }
}

function scoreDuplicate(filePath: string, createTime?: number): number {
  try {
    const mtime = fs.statSync(filePath).mtimeMs
    const target = Number(createTime || 0) > 0 ? Number(createTime) * 1000 : mtime
    return Math.abs(mtime - target)
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

export function resolveChatFilePath(input: {
  dbPath: string
  wxid: string
  fileName: string
  createTime?: number
}): string | null {
  const fileName = String(input.fileName || '').trim()
  if (!fileName || !input.dbPath) return null
  const accountDir = findAccountDir(input.dbPath, input.wxid) || input.wxid
  const monthDir = monthDirFromUnixSeconds(input.createTime)
  const dirs = listCandidateDirs(input.dbPath, accountDir, monthDir)

  for (const dir of dirs) {
    const exact = path.join(dir, fileName)
    if (fs.existsSync(exact) && fs.statSync(exact).isFile()) return exact
  }

  const { stem, ext } = stemAndExt(fileName)
  if (!stem) return null
  let best: { filePath: string; score: number } | null = null
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue
    let entries: string[] = []
    try {
      entries = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      const sameExt = !ext || name.toLowerCase().endsWith(ext.toLowerCase())
      const matched = isWeChatDuplicateName(name, stem, ext) || (sameExt && name.startsWith(stem))
      if (!matched) continue
      const filePath = path.join(dir, name)
      try {
        if (!fs.statSync(filePath).isFile()) continue
      } catch {
        continue
      }
      const score = scoreDuplicate(filePath, input.createTime)
      if (!best || score < best.score) best = { filePath, score }
    }
  }
  return best?.filePath || null
}

function parseCsv(filePath: string, maxRows: number): ChatFileSheetPreview {
  const raw = fs.readFileSync(filePath, 'utf8')
  const lines = raw.split(/\r?\n/).filter((line) => line.length > 0)
  const rows = lines.slice(0, maxRows).map((line) => {
    const cols = line.split(',').slice(0, MAX_COLS).map((cell) => clipCell(cell.replace(/^"|"$/g, '')))
    return cols
  })
  const colCount = rows.reduce((max, row) => Math.max(max, row.length), 0)
  return {
    name: 'Sheet1',
    rows,
    rowCount: lines.length,
    colCount,
    truncated: lines.length > maxRows || rows.some((row) => row.length >= MAX_COLS),
  }
}

async function parseXlsx(filePath: string, sheetName: string | undefined, maxRows: number): Promise<{
  sheetNames: string[]
  sheet: ChatFileSheetPreview
}> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(filePath)
  const sheetNames = workbook.worksheets.map((sheet) => sheet.name).slice(0, MAX_SHEETS)
  if (sheetNames.length === 0) {
    throw new Error('工作簿里没有工作表')
  }
  const wanted = sheetName && sheetNames.includes(sheetName) ? sheetName : sheetNames[0]
  const worksheet = workbook.getWorksheet(wanted)
  if (!worksheet) throw new Error(`找不到工作表：${wanted}`)

  const rows: string[][] = []
  let rowCount = 0
  let colCount = 0
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    rowCount = Math.max(rowCount, rowNumber)
    if (rows.length >= maxRows) return
    const values: string[] = []
    const last = Math.min(row.cellCount || 0, MAX_COLS)
    for (let i = 1; i <= last; i += 1) {
      values.push(clipCell(cellToText(row.getCell(i).value)))
    }
    while (values.length > 0 && values[values.length - 1] === '') values.pop()
    colCount = Math.max(colCount, values.length)
    rows.push(values)
  })

  return {
    sheetNames,
    sheet: {
      name: wanted,
      rows,
      rowCount: Math.max(rowCount, rows.length),
      colCount,
      truncated: rowCount > rows.length || colCount >= MAX_COLS,
    },
  }
}

function missingResult(fileName: string, kind: ChatFileKind, error?: string, hint?: string): ChatFilePreviewResult {
  return {
    success: false,
    exists: false,
    fileName,
    kind: kind === 'unsupported' ? 'unsupported' : 'missing',
    sheetNames: [],
    error: error || '本地没有这个文件',
    hint: hint || '请先在微信里点开下载，下载完成后再回Huaji预览。Huaji不会从微信服务器拉文件。',
  }
}

export async function previewResolvedFile(input: {
  filePath: string
  fileName?: string
  sheetName?: string
  maxRows?: number
}): Promise<ChatFilePreviewResult> {
  const filePath = input.filePath
  const fileName = input.fileName || path.basename(filePath)
  const ext = extOf(fileName)
  const kind = kindOf(ext)
  const maxRows = Math.min(MAX_ROWS_HARD, Math.max(1, Number(input.maxRows || DEFAULT_MAX_ROWS)))

  if (!fs.existsSync(filePath)) {
    return missingResult(fileName, kind)
  }

  const stat = fs.statSync(filePath)
  if (!stat.isFile()) return missingResult(fileName, kind, '路径不是文件')
  if (stat.size <= 0) return missingResult(fileName, kind, '文件是空的')
  if (stat.size > MAX_FILE_BYTES) {
    return {
      success: false,
      exists: true,
      fileName,
      filePath,
      kind,
      sizeBytes: stat.size,
      sheetNames: [],
      error: `文件过大（${Math.round(stat.size / 1024 / 1024)}MB），第一期只预览 40MB 以内的表`,
    }
  }

  if (kind === 'xls') {
    return {
      success: false,
      exists: true,
      fileName,
      filePath,
      kind,
      sizeBytes: stat.size,
      sheetNames: [],
      error: '暂不读取老版 .xls（Excel 97-2003）',
      hint: '可点“打开位置”用 Excel 查看。第一期只读 .xlsx。',
    }
  }

  if (kind === 'unsupported' || !PREVIEWABLE_EXTS.has(ext)) {
    return {
      success: false,
      exists: true,
      fileName,
      filePath,
      kind: 'unsupported',
      sizeBytes: stat.size,
      sheetNames: [],
      error: `暂不预览 .${ext || '未知'} 文件`,
      hint: '第一期只读 Excel 表格（.xlsx）。PDF 和其它附件仍可打开所在文件夹。',
    }
  }

  try {
    if (kind === 'csv') {
      const sheet = parseCsv(filePath, maxRows)
      return {
        success: true,
        exists: true,
        fileName,
        filePath,
        kind,
        sizeBytes: stat.size,
        sheetNames: [sheet.name],
        sheet,
      }
    }
    const parsed = await parseXlsx(filePath, input.sheetName, maxRows)
    return {
      success: true,
      exists: true,
      fileName,
      filePath,
      kind,
      sizeBytes: stat.size,
      sheetNames: parsed.sheetNames,
      sheet: parsed.sheet,
    }
  } catch (error) {
    return {
      success: false,
      exists: true,
      fileName,
      filePath,
      kind,
      sizeBytes: stat.size,
      sheetNames: [],
      error: error instanceof Error ? error.message : String(error),
      hint: '文件可能损坏，或还在微信写入中。可稍后再试，或打开所在文件夹用 Excel 查看。',
    }
  }
}

export async function previewChatFile(input: PreviewChatFileInput & { message?: Message }): Promise<ChatFilePreviewResult> {
  const fileName = String(input.fileName || input.message?.fileName || '').trim()
  const fileExt = input.fileExt || input.message?.fileExt
  const createTime = Number(input.createTime || input.message?.createTime || 0) || undefined
  const kind = kindOf(extOf(fileName, fileExt))
  if (!fileName) {
    return missingResult('', 'unsupported', '这条消息没有文件名', '请选一条文件消息。')
  }

  const config = new ConfigService()
  try {
    const dbPath = String(config.get('dbPath') || '').trim()
    const wxid = String(config.get('myWxid') || '').trim()
    if (!dbPath || !wxid) {
      return missingResult(fileName, kind, '还没有配置微信数据目录或账号')
    }
    const filePath = resolveChatFilePath({ dbPath, wxid, fileName, createTime })
    if (!filePath) return missingResult(fileName, kind)
    return previewResolvedFile({
      filePath,
      fileName,
      sheetName: input.sheetName,
      maxRows: input.maxRows,
    })
  } finally {
    config.close()
  }
}

export function isSpreadsheetFileName(fileName?: string, fileExt?: string): boolean {
  return SPREADSHEET_EXTS.has(extOf(fileName || '', fileExt))
}

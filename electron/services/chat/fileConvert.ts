/**
 * 本机文件互转。读用现有 Office 解析；写出用 exceljs / docx / pdf-lib。
 * 不走 Firecrawl 云 OCR。扫描 PDF 转不出表格。
 */
import fs from 'fs'
import path from 'path'
import * as ExcelJS from 'exceljs'
import * as XLSX from 'xlsx'
import { PDFDocument } from 'pdf-lib'
import { Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx'
import { ConfigService } from '../config'
import { extractOfficeBuffer, officeKindFromName, type OfficeSheet } from './officeExtract'

export type ConvertTarget = 'xlsx' | 'csv' | 'docx' | 'pdf' | 'md'

export type ConvertResult = {
  ok: boolean
  filePath?: string
  fileName?: string
  error?: string
}

const MAX_ROWS = 4000
const MAX_COLS = 40

export function parseConvertTarget(text: string): ConvertTarget | null {
  const compact = String(text || '').replace(/\s+/g, '')
  if (!compact) return null
  const hasVerb = /(转成|转换成|另存为|导出成|导出为|转一份|改成|变成)/.test(compact)
    || /转(excel|word|pdf|表格|csv|xlsx|docx)/i.test(compact)
    || /导出(excel|word|pdf|表格|csv|xlsx|docx|md)/i.test(compact)
  if (!hasVerb) return null
  const lower = compact.toLowerCase()
  if (/pdf/.test(lower)) return 'pdf'
  if (/csv/.test(lower)) return 'csv'
  if (/markdown|\.md|md文件/.test(lower)) return 'md'
  if (/excel|xlsx|xls|表格|电子表格/.test(lower)) return 'xlsx'
  if (/word|docx|doc文件|文档/.test(lower)) return 'docx'
  return null
}

export function looksLikeConvertCommand(text: string): boolean {
  return parseConvertTarget(text) != null
}

function convertDir(): string {
  const cs = new ConfigService()
  try {
    const dir = path.join(cs.getCacheBasePath(), 'ai-converted')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    return dir
  } finally {
    cs.close()
  }
}

function safeStem(filename: string): string {
  const base = path.basename(String(filename || 'file')).replace(/\.[^.]+$/, '')
  return base.replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 40) || 'file'
}

function writeOut(stem: string, ext: string, data: Buffer): { filePath: string; fileName: string } {
  const fileName = `${stem}-转.${ext}`
  const filePath = path.join(convertDir(), `${Date.now()}-${fileName}`)
  fs.writeFileSync(filePath, data)
  return { filePath, fileName }
}

function clipCell(value: unknown): string {
  return String(value ?? '').replace(/\r\n/g, '\n').trim()
}

function sheetsFromXlsxBuffer(buffer: Buffer): OfficeSheet[] {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  const sheets: OfficeSheet[] = []
  for (const name of workbook.SheetNames.slice(0, 12)) {
    const sheet = workbook.Sheets[name]
    const rows = (XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' }) as unknown[][])
      .slice(0, MAX_ROWS)
      .map((row) => row.slice(0, MAX_COLS).map((cell) => clipCell(cell)))
    sheets.push({ name, rows, truncated: false })
  }
  return sheets
}

async function sheetsFromOffice(buffer: Buffer, filename: string): Promise<OfficeSheet[] | { error: string }> {
  const kind = officeKindFromName(filename)
  if (kind === 'xlsx' || kind === 'xls' || kind === 'csv') {
    try {
      const sheets = sheetsFromXlsxBuffer(buffer)
      if (!sheets.length) return { error: '表格是空的' }
      return sheets
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
  const extracted = await extractOfficeBuffer(buffer, filename)
  if (!extracted.ok) return { error: extracted.error || '读不出来' }
  if (extracted.sheets?.length) return extracted.sheets
  const lines = extracted.text.split(/\n/).filter(Boolean)
  return [{ name: 'Sheet1', rows: lines.map((line) => [line]), truncated: false }]
}

async function toXlsx(sheets: OfficeSheet[], stem: string): Promise<ConvertResult> {
  const workbook = new ExcelJS.Workbook()
  for (const sheet of sheets) {
    const ws = workbook.addWorksheet(sheet.name.slice(0, 31) || 'Sheet')
    for (const row of sheet.rows) ws.addRow(row)
  }
  const data = Buffer.from(await workbook.xlsx.writeBuffer())
  const out = writeOut(stem, 'xlsx', data)
  return { ok: true, ...out }
}

function toCsv(sheets: OfficeSheet[], stem: string): ConvertResult {
  const sheet = sheets[0]
  if (!sheet) return { ok: false, error: '没有可导出的表' }
  const csv = sheet.rows
    .map((row) => row.map((cell) => /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell).join(','))
    .join('\r\n')
  const out = writeOut(stem, 'csv', Buffer.from(csv, 'utf8'))
  return { ok: true, ...out }
}

function toMarkdown(sheets: OfficeSheet[], text: string, stem: string): ConvertResult {
  let md = ''
  if (sheets.length && sheets.some((sheet) => sheet.rows.some((row) => row.length > 1))) {
    md = sheets.map((sheet) => {
      const rows = sheet.rows.filter((row) => row.some((cell) => cell.trim()))
      if (!rows.length) return `## ${sheet.name}\n`
      const width = Math.max(...rows.map((row) => row.length), 1)
      const pad = (row: string[]) => Array.from({ length: width }, (_, i) => (row[i] || '').replace(/\|/g, '\\|'))
      const header = pad(rows[0])
      const body = rows.slice(1).map((row) => `| ${pad(row).join(' | ')} |`)
      return `## ${sheet.name}\n\n| ${header.join(' | ')} |\n| ${header.map(() => '---').join(' | ')} |\n${body.join('\n')}`
    }).join('\n\n')
  } else {
    md = text.trim()
  }
  if (!md.trim()) return { ok: false, error: '没有可写的正文' }
  const out = writeOut(stem, 'md', Buffer.from(md, 'utf8'))
  return { ok: true, ...out }
}

async function toDocx(sheets: OfficeSheet[], text: string, stem: string): Promise<ConvertResult> {
  const children: Array<Paragraph | Table> = []
  const hasTable = sheets.some((sheet) => sheet.rows.some((row) => row.length > 1))
  if (hasTable) {
    for (const sheet of sheets) {
      children.push(new Paragraph({ children: [new TextRun({ text: sheet.name, bold: true })] }))
      const rows = sheet.rows.slice(0, 200)
      if (!rows.length) continue
      const width = Math.max(...rows.map((row) => row.length), 1)
      children.push(new Table({
        width: { size: 9000, type: WidthType.DXA },
        rows: rows.map((row) => new TableRow({
          children: Array.from({ length: width }, (_, i) => new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: row[i] || '', size: 20 })] })],
          })),
        })),
      }))
    }
  } else {
    const lines = (text || '').split(/\n/)
    for (const line of lines) children.push(new Paragraph({ children: [new TextRun(line || ' ')] }))
  }
  if (!children.length) return { ok: false, error: '没有可写的正文' }
  const doc = new Document({ sections: [{ children }] })
  const data = Buffer.from(await Packer.toBuffer(doc))
  const out = writeOut(stem, 'docx', data)
  return { ok: true, ...out }
}

async function imageToPdf(buffer: Buffer, stem: string): Promise<ConvertResult> {
  const pdf = await PDFDocument.create()
  const looksPng = buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50
  const looksJpg = buffer.length > 2 && buffer[0] === 0xff && buffer[1] === 0xd8
  let working = buffer
  let png = looksPng
  if (!looksPng && !looksJpg) {
    const sharp = (await import('sharp')).default
    working = await sharp(buffer).png().toBuffer()
    png = true
  }
  const image = png ? await pdf.embedPng(working) : await pdf.embedJpg(working)
  const page = pdf.addPage([image.width, image.height])
  page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height })
  const data = Buffer.from(await pdf.save())
  const out = writeOut(stem, 'pdf', data)
  return { ok: true, ...out }
}

function looksLikeImage(filename: string, mediaType?: string): boolean {
  const lower = `${filename} ${mediaType || ''}`.toLowerCase()
  return /\.(png|jpe?g|webp)$/i.test(filename) || /image\/(png|jpeg|jpg|webp)/.test(lower)
}

export async function convertFileBuffer(input: {
  buffer: Buffer
  filename: string
  mediaType?: string
  target: ConvertTarget
}): Promise<ConvertResult> {
  const stem = safeStem(input.filename)
  const kind = officeKindFromName(input.filename)
  const isImage = looksLikeImage(input.filename, input.mediaType)

  if (/\.pdf$/i.test(input.filename)) {
    if (input.target === 'pdf') return { ok: false, error: '已经是 PDF。要去掉密码请说「解密」。' }
    return { ok: false, error: '扫描件 PDF 不能变成表格。表格请发 Excel；图片可以转 PDF。' }
  }

  if (input.target === 'pdf') {
    if (isImage) return imageToPdf(input.buffer, stem)
    return { ok: false, error: '中文表格/合同请转 Word 或 Excel。图片可以转 PDF。' }
  }

  if (isImage) return { ok: false, error: '图片只能转 PDF。表格和合同请发 Excel / Word 原文件。' }

  if (kind === 'unknown') {
    return { ok: false, error: '目前能转 Excel / Word / CSV / 图片。这个格式还没有。' }
  }

  const sheetsOrError = await sheetsFromOffice(input.buffer, input.filename)
  if ('error' in sheetsOrError) return { ok: false, error: sheetsOrError.error }
  const extracted = await extractOfficeBuffer(input.buffer, input.filename)
  const text = extracted.ok ? extracted.text : ''

  if (input.target === 'xlsx') return toXlsx(sheetsOrError, stem)
  if (input.target === 'csv') return toCsv(sheetsOrError, stem)
  if (input.target === 'md') return toMarkdown(sheetsOrError, text, stem)
  if (input.target === 'docx') return toDocx(sheetsOrError, text, stem)
  return { ok: false, error: '不支持这个目标格式' }
}

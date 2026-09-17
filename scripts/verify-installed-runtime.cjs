/**
 * Fail pack:hot if the installed app cannot load Word/Excel parsers,
 * or if sample office/PDF files cannot be read.
 */
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const filesDir = 'C:\\Users\\Administrator\\Documents\\xwechat_files\\wxid_zo70e3jy8qd412_7f92\\msg\\file'
const MUST_RESOLVE = ['xlsx', 'word-extractor', 'exceljs', 'jszip', 'qrcode', 'codepage', 'docx', 'pdf-lib']

function firstFile(dir, ext) {
  if (!fs.existsSync(dir)) return null
  const months = fs.readdirSync(dir).sort().reverse()
  for (const month of months) {
    const folder = path.join(dir, month)
    let st
    try { st = fs.statSync(folder) } catch { continue }
    if (!st.isDirectory()) continue
    for (const name of fs.readdirSync(folder)) {
      if (path.extname(name).toLowerCase() === ext) return path.join(folder, name)
    }
  }
  return null
}

function assertResolve(appDir, ids) {
  const missing = []
  for (const id of ids) {
    try {
      require.resolve(id, { paths: [appDir] })
    } catch (error) {
      missing.push(id + ' (' + error.message + ')')
    }
  }
  if (missing.length) throw new Error('installed app missing modules:\n  - ' + missing.join('\n  - '))
}

function latexSelfCheck() {
  const out = '$24 \\times 49 = 1176$元'
    .replace(/\$([^$\n]+?)\$/g, (_, expr) => expr.replace(/\\times/g, '×').replace(/\\mathbf\{([^}]*)\}/g, '$1'))
  if (out.includes('$') || out.includes('\\times') || !out.includes('×')) {
    throw new Error('latex sanitize failed: ' + out)
  }
}

async function main() {
  const appDir = process.argv[2] || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Huaji', 'resources', 'app')
  if (!fs.existsSync(appDir)) throw new Error('installed app missing: ' + appDir)
  assertResolve(appDir, MUST_RESOLVE)
  console.log('resolve ok:', MUST_RESOLVE.join(', '))

  const XLSX = require(require.resolve('xlsx', { paths: [appDir] }))
  const ExcelJS = require(require.resolve('exceljs', { paths: [appDir] }))
  const WordExtractor = require(require.resolve('word-extractor', { paths: [appDir] }))
  const JSZip = require(require.resolve('jszip', { paths: [appDir] }))

  const xlsxPath = firstFile(filesDir, '.xlsx')
  const xlsPath = firstFile(filesDir, '.xls')
  const docxPath = firstFile(filesDir, '.docx')
  const docPath = firstFile(filesDir, '.doc')
  const pdfPath = firstFile(filesDir, '.pdf')

  if (xlsxPath) {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(xlsxPath)
    if (!wb.worksheets.length) throw new Error('exceljs empty ' + xlsxPath)
    console.log('exceljs xlsx ok', path.basename(xlsxPath), 'sheets', wb.worksheets.length)
  } else throw new Error('no .xlsx sample')

  if (xlsPath) {
    const wb = XLSX.readFile(xlsPath, { codepage: 936 })
    if (!wb.SheetNames.length) throw new Error('xlsx lib empty ' + xlsPath)
    console.log('sheetjs xls ok', path.basename(xlsPath), 'sheets', wb.SheetNames.length)
  } else throw new Error('no .xls sample')

  if (docxPath) {
    const zip = await JSZip.loadAsync(fs.readFileSync(docxPath))
    if (!zip.file('word/document.xml')) throw new Error('docx zip missing document.xml')
    const extracted = await new WordExtractor().extract(docxPath)
    const body = String(extracted.getBody() || '').replace(/\s+/g, '')
    if (body.length < 8) throw new Error('docx text empty')
    console.log('docx ok', path.basename(docxPath), 'chars', body.length)
  } else throw new Error('no .docx sample')

  if (docPath) {
    const extracted = await new WordExtractor().extract(docPath)
    const body = String(extracted.getBody() || '').replace(/\s+/g, '')
    if (body.length < 4) throw new Error('doc text empty: ' + docPath)
    console.log('doc ok', path.basename(docPath), 'chars', body.length)
  } else throw new Error('no .doc sample')

  if (pdfPath) {
    const pdf = fs.readFileSync(pdfPath)
    const jpeg = pdf.includes(Buffer.from([0xff, 0xd8, 0xff]))
    const header = pdf.slice(0, 5).toString()
    if (header !== '%PDF-') throw new Error('pdf header bad')
    console.log('pdf ok', path.basename(pdfPath), 'bytes', pdf.length, 'embeddedJpeg', jpeg)
  } else throw new Error('no .pdf sample')

  latexSelfCheck()
  console.log('latex ok')

  const { Document, Packer, Paragraph, TextRun } = require(require.resolve('docx', { paths: [appDir] }))
  const { PDFDocument } = require(require.resolve('pdf-lib', { paths: [appDir] }))
  const doc = new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun('huaji')] })] }] })
  const docBuf = await Packer.toBuffer(doc)
  if (!docBuf || docBuf.length < 100) throw new Error('docx pack empty')
  console.log('docx write ok', docBuf.length)
  const pdf = await PDFDocument.create()
  pdf.addPage([200, 200])
  const pdfBuf = await pdf.save()
  if (!pdfBuf || pdfBuf.length < 100) throw new Error('pdf-lib save empty')
  console.log('pdf-lib write ok', pdfBuf.length)

  console.log('verify-installed-runtime ok')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})

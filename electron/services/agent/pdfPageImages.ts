/**
 * Pull full-page JPEGs out of a scanned PDF (DCTDecode XObjects).
 * Text-layer PDFs without embedded JPEGs return [].
 */
export function extractJpegPagesFromPdf(
  pdf: Buffer,
  options: { minPixels?: number; maxPages?: number } = {},
): Buffer[] {
  const minPixels = options.minPixels ?? 400 * 400
  const maxPages = options.maxPages ?? 6
  const pages: { area: number; data: Buffer }[] = []
  const needle = Buffer.from('/Subtype')
  let pos = 0
  while (pos < pdf.length) {
    const hit = pdf.indexOf(needle, pos)
    if (hit < 0) break
    pos = hit + needle.length
    const dictStart = Math.max(0, hit - 80)
    const dictEnd = Math.min(pdf.length, hit + 900)
    const dict = pdf.subarray(dictStart, dictEnd).toString('latin1')
    if (!/\/Subtype\s*\/Image\b/.test(dict)) continue
    if (!/DCTDecode/.test(dict)) continue
    const width = Number((/\/Width\s+(\d+)/.exec(dict) || [])[1] || 0)
    const height = Number((/\/Height\s+(\d+)/.exec(dict) || [])[1] || 0)
    if (!width || !height || width * height < minPixels) continue
    const streamAt = pdf.indexOf(Buffer.from('stream'), hit)
    if (streamAt < 0 || streamAt > hit + 1200) continue
    let dataStart = streamAt + 6
    if (pdf[dataStart] === 0x0d) dataStart += 1
    if (pdf[dataStart] === 0x0a) dataStart += 1
    const endAt = pdf.indexOf(Buffer.from('endstream'), dataStart)
    if (endAt < 0) continue
    let data = pdf.subarray(dataStart, endAt)
    const eoi = data.lastIndexOf(Buffer.from([0xff, 0xd9]))
    if (data[0] !== 0xff || data[1] !== 0xd8 || eoi < 2) continue
    data = Buffer.from(data.subarray(0, eoi + 2))
    pages.push({ area: width * height, data })
  }
  pages.sort((a, b) => b.area - a.area)
  const uniq: Buffer[] = []
  const seen = new Set<string>()
  for (const page of pages) {
    const key = `${page.data.length}:${page.data.subarray(0, 32).toString('hex')}`
    if (seen.has(key)) continue
    seen.add(key)
    uniq.push(page.data)
    if (uniq.length >= maxPages) break
  }
  return uniq
}

export function parseDataUrlBuffer(dataUrl: string): { mediaType: string; buffer: Buffer } | null {
  const match = String(dataUrl || '').match(/^data:([^;,]+)?((?:;[^,]*)*),([\s\S]*)$/)
  if (!match) return null
  const mediaType = (match[1] || 'application/octet-stream').trim() || 'application/octet-stream'
  const flags = match[2] || ''
  const body = match[3] || ''
  try {
    const buffer = flags.includes(';base64')
      ? Buffer.from(body, 'base64')
      : Buffer.from(decodeURIComponent(body), 'utf8')
    return buffer.length > 0 ? { mediaType, buffer } : null
  } catch {
    return null
  }
}

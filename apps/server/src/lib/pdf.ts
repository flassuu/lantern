/**
 * One report as a PNG-free, dependency-free PDF.
 *
 * A PDF library is a lot of bytes to carry into a single-binary server for one
 * table, and the table is a shape small enough to write directly: a title, a few
 * lines of header, and rows of text. What this is *not* is a general PDF writer -
 * there is one font pair, one page size, and no images.
 *
 * The font is the standard Helvetica, which has no Cyrillic. Rather than embed a
 * font (which would mean carrying a megabyte of glyphs so that a class list can
 * be read), text outside Latin-1 is transliterated: a Ukrainian name comes out as
 * its Latin reading rather than as a row of question marks. The CSV and TXT
 * exports keep the original characters; use those when the exact spelling
 * matters.
 */

/** Latin-1 is the font's world; everything else has to be spelled some other way. */
function toLatin1(text: string): string {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code === 0x0a || (code >= 0x20 && code < 0x7f)) {
      out += char
      continue
    }
    if (code >= 0xa0 && code <= 0xff) {
      out += char
      continue
    }
    out += TRANSLIT[char] ?? FOLD[char] ?? '?'
  }
  return out
}

/** Ukrainian and Russian, read as Latin. Enough for a name to stay a name. */
const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z',
  и: 'y', і: 'i', ї: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
  р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'shch', ь: '', ю: 'iu', я: 'ia', ы: 'y', э: 'e', ё: 'e', ъ: '',
  А: 'A', Б: 'B', В: 'V', Г: 'H', Ґ: 'G', Д: 'D', Е: 'E', Є: 'Ye', Ж: 'Zh', З: 'Z',
  И: 'Y', І: 'I', Ї: 'Yi', Й: 'Y', К: 'K', Л: 'L', М: 'M', Н: 'N', О: 'O', П: 'P',
  Р: 'R', С: 'S', Т: 'T', У: 'U', Ф: 'F', Х: 'Kh', Ц: 'Ts', Ч: 'Ch', Ш: 'Sh',
  Щ: 'Shch', Ь: '', Ю: 'Yu', Я: 'Ya', Ы: 'Y', Э: 'E', Ё: 'E', Ъ: '',
}

/** Typographic punctuation that has an obvious plain-text reading. */
const FOLD: Record<string, string> = {
  '\u2018': "'", '\u2019': "'", '\u201c': '"', '\u201d': '"', '\u2013': '-',
  '\u2014': '-', '\u2026': '...', '\u00a0': ' ', '\u2022': '*', '\u00b7': '.',
}

/** Escape a PDF literal string: three characters end it early otherwise. */
function literal(text: string): string {
  return `(${toLatin1(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`
}

/** Growable byte buffer; every byte is written by hand, so offsets are exact. */
class Bytes {
  private readonly buf: number[] = []

  get length(): number {
    return this.buf.length
  }

  push(text: string): void {
    for (const char of toLatin1(text)) this.buf.push(char.codePointAt(0) ?? 0)
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.buf)
  }
}

export interface PdfColumn {
  label: string
  /** Share of the text width, so the caller does not count points. */
  width: number
  align?: 'left' | 'right'
}

export interface PdfTable {
  title: string
  metaLines: string[]
  columns: PdfColumn[]
  rows: string[][]
}

const PAGE_WIDTH = 595
const PAGE_HEIGHT = 842
const MARGIN = 44
const LINE = 14

/**
 * Lay the table out over as many pages as it needs and hand back the bytes.
 *
 * Pagination is the only real work: a class of forty is one page, a class of
 * four hundred is ten, and the header repeats so a page read on its own still
 * says what it is.
 */
export function buildPdf(table: PdfTable): Uint8Array {
  const textWidth = PAGE_WIDTH - MARGIN * 2
  const widths = table.columns.map((column) => (column.width / 100) * textWidth)
  const offsets: number[] = [0]
  for (let index = 1; index < table.columns.length; index += 1) {
    offsets.push(offsets[index - 1]! + widths[index - 1]!)
  }

  const pages: string[] = []
  let content = ''
  let y = MARGIN

  const text = (x: number, size: number, bold: boolean, value: string): void => {
    content += `BT /F${bold ? 2 : 1} ${size} Tf ${x.toFixed(1)} ${(PAGE_HEIGHT - y).toFixed(1)} Td ${literal(value)} Tj ET\n`
  }

  const cell = (index: number, value: string, bold: boolean): void => {
    const column = table.columns[index]!
    // Helvetica's digits are half-em wide; this is close enough for a column.
    const x =
      column.align === 'right'
        ? offsets[index]! + widths[index]! - value.length * 5
        : offsets[index]!
    text(MARGIN + x, 9, bold, value)
  }

  const header = (): void => {
    for (let index = 0; index < table.columns.length; index += 1) {
      cell(index, table.columns[index]!.label, true)
    }
    y += LINE
  }

  const pageBreak = (): void => {
    pages.push(content)
    content = ''
    y = MARGIN
    header()
  }

  text(MARGIN, 16, true, table.title)
  y += 22
  for (const line of table.metaLines) {
    text(MARGIN, 9, false, line)
    y += LINE
  }
  y += 6
  header()

  for (const row of table.rows) {
    if (y > PAGE_HEIGHT - MARGIN - LINE) pageBreak()
    for (let index = 0; index < table.columns.length; index += 1) {
      cell(index, row[index] ?? '', false)
    }
    y += LINE
  }
  if (content !== '') pages.push(content)

  // 1 catalog · 2 pages · 3 font · 4 bold font · then each page and its stream.
  const bodies: string[] = []
  bodies[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  bodies[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  bodies[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'

  const pageIds: number[] = []
  let next = 5
  for (const stream of pages) {
    const contentId = next
    const pageId = next + 1
    next += 2
    bodies[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}endstream`
    bodies[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`
    pageIds.push(pageId)
  }
  bodies[2] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`

  const out = new Bytes()
  out.push('%PDF-1.4\n')
  const start: number[] = []
  for (let index = 1; index < bodies.length; index += 1) {
    start[index] = out.length
    out.push(`${index} 0 obj\n${bodies[index] ?? 'null'}\nendobj\n`)
  }
  const xref = out.length
  out.push(`xref\n0 ${bodies.length}\n0000000000 65535 f \n`)
  for (let index = 1; index < bodies.length; index += 1) {
    out.push(`${String(start[index] ?? 0).padStart(10, '0')} 00000 n \n`)
  }
  out.push(`trailer\n<< /Size ${bodies.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return out.finish()
}

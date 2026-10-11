import { nativeSavePath, nativeWrite } from './desktop'

/** What a session's results can be written as. */
export type ExportFormat = 'csv' | 'txt' | 'pdf'

/** The formats offered in the save dialog; the filter list is the choice. */
const FILTERS = [
  { name: 'CSV', extensions: ['csv'] },
  { name: 'Text', extensions: ['txt'] },
  { name: 'PDF', extensions: ['pdf'] },
]

/** The format a chosen file name asks for; CSV when it says nothing. */
function formatOf(name: string): ExportFormat {
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return extension === 'pdf' || extension === 'txt' ? extension : 'csv'
}

/** The browser's own save dialog, where there is one (Chromium, not WebKit). */
interface SaveHandle {
  name: string
  createWritable: () => Promise<{
    write: (data: Blob) => Promise<void>
    close: () => Promise<void>
  }>
}

type SavePicker = (options: {
  suggestedName?: string
  types?: Array<{ description: string; accept: Record<string, string[]> }>
}) => Promise<SaveHandle>

/**
 * Asks where and in what format, then writes it there.
 *
 * The desktop answers with one system dialog whose filters are the formats, so
 * choosing CSV or PDF and choosing a folder are the same gesture. A browser has
 * no such thing: Chromium's file picker does the same job, and where even that
 * is missing the CSV is handed to the browser and the teacher deals with their
 * own download folder. Returns false when the teacher closed the dialog.
 */
export async function saveExport(
  name: string,
  read: (format: ExportFormat) => Promise<Blob>,
): Promise<boolean> {
  const path = await nativeSavePath({ defaultName: `${name}.csv`, filters: FILTERS })
  if (path !== null) {
    const blob = await read(formatOf(path))
    await nativeWrite(path, new Uint8Array(await blob.arrayBuffer()))
    return true
  }

  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker
  if (picker !== undefined) {
    let handle: SaveHandle
    try {
      handle = await picker({
        suggestedName: `${name}.csv`,
        types: [
          { description: 'CSV', accept: { 'text/csv': ['.csv'] } },
          { description: 'Text', accept: { 'text/plain': ['.txt'] } },
          { description: 'PDF', accept: { 'application/pdf': ['.pdf'] } },
        ],
      })
    } catch (error) {
      // Closing the picker is a decision, not a failure.
      if (error instanceof DOMException && error.name === 'AbortError') return false
      throw error
    }
    const writable = await handle.createWritable()
    await writable.write(await read(formatOf(handle.name)))
    await writable.close()
    return true
  }

  const blob = await read('csv')
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${name}.csv`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return true
}

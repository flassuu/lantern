/** True inside the Tauri webview; false when the same code runs in a browser. */
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * The version of the app.
 *
 * On the desktop this is Tauri's, read from `tauri.conf.json`. In a browser there
 * is no Tauri to ask, so it falls back to the package version the bundle was cut
 * from - the About dialog is the one place a reader goes looking for it, and "we
 * do not know our own version" is the wrong answer to give them.
 */
declare const __APP_VERSION__: string

export function appVersion(): string {
  return __APP_VERSION__
}


export interface SaveFilter {
  name: string
  extensions: string[]
}

/** A browser has no system save dialog of this shape; the caller uses its own. */
export async function nativeSavePath(_input: {
  defaultName: string
  filters: SaveFilter[]
}): Promise<string | null> {
  return null
}

/** Nothing native to write to: the browser path never reaches this. */
export async function nativeWrite(_path: string, _bytes: Uint8Array): Promise<void> {}

import i18n from '../i18n'
import { useToast } from '../composables/toast'
import { isSecureContext } from './secure'

/**
 * Registers the offline shell, and only where it belongs.
 *
 * Five things must be true before a service worker is registered, and each one
 * is a place it would otherwise do harm:
 *
 * - **A production build.** In development the worker would serve yesterday's
 *   build over the dev server, which is the single most confusing thing that can
 *   happen to whoever is editing the file that does not change on screen.
 * - **Not the desktop app.** Tauri's webview has no business caching anything:
 *   the app is on disk, and the server it talks to is on the same machine.
 * - **Not with `?nosw` in the address.** A worker that has gone wrong on a
 *   phone nobody can reach is unkillable from the outside; this is the way out.
 * - **A browser that has them at all.**
 * - **A secure context.** Over plain HTTP on a LAN address the browser refuses
 *   the worker outright; registering anyway only hides that from the reader.
 *
 * A new build taking over is announced rather than applied: reloading the page
 * under a student who is half way through a paper would throw their answers
 * away, and there is no paper in this app worth losing to save a tap.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  if (!isSecureContext()) return
  const globals = window as unknown as Record<string, unknown>
  if ('__TAURI__' in globals || '__TAURI_INTERNALS__' in globals) return

  if (new URLSearchParams(window.location.search).has('nosw')) {
    void navigator.serviceWorker
      .getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .catch(() => undefined)
    return
  }

  // On a first visit the worker claims the page, which is not an update. Only a
  // page that already had one is being replaced.
  const hadController = navigator.serviceWorker.controller !== null
  let announced = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || announced) return
    announced = true
    useToast().info(i18n.global.t('common.newVersion'))
  })

  void navigator.serviceWorker.register('./sw.js').catch(() => {
    // Not fatal and not shouted about: everything works without a worker, it
    // just does not work with the network gone.
  })
}

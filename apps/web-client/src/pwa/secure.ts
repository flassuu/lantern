/**
 * Whether this page is a secure context.
 *
 * A browser installs a web app and runs a service worker for it only on https,
 * or on localhost. A classroom server is reached by its LAN address over plain
 * HTTP - `http://192.168.1.65:3300` - which is precisely the case that is not
 * secure, so the client has to say why the offline copy is missing rather than
 * leave a student to wonder why the app never offers to install itself.
 *
 * See docs/https.md for the two ways to get a certificate a phone will trust.
 */
export function isSecureContext(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext === true
}

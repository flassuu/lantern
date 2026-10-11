import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

/**
 * The service worker's policy, which is the half of it that can be wrong in a way
 * nobody notices for a week.
 *
 * `public/sw.js` is a classic script rather than a module, so its rules are
 * published on the global object and this file imports it for the side effect.
 * The registration half is behind a `self` guard that is false here, which is what
 * makes that safe: importing a service worker in Node defines functions and starts
 * nothing.
 *
 * What these tests are really about is what must *never* be cached. A cache that
 * swallows a POST turns a second submit into a lie, and a cache that answers for
 * another origin is a cache that hands a phone somebody else's page.
 */
interface SwPolicy {
  CACHE_PREFIX: string
  SHELL: string[]
  fingerprint(text: string): string
  decide(request: { method: string; url: string; mode: string }, origin: string): string
}

function policy(): SwPolicy {
  return (globalThis as unknown as { LanternSwPolicy: SwPolicy }).LanternSwPolicy
}

function request(method: string, url: string, mode = 'same-origin'): { method: string; url: string; mode: string } {
  return { method, url, mode }
}

const SITE = 'http://10.11.12.13:3300'

before(async () => {
  await import('../public/sw.js')
})

describe('the offline shell decides what to do with a request', () => {
  it('sends navigations to the network, with the shell as the fallback', () => {
    assert.equal(policy().decide(request('GET', `${SITE}/?check=1`, 'navigate'), SITE), 'navigation')
  })

  it('treats the API as network-first, so a screen is fresh when the server is up', () => {
    assert.equal(policy().decide(request('GET', `${SITE}/api/courses`), SITE), 'network-first')
    assert.equal(policy().decide(request('GET', `${SITE}/api/health`), SITE), 'network-first')
  })

  it('treats the build as cache-first: a hashed asset is always the right bytes', () => {
    assert.equal(policy().decide(request('GET', `${SITE}/assets/index-abc123.js`), SITE), 'cache-first')
    assert.equal(policy().decide(request('GET', `${SITE}/icon-192.png`), SITE), 'cache-first')
  })

  it('never touches a write', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(
        policy().decide(request(method, `${SITE}/api/sessions/join`), SITE),
        'passthrough',
        method,
      )
    }
  })

  it('never answers for another origin', () => {
    assert.equal(policy().decide(request('GET', 'https://example.com/thing.js'), SITE), 'passthrough')
  })

  it('does not mistake a path that merely starts with the same letters', () => {
    // `/apiary` is not `/api`, and a `startsWith('/api')` would have said it was.
    assert.equal(policy().decide(request('GET', `${SITE}/apiary`), SITE), 'cache-first')
  })
})

describe('the cache is named after the build, not after a number somebody types', () => {
  it('gives the same name for the same shell twice', () => {
    assert.equal(policy().fingerprint('<html>one</html>'), policy().fingerprint('<html>one</html>'))
  })

  it('gives a different name when the shell changes', () => {
    assert.notEqual(policy().fingerprint('<html>one</html>'), policy().fingerprint('<html>two</html>'))
  })

  it('is short enough to be a cache name and safe in one', () => {
    const name = policy().CACHE_PREFIX + policy().fingerprint('<html></html>')
    assert.match(name, /^lantern-[a-z0-9]+$/)
  })

  it('precaches the shell, and nothing that has to be fetched first', () => {
    assert.deepEqual(policy().SHELL, ['./', './manifest.webmanifest'])
  })
})

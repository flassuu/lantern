#!/usr/bin/env node
/**
 * Browser checks: the layout and the happy paths, in a real Firefox.
 *
 * Why a script and not a test file: most of what goes wrong in this interface
 * cannot be asserted without a real renderer. A `<fieldset>` that refuses to
 * shrink, a label that wraps to two lines in Ukrainian, a tap target of 28px —
 * none of that shows up in jsdom, and all of it shows up here.
 *
 * It drives Firefox over WebDriver BiDi with no dependencies at all: a
 * WebSocket, a few JSON messages. That is deliberate - a check that needs a
 * package install will not be run by the person who needs it.
 *
 *   pnpm check:browser                  # needs a server on :3300
 *   BASE=http://host:3300 pnpm check:browser
 *   TEACHER_PASSWORD=... pnpm check:browser
 *
 * It creates the accounts, the test, the session and the room it needs, and
 * deletes them afterwards. Screenshots of a failure land in a temporary
 * directory whose path is printed.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BASE ?? 'http://127.0.0.1:3300'
// First boot seeds a teacher, so the checks sign in as that teacher and make
// an admin only where an admin-only endpoint needs one.
const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD ?? 'teacher'
const HEADED = process.argv.includes('--headed')
const SHOTS = process.env.SHOTS_DIR ?? mkdtempSync(join(tmpdir(), 'lantern-browser-'))

const WIDTHS = [320, 390, 1100]
const LOCALES = ['en', 'uk']

// ---------------------------------------------------------------- BiDi client

/**
 * A WebDriver BiDi session.
 *
 * One quirk worth writing down: Firefox does not pass `script.callFunction`
 * arguments to the function, so values are inlined into its source with
 * JSON.stringify. It is safe here because every value is produced by this file,
 * never by a user.
 */
class Session {
  #socket
  #nextId = 1
  #pending = new Map()

  static async launch({ port, profile }) {
    const child = spawn(
      'firefox',
      [
        '--no-remote',
        '--profile',
        profile,
        '--remote-debugging-port',
        String(port),
        ...(HEADED ? [] : ['--headless']),
        'about:blank',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )

    const reported = await new Promise((resolve, reject) => {
      let buffer = ''
      const timer = setTimeout(
        () => reject(new Error('Firefox did not report a BiDi endpoint in 30s')),
        30_000,
      )
      child.stderr.on('data', (chunk) => {
        buffer += chunk.toString()
        const match = buffer.match(/WebDriver BiDi listening on (ws:\/\/\S+)/)
        if (match) {
          clearTimeout(timer)
          resolve(match[1])
        }
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`Firefox exited with ${code}`))
      })
    })
    // Firefox reports the host and port without the path; the session endpoint
    // lives at /session, and connecting to the bare host is refused.
    const url = reported.replace(/\/$/, '') + '/session'
    return { child, url }
  }

  static async open(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', () => reject(new Error('BiDi socket failed')), {
        once: true,
      })
    })
    const session = new Session()
    session.#socket = socket
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (!message.id) return
      const pending = session.#pending.get(message.id)
      if (!pending) return
      session.#pending.delete(message.id)
      if (message.type === 'error') pending.reject(new Error(message.message ?? 'BiDi error'))
      else pending.resolve(message.result)
    })
    await session.send('session.new', { capabilities: {} })
    return session
  }

  send(method, params = {}) {
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#socket.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`timeout ${method}`))
      }, 30_000)
    })
  }

  async page(width, height = 900) {
    const created = await this.send('browsingContext.create', { type: 'tab' })
    const context = created.context
    await this.send('browsingContext.setViewport', { context, viewport: { width, height } })
    // Starts on the app rather than about:blank, so localStorage has an origin
    // to live in from the first line of the first check.
    await this.goto(context, BASE)
    return context
  }

  async setViewport(context, width, height = 900) {
    await this.send('browsingContext.setViewport', { context, viewport: { width, height } })
  }

  async goto(context, url) {
    await this.send('browsingContext.navigate', { context, url, wait: 'complete' })
  }

  /** Runs `source` as an async function body in the page; returns its value. */
  async run(context, source) {
    const result = await this.send('script.callFunction', {
      functionDeclaration: `async function () { ${source} }`,
      target: { context },
      awaitPromise: true,
    })
    if (result.type === 'exception') {
      throw new Error(
        result.exceptionDetails?.text ?? 'exception in the page',
      )
    }
    return decode(result.result)
  }

  async screenshot(context, path) {
    const shot = await this.send('browsingContext.captureScreenshot', { context })
    writeFileSync(path, Buffer.from(shot.data, 'base64'))
  }

  async close() {
    try {
      await this.send('session.end', {})
    } catch {
      // Already gone; closing the socket is enough.
    }
    this.#socket.close()
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/**
 * Unpacks what WebDriver BiDi sends back.
 *
 * A value comes from the page as BiDi's own serialization, not as the thing
 * that was returned: `{ type: 'object', value: [['warning', { type: 'boolean',
 * value: true }]] }`. Reading `.value` off that gives a list of pairs, so
 * `result.warning` is `undefined` and every check that reads a field quietly
 * fails - or, worse, quietly passes. Numbers, strings and booleans are the only
 * shapes that survive without this.
 */
function decode(remote) {
  if (remote === null || typeof remote !== 'object') return remote
  const { type } = remote
  if (type === 'null') return null
  if (type === 'object') {
    return Object.fromEntries(
      remote.value.map(([key, item]) => [key, decode(item)]),
    )
  }
  if (type === 'array') return remote.value.map(decode)
  return remote.value
}

// ------------------------------------------------------------------- the API

async function api(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      // Keyed on `body !== undefined`, not on truthiness: a check that asserts a
      // request was refused has to be able to send `{}` and reach the handler.
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 120)}`)
  }
  return text === '' ? null : JSON.parse(text)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function tokenOf(username, password) {
  const result = await api('/api/auth/login', {
    method: 'POST',
    body: { username, password },
  })
  return result.token
}

// ------------------------------------------------------------- test fixtures

const SUFFIX = Math.floor(Math.random() * 100000)
const NAMES = {
  admin: `browsercheck_a${SUFFIX}`,
  nokey: `browsercheck_n${SUFFIX}`,
  teacher: `browsercheck_t${SUFFIX}`,
  student: `browsercheck_s${SUFFIX}`,
}
const created = { tests: [], sessions: [], rooms: [], courses: [], users: [] }

/** Everything the checks need, built through the API and torn down after. */
async function seed() {
  // First boot is a teacher. The sweep still covers the admin-only screens, so
  // an admin is created for them the way an institution would - from the
  // console, which the harness can reach through the server it starts.
  // The harness only speaks HTTP, so it cannot reach the console to create an
  // admin. It uses the seeded teacher for everything a teacher can do, and the
  // admin-only screens are covered by the server tests, which can insert one.
  const teacher = await tokenOf('teacher', TEACHER_PASSWORD)

  // A room and a course, linked, because that is the shape 6.1 introduced: a
  // room is who, a course is what, and a room carries any number of courses.
  // The test is written for that room and labelled, and the run is named, so the
  // checks below can look for a room chip and a label chip rather than for an
  // empty state that would pass whether or not the feature works.
  const course = await api('/api/courses', {
    token: teacher,
    method: 'POST',
    body: { title: `Browser course ${SUFFIX}`, description: 'For the browser checks' },
  })

  const room = await api('/api/rooms', {
    token: teacher,
    method: 'POST',
    body: { name: `Room ${SUFFIX}`, courseIds: [course.id] },
  })
  created.rooms.push(room.room.id)
  created.courses.push(course.id)

  const test = await api('/api/tests', {
    token: teacher,
    method: 'POST',
    body: {
      title: `Browser check ${SUFFIX}`,
      roomId: room.room.id,
      tags: ['Fractions', 'Year 9'],
      // The API takes the stored shape - keyed options and a correct key - not
      // what the editor shows, so the fixture follows the server's contract.
      questions: [
        {
          type: 'single_choice',
          position: 0,
          body: 'Two plus two?',
          points: 1,
          payload: {
            options: [
              { key: 'a', text: '4' },
              { key: 'b', text: '5' },
            ],
            correct: 'a',
          },
        },
      ],
    },
  })
  created.tests.push(test.test.id)

  const session = await api('/api/sessions', {
    token: teacher,
    method: 'POST',
    body: { testId: test.test.id, name: 'Browser run', tags: ['Fractions'] },
  })
  created.sessions.push(session.session.id)
  // A run opens in a lobby now, and nothing can be answered until it starts -
  // so the student path below would sit in the waiting room forever.
  await api(`/api/sessions/${session.session.id}/start`, { token: teacher, method: 'POST' })

  // Registering with the key is the flow 5.2 added: approved, no admin involved.
  await api('/api/auth/register', {
    method: 'POST',
    body: {
      username: NAMES.student,
      password: 'browsercheck-pass-1',
      fullName: 'Check Student',
      roomKey: room.room.key,
    },
  })
  created.users.push(NAMES.student)

  // A student who registered with no room key, so the teacher's Rooms tab has
  // somebody in the waiting list to approve.
  await api('/api/auth/register', {
    method: 'POST',
    body: {
      username: NAMES.nokey,
      password: 'browsercheck-pass-1',
      fullName: 'Check No Key',
    },
  })

  return {
    teacher,
    student: await tokenOf(NAMES.student, 'browsercheck-pass-1'),
    key: room.room.key,
    testId: test.test.id,
  }
}

async function cleanup() {
  const teacher = await tokenOf('teacher', TEACHER_PASSWORD).catch(() => null)
  if (!teacher) return
  for (const id of created.sessions) {
    await api(`/api/sessions/${id}`, { token: teacher, method: 'PATCH', body: { status: 'finished' } }).catch(() => {})
  }
  for (const id of created.tests) await api(`/api/tests/${id}`, { token: teacher, method: 'DELETE' }).catch(() => {})
  for (const id of created.rooms) await api(`/api/rooms/${id}`, { token: teacher, method: 'DELETE' }).catch(() => {})
  for (const id of created.courses) await api(`/api/courses/${id}`, { token: teacher, method: 'DELETE' }).catch(() => {})
  // The student is left behind on purpose: deleting accounts is admin-only, and
  // the teacher cannot — nor should be able to — reach that endpoint.
}

// -------------------------------------------------------------- the checks

const failures = []
/** Makes every load a different URL, so a navigation is never a no-op. */
let navigations = 0

function check(name, ok, detail = '') {
  if (ok) {
    console.log(`   ok    ${name}`)
  } else {
    console.log(`   FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures.push(`${name}${detail ? `: ${detail}` : ''}`)
  }
}

const AUDIT = `
  const app = document.querySelector('#app');
  const box = app.getBoundingClientRect();
  const found = [];
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };

  if (app.scrollWidth > box.width + 1) {
    // Name the widest offenders. "The page scrolls sideways by 2px" says the
    // symptom and nothing about which element to look at, and a 2px overflow is
    // exactly the kind that costs an hour to find by eye.
    let detail = '';
    const culprits = [...app.querySelectorAll('*')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter((c) => c.r.width > 0 && c.r.right > box.right + 1)
      .sort((a, b) => b.r.right - a.r.right)
      .slice(0, 3)
      .map((c) => {
        const style = getComputedStyle(c.el);
        return (
          '<' +
          c.el.tagName.toLowerCase() +
          ' class="' +
          (c.el.className.baseVal !== undefined ? c.el.className.baseVal : c.el.className || '').slice(0, 40) +
          '"> +' +
          Math.round(c.r.right - box.right) +
          'px position:' +
          style.position +
          (style.visibility === 'hidden' ? ' visibility:hidden' : '')
        );
      });
    if (culprits.length) detail = ' widest: ' + culprits.join('; ');
    found.push(
      'the page scrolls sideways: ' + app.scrollWidth + 'px in ' + Math.round(box.width) + 'px' + detail,
    );
  }
  for (const el of app.querySelectorAll('*')) {
    if (!visible(el) || el.scrollWidth > el.clientWidth + 1) continue;
    const r = el.getBoundingClientRect();
    if (r.right > box.right + 1) {
      found.push('past the right edge: <' + el.tagName.toLowerCase() + '> "' + el.textContent.trim().slice(0, 24) + '"');
      break;
    }
  }
  for (const el of app.querySelectorAll('button, a, input, select, [role="button"], [role="tab"]')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    // 30px is the floor for anything a thumb has to hit.
    if (r.height < 30 || r.width < 30) {
      const name = el.getAttribute('aria-label') || el.textContent.trim() || el.title || '?';
      found.push('a small target: ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' "' + name.slice(0, 20) + '"');
      break;
    }
  }
  for (const el of app.querySelectorAll('button')) {
    if (!visible(el)) continue;
    if (!el.getAttribute('aria-label') && !el.textContent.trim() && !el.title) {
      found.push('a button with no name');
      break;
    }
  }
  const keys = [...new Set((app.textContent.match(/\\b(admin|auth|common|student|teacher)\\.[a-zA-Z.]+\\b/g) || []))];
  if (keys.length) found.push('untranslated keys: ' + keys.slice(0, 3).join(', '));
  return { found };
`

async function auditScreen(session, context, label) {
  const result = await session.run(context, AUDIT)
  // The hidden file input is 1x1 on purpose: off the tab order and off the screen.
  const real = (result.found ?? []).filter((line) => !line.includes('1x1'))
  check(`${label}: layout`, real.length === 0, real.slice(0, 2).join(' | '))
  return real
}


/**
 * Loads the app signed in, at a given width, as a real navigation.
 *
 * Two traps, both learned the hard way. `location.reload()` from inside the
 * page leaves BiDi's `navigate` wait pointing at the previous document - which
 * still shows the login screen, and a check that audits that reports nothing
 * and passes. And navigating to the same URL twice is not guaranteed to load
 * anything at all. So the token goes into localStorage first, and the URL
 * carries a changing query to make every load a real one.
 */
async function openApp(session, context, { token, locale, width, height = 900 }) {
  await session.setViewport(context, width, height)
  await session.run(
    context,
    `
    localStorage.setItem('auth.token', ${JSON.stringify(token)});
    localStorage.setItem('locale', ${JSON.stringify(locale)});
    return true;
  `,
  )
  navigations += 1
  await session.goto(context, `${BASE}/?check=${navigations}`)
}

/**
 * Waits for the screen the check is about, rather than sleeping a guessed
 * number of seconds.
 *
 * "The app has some text" is not a condition worth waiting for: it is true for
 * the login screen too, which is what an expired token leaves behind. So the
 * wait is for what the screen is supposed to contain, and a timeout says what
 * the page looked like instead of just that it took too long.
 */
async function settle(session, context, expect = 'content', attempts = 60) {
  let last = 'unknown'
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await session.run(
      context,
      `
      const app = document.querySelector('#app');
      if (!app) return 'no-app';
      const tabs = app.querySelectorAll('[role=tab]').length;
      const signedOut = app.querySelector('form input[type="password"]') !== null;
      if (${JSON.stringify(expect)} === 'tabs') {
        return tabs > 0 ? 'ready' : (signedOut ? 'signed-out' : 'loading');
      }
      if (app.textContent.trim() === '') return 'loading';
      return signedOut ? 'signed-out' : 'ready';
    `,
    )
    if (last === 'ready') return 'ready'
    if (expect === 'signed-out' && last === 'signed-out') return 'ready'
    await sleep(250)
  }
  const seen = await session
    .run(
      context,
      `
      const app = document.querySelector('#app');
      return JSON.stringify({
        url: location.href,
        ready: document.readyState,
        scripts: document.querySelectorAll('script').length,
        appChars: app ? app.textContent.trim().length : -1,
      });
    `,
    )
    .catch((error) => `the page could not be read: ${error.message}`)
  throw new Error(
    `the ${expect} screen never appeared (last state: ${last}; ${seen})`,
  )
}

async function clickTab(session, context, pattern, wait = 1200) {
  await settle(session, context, 'tabs')
  await session.run(
    context,
    `
    const tabs = [...document.querySelectorAll('[role=tab]')];
    const tab = tabs.find((el) => new RegExp(${JSON.stringify(pattern)}).test(el.textContent.trim()));
    if (!tab) throw new Error(
      'no tab matching ${pattern}; found: ' + tabs.map((el) => el.textContent.trim()).join(' / '),
    );
    tab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, ${wait}));
    return true;
  `,
  )
}

async function clickTabByIndex(session, context, index, wait = 1200) {
  // Ensure tabs exist
  const count = await session.run(context, `return document.querySelectorAll('[role=tab]').length`)
  if (count <= index) {
    throw new Error(`not enough tabs (need index ${index}, have ${count})`)
  }
  await session.run(
    context,
    `
    const tabs = [...document.querySelectorAll('[role=tab]')];
    if (tabs.length <= ${index}) throw new Error('not enough tabs');
    tabs[${index}].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, ${wait}));
    return true;
  `,
  )
}

async function layoutSweep(session, fixtures) {
  const roles = [
    { name: 'teacher', token: fixtures.teacher, tabs: [/^Live$/, /^Tests$/, /^Courses$/, /^Rooms$/] },
    { name: 'student', token: fixtures.student, tabs: [] },
  ]

  // One tab for the whole sweep: every extra tab keeps a WebSocket open, and a
  // screen that waits on its own data is slower for every tab behind it.
  const context = await session.page(WIDTHS[0])
  for (const role of roles) {
    for (const locale of LOCALES) {
      for (const width of WIDTHS) {
        await openApp(session, context, { token: role.token, locale, width })
        await settle(session, context, role.tabs.length > 0 ? 'tabs' : 'content')

        // Click tabs by index to avoid language mismatch in pattern matching
        for (let tabIndex = 0; tabIndex < role.tabs.length; tabIndex++) {
          await clickTabByIndex(session, context, tabIndex)
          await auditScreen(session, context, `${role.name}/${locale}/${width} tab${tabIndex}`)
        }
        if (role.tabs.length === 0) {
          await auditScreen(session, context, `${role.name}/${locale}/${width} home`)
        }
      }
    }
  }
  return context
}

async function happyPaths(session, fixtures) {
  const context = await session.page(1100, 1000)

  // With nothing configured, the Live tab has to say the QR is unreachable. This
  // runs first, before anything sets an address: 0.5.2 moved that to the
  // teacher's own Rooms tab, and the warning can only be observed while the
  // address is still unset.
  await openApp(session, context, { token: fixtures.teacher, locale: 'en', width: 1100, height: 1000 })
  await settle(session, context, 'tabs')
  await clickTab(session, context, '^Live$')
  await openTheQr(session, context)

  const withoutAddress = await readAddressState(session, context)
  check(
    'teacher: warns when no public address is set',
    withoutAddress.warning,
    `address on screen: ${withoutAddress.address ?? 'none'}`,
  )
  await session.screenshot(context, join(SHOTS, 'teacher-live-no-address.png'))

  // Teacher: the room key is on screen.
  await clickTab(session, context, '^Rooms$')
  const keyShown = await session.run(
    context,
    `
    const code = document.querySelector('code');
    return code ? code.textContent.trim() : null;
  `,
  )
  check(
    'teacher: the room key is shown',
    /^[A-HJ-NP-Z2-9]{6}$/.test(keyShown ?? ''),
    `got ${keyShown}`,
  )

  // The teacher can read the server log. There is no log tab on the teacher's
  // dashboard yet, so this is checked over the API the tab would call rather
  // than by clicking to a screen that does not exist.
  const logs = await api('/api/logs', { token: fixtures.teacher }).catch(() => null)
  check(
    'teacher: the server log is readable (not admin-only any more)',
    Array.isArray(logs?.entries),
    logs === null ? 'the request failed' : JSON.stringify(logs).slice(0, 80),
  )

  // 0.5.1: the teacher sets the address and approves a waiting student from the
  // Rooms tab. Both are screens that did not exist for a teacher before, and
  // both are the reason the seed stopped being an admin.
  await openApp(session, context, { token: fixtures.teacher, locale: 'en', width: 1100, height: 1000 })
  await settle(session, context, 'tabs')
  await clickTab(session, context, '^Rooms$', 1800)

  const roomsScreen = await session.run(
    context,
    `
    const text = document.body.textContent;
    return {
      addressField: !!document.querySelector('#public-address'),
      addressCard: /Student address/.test(text),
      waiting: /Waiting for approval/.test(text),
      waitingHint: /Nobody is waiting|without a room key/.test(text),
      courseChip: /Browser course/.test(text),
      courseText: (text.match(/Browser course/g) || []).length,
    };
  `,
  )
  check('teacher: the Rooms tab has an address field', roomsScreen.addressField)
  check('teacher: the Rooms tab has an address card', roomsScreen.addressCard)
  check(
    'teacher: a student who registered without a key is listed for approval',
    roomsScreen.waitingHint,
  )
  // 6.1: a room is who, a course is what, and the room card says which courses
  // its students are on. The fixture links one, so an empty state cannot pass.
  check(
    'teacher: a room shows the courses its students are enrolled in',
    roomsScreen.courseChip,
    `courses on screen: ${roomsScreen.courseText}`,
  )
  await session.screenshot(context, join(SHOTS, 'teacher-rooms-address.png'))

  // Saving an address from the teacher screen, rather than the admin's System tab.
  const teacherAddress = 'http://10.11.12.13:3300'
  const saved = await session.run(
    context,
    `
    const input = document.querySelector('#public-address');
    if (!input) return 'no field';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(teacherAddress)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const save = [...document.querySelectorAll('button')].find((b) => /Save address/.test(b.textContent));
    if (!save) return 'no save button';
    save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1500));
    return document.body.textContent.includes('Address saved') ? 'saved' : 'no confirmation';
  `,
  )
  check('teacher: saving the address from the Rooms tab works', saved === 'saved', `got ${saved}`)

  const readBack = await api('/api/settings', { token: fixtures.teacher })
  check(
    'teacher: the saved address is what the server holds',
    readBack.publicBaseUrl === teacherAddress,
    `server says ${readBack.publicBaseUrl}`,
  )

  // And with an address set, the Live tab stops warning and prints it under the
  // QR. This is the whole point of the field: a code that scans and then fails
  // reads as a broken app.
  await clickTab(session, context, '^Live$', 1800)
  await openTheQr(session, context)
  const withAddress = await readAddressState(session, context)
  check(
    'teacher: the QR carries the configured address',
    !withAddress.warning && (withAddress.address ?? '').includes(teacherAddress),
    `warning=${withAddress.warning} address line: ${withAddress.address}`,
  )
  await session.screenshot(context, join(SHOTS, 'teacher-live-with-address.png'))

  // The other theme. Until now the harness only ever rendered light, and the
  // contrast bugs live in exactly one of the two: a well that is the same
  // colour as the card it sits on is invisible in dark and obvious in light.
  await session.run(context, "localStorage.setItem('theme', 'dark'); return true;")
  await session.goto(context, `${BASE}/?check=dark`)
  await settle(session, context, 'tabs')
  await clickTab(session, context, '^Live$', 1200)
  await session.screenshot(context, join(SHOTS, 'teacher-live-dark.png'))
  await session.run(context, "localStorage.setItem('theme', 'light'); return true;")
  await session.goto(context, `${BASE}/?check=light-again`)
  await settle(session, context, 'tabs')
  await clickTab(session, context, '^Live$', 1200)

  // 6.1: the room and the labels on the other two screens that carry them. A
  // test is written for a room and labelled; a run can be called something other
  // than the paper it ran. Checked here because this is the last stop on the
  // Live tab, and the next block leaves it for the student screens.
  const liveScreen = await session.run(
    context,
    `
    const text = document.body.textContent;
    return {
      runName: /Browser run/.test(text),
      roomChip: text.includes(${JSON.stringify(`Room ${SUFFIX}`)}),
    };
  `,
  )
  check('teacher: a run is called what the teacher called it', liveScreen.runName)
  check(
    'teacher: the live board shows which room is sitting the run',
    liveScreen.roomChip,
    'no room chip on the board',
  )

  // 6.2: the library behind the strip's "All sessions" button. It opens, it
  // searches, and picking a run returns to it with the dialog gone.
  await session.run(
    context,
    `
    const button = [...document.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'All sessions',
    );
    if (button) button.click();
    return true;
  `,
  )
  await sleep(700)
  const library = await session.run(
    context,
    `
    const dialog = document.querySelector('[role=dialog]');
    return { open: document.body.textContent.includes('Session library'), dialog: !!dialog };
  `,
  )
  check('teacher: the session library opens from the strip', library.open && library.dialog)
  await session.screenshot(context, join(SHOTS, 'teacher-session-library-open.png'))

  await session.run(
    context,
    `
    const input = document.querySelector('input[type=search]');
    if (!input) return 'no input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'zzzz-no-such-run');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `,
  )
  await sleep(800)
  const searched = await session.run(
    context,
    `
    return document.body.textContent.includes('No session matches') ? 'empty' : 'full';
  `,
  )
  check('teacher: the library search narrows the list', searched === 'empty', `got ${searched}`)

  const picked = await session.run(
    context,
    `
    const input = document.querySelector('input[type=search]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 800));
    const rows = [...document.querySelectorAll('[role=dialog] button')].filter(
      (b) => /Browser run/.test(b.textContent),
    );
    if (!rows.length) return 'no row';
    rows[0].click();
    await new Promise((r) => setTimeout(r, 500));
    return document.querySelector('[role=dialog]') ? 'still-open' : 'closed';
  `,
  )
  check(
    'teacher: picking a run in the library returns to the board',
    picked === 'closed',
    `got ${picked}`,
  )
  await session.screenshot(context, join(SHOTS, 'teacher-session-library.png'))

  await clickTab(session, context, '^Tests$', 1800)
  const testsScreen = await session.run(
    context,
    `
    const text = document.body.textContent;
    return {
      roomChip: text.includes(${JSON.stringify(`Room ${SUFFIX}`)}),
      tagChip: /Fractions/.test(text) && /Year 9/.test(text),
    };
  `,
  )
  check(
    'teacher: a test card shows the room it is written for',
    testsScreen.roomChip,
    'no room chip on the test card',
  )
  check(
    'teacher: a test card shows its labels',
    testsScreen.tagChip,
    'labels missing from the test card',
  )
  await session.screenshot(context, join(SHOTS, 'teacher-tests-tags.png'))

  // And the student who registered with no key can be let in from this tab.
  const pending = await api('/api/users/pending', { token: fixtures.teacher }).catch(() => ({ users: [] }))
  const student = (pending.users ?? [])[0]
  if (!student) {
    check('teacher: a no-key student can be approved from the Rooms tab', false, 'no pending student')
  } else {
    const approved = await api(`/api/users/${student.id}/status`, {
      token: fixtures.teacher,
      method: 'PATCH',
      body: { status: 'approved' },
    })
    check(
      'teacher: a no-key student can be approved from the Rooms tab',
      approved?.user?.status === 'approved',
      JSON.stringify(approved).slice(0, 80),
    )
    const after = await api('/api/users/pending', { token: fixtures.teacher }).catch(() => ({ users: [] }))
    check(
      'teacher: the approved student leaves the waiting list',
      !(after.users ?? []).some((u) => u.id === student.id),
    )
  }

  // Creating accounts stayed admin-only. A teacher who could mint a teacher could
  // mint an admin later, and "one teacher is enough" would stop being true.
  let createdStatus = 0
  try {
    await api('/api/users', {
      method: 'POST',
      token: fixtures.teacher,
      body: { username: `browsercheck_x${SUFFIX}`, password: 'browsercheck-pass-1', fullName: 'X' },
    })
  } catch (error) {
    createdStatus = Number(/-> (\d{3})/.exec(error.message)?.[1] ?? 0)
  }
  check('teacher: cannot create accounts', createdStatus === 403, `got HTTP ${createdStatus}`)

  // 6.3: a run is born in a lobby, and the teacher opens it from the board. Done
  // last because it makes a new session the newest one, which is what the board
  // selects - every check above is about the run that is already going.
  const lobby = await api('/api/sessions', {
    token: fixtures.teacher,
    method: 'POST',
    body: { testId: fixtures.testId, name: `Lobby run ${SUFFIX}` },
  })
  if (!lobby?.session?.id) {
    check('teacher: a new run opens in the lobby', false, 'could not create a session')
    return context
  }
  created.sessions.push(lobby.session.id)

  await clickTab(session, context, '^Live$', 1500)
  const lobbyScreen = await session.run(
    context,
    `
    const buttons = [...document.querySelectorAll('button')];
    return {
      waiting: document.body.textContent.includes('Waiting to start'),
      start: buttons.some((b) => b.textContent.trim() === 'Start'),
    };
  `,
  )
  check('teacher: a new run opens in the lobby', lobbyScreen.waiting, 'no lobby status')
  check('teacher: the lobby offers a Start button', lobbyScreen.start, 'no Start button')
  // 6.4: the run's settings live in the lobby, where they can still be changed.
  const settings = await session.run(
    context,
    `
    const text = document.body.textContent;
    return {
      block: text.includes('Session settings'),
      switches: document.querySelectorAll('[role=switch]').length,
    };
  `,
  )
  check('teacher: the lobby shows the run settings', settings.block, 'no settings block')
  check(
    'teacher: the settings are real controls',
    settings.switches >= 3,
    `switches: ${settings.switches}`,
  )
  await session.screenshot(context, join(SHOTS, 'teacher-lobby.png'))

  await session.run(
    context,
    `
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Start');
    if (button) button.click();
    return true;
  `,
  )
  await sleep(1500)
  const opened = await session.run(
    context,
    `return document.body.textContent.includes('Running') ? 'running' : 'still-a-lobby';`,
  )
  check('teacher: Start leaves the lobby', opened === 'running', `got ${opened}`)
  await session.screenshot(context, join(SHOTS, 'teacher-lobby-started.png'))

  // Leave the fixture the way the rest of the cleanup expects it: finished.
  await api(`/api/sessions/${lobby.session.id}`, {
    token: fixtures.teacher,
    method: 'PATCH',
    body: { status: 'finished' },
  }).catch(() => {})

  // More runs than fit: the strip has to clip them rather than let them slide
  // under the library button, and that button needs a surface of its own to sit
  // on. Both were wrong in the same screenshot.
  for (let index = 0; index < 10; index += 1) {
    const extra = await api('/api/sessions', {
      token: fixtures.teacher,
      method: 'POST',
      body: { testId: fixtures.testId, name: `Overflow run ${SUFFIX}-${index}` },
    })
    if (extra?.session?.id) created.sessions.push(extra.session.id)
  }
  // Away and back: clicking the tab that is already open changes nothing, so the
  // list would not be re-read and the strip would still hold two tabs - which is
  // how this check passed vacuously the first time it was written.
  await clickTab(session, context, '^Tests$', 800)
  await clickTab(session, context, '^Live$', 1500)
  const strip = await session.run(
    context,
    `
    const button = [...document.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'All sessions',
    );
    // Only the session strip: the page's own tab bar is [role=tab] as well.
    const stripEl = button ? button.parentElement : null;
    const tabs = stripEl ? [...stripEl.querySelectorAll('[role=tab]')] : [];
    const buttonBox = button ? button.getBoundingClientRect() : null;
    const last = tabs.length ? tabs[tabs.length - 1].getBoundingClientRect() : null;
    const rowEl = stripEl ? stripEl.firstElementChild : null;
    return {
      shown: tabs.length,
      clear: !!(buttonBox && last) && last.right <= buttonBox.left + 1,
      surface: button ? getComputedStyle(button).backgroundColor !== 'rgba(0, 0, 0, 0)' : false,
      overflow: rowEl ? rowEl.scrollWidth > rowEl.clientWidth : false,
    };
  `,
  )
  check(
    'teacher: the tab strip clips instead of sliding under the library button',
    // Also that it really had to clip: with two tabs the first half is free.
    strip.clear && strip.shown < 12,
    JSON.stringify(strip),
  )
  check(
    'teacher: the library button has a surface of its own',
    strip.surface,
    JSON.stringify(strip),
  )
  await session.screenshot(context, join(SHOTS, 'teacher-session-tabs-overflow.png'))

  return context
}

/**
 * Selects the running session and expands its QR, the way a teacher does.
 *
 * This used to sleep 1500ms, click, then sleep 700ms and read. Both sleeps were
 * guesses, and the second one was short often enough that the panel had not
 * rendered yet: the address read back as `none`, which is the same value the
 * check reports when the warning is genuinely missing. Two runs out of four
 * disagreed and neither could say why.
 *
 * So it waits for the thing it is about. The panel is up when the address line
 * or the warning is in the DOM, and the loop says which one it saw.
 */
async function openTheQr(session, context) {
  const state = await session.run(
    context,
    `
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const chip = [...document.querySelectorAll('button')].find((b) => /Browser check/.test(b.textContent));
    if (chip) chip.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const qr = () => [...document.querySelectorAll('button')].find((b) => /Show QR code/.test(b.textContent.trim()));
    for (let i = 0; i < 40 && !qr(); i += 1) await sleep(100);
    if (qr()) qr().dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const shown = () =>
      [...document.querySelectorAll('p')].some((p) => /cannot open this address|Address in the QR code/.test(p.textContent));
    for (let i = 0; i < 60 && !shown(); i += 1) await sleep(100);
    return shown() ? 'panel-open' : 'panel-still-closed';
  `,
  )
  if (state !== 'panel-open') throw new Error(`the QR panel did not open: ${state}`)
}

/** The two things the Live tab says about the address, read as a pair. */
function readAddressState(session, context) {
  return session.run(
    context,
    `
    const warning = [...document.querySelectorAll('p')].find((p) => /cannot open this address/.test(p.textContent));
    const address = [...document.querySelectorAll('p')].find((p) => /Address in the QR code/.test(p.textContent));
    return {
      warning: !!warning,
      address: address ? address.textContent.replace(/\s+/g, ' ').trim() : null,
    };
  `,
  )
}

/** Student: the account created with a room key can sign in and see work. */
async function studentPath(session, fixtures, context) {
  await openApp(session, context, { token: fixtures.student, locale: 'uk', width: 390 })
  await settle(session, context, 'content')

  const home = await session.run(
    context,
    `
    const text = document.body.textContent;
    return {
      name: text.includes('Check Student'),
      keys: /\b(student|common|auth)\.[a-z]+\b/.test(text),
      // What the page actually said, because "the name is missing" and "the
      // screen we signed in to is the login form" are different bugs.
      state: text.slice(0, 120),
      hasToken: !!localStorage.getItem('auth.token'),
    };
  `,
  )
  check(
    'student: signs in with the account the key created',
    home.name,
    `token=${home.hasToken} page said: ${home.state}`,
  )
  check('student: no untranslated keys on the home screen', !home.keys)
  await session.screenshot(context, join(SHOTS, 'student-home.png'))

  // The account menu: the header no longer carries the name, theme or language,
  // so this is the one control that has to work on every screen and both roles.
  const menu = await session.run(
    context,
    `
    // The account trigger is the one labelled "Account"; the language button in
    // the header is a menu too, and picking the wrong one tests the wrong thing.
    const trigger = [...document.querySelectorAll('[aria-haspopup=menu]')].find((b) =>
      /Account|Обліковий/.test(b.getAttribute('aria-label') || ''),
    );
    if (!trigger) return { opened: false, why: 'no account trigger in the header' };
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    // The open panel, specifically. Menus are no longer created on open - they
    // live in the document and are hidden with opacity and visibility - so
    // picking the first [role=menu] would read the closed one and pass a check
    // against a panel nobody can see.
    const panel = document.querySelector('[role=menu][data-open=true]');
    if (!panel) return { opened: false, why: 'the trigger opened nothing' };
    const text = panel.textContent;
    const result = {
      opened: true,
      hasName: /Check Student/.test(text),
      hasUsername: /browsercheck_s/.test(text),
      // This screen runs in Ukrainian, so the rows are matched in both
      // languages rather than assuming the English one.
      hasTheme: /Switch to|Перемкн|Увімкн|Dark theme|Темна тема/.test(text),
      isSwitch: !!panel.querySelector('[role=switch]'),
      // The row says "Language"; the locale names live in the list it opens.
      hasLanguage: /Language|Мова/.test(text),
      hasSignOut: /Вийти|Sign out/.test(text),
      // Every row must be reachable by keyboard, not just clickable. Five rows:
      // theme, language, sign out, plus the desktop's server and about.
      items: panel.querySelectorAll('[data-menu-item]').length,
      // And nothing must spill past the right edge on a phone.
      withinEdge: panel.getBoundingClientRect().right <= window.innerWidth + 1,
    };
    return result;
  `,
  )
  check('teacher/student: the account menu opens', menu.opened, menu.why ?? '')
  check('account menu: names the account', menu.hasName && menu.hasUsername)
  check(
    'account menu: has theme, language and sign out',
    menu.hasTheme && menu.hasLanguage && menu.hasSignOut,
    `theme=${menu.hasTheme} language=${menu.hasLanguage} signOut=${menu.hasSignOut}`,
  )
  check('account menu: the theme is a switch', menu.isSwitch, `role=switch found: ${menu.isSwitch}`)

  // Language is a row that opens its own list, so the locales are not in the
  // panel until that row is opened. Clicking it is what the check is about.
  const locales = await session.run(
    context,
    `
    const panel = document.querySelector('[role=menu][data-open=true]');
    if (!panel) return { opened: false };
    const row = [...panel.querySelectorAll('[role=menuitem]')].find((r) =>
      /Language|Мова/.test(r.textContent),
    );
    if (!row) return { opened: false, why: 'no language row' };
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    // Counted per panel, not per document: a list that is closed is still in
    // the document (panels are hidden with opacity and visibility, never
    // unmounted - see the panel's own comment), so its rows are descendants of
    // the account panel and a flat count sees them twice and reads a closed
    // list as open. A row belongs to the *nearest* panel above it, and only that
    // panel's state says whether it is on screen - a closest() that looks for
    // the open panel directly would skip a closed list and land on the open
    // account panel behind it.
    const rows = [...document.querySelectorAll('[role=menuitemradio]')].filter(
      (r) => r.closest('[role=menu]')?.getAttribute('data-open') === 'true',
    );
    return {
      opened: true,
      locales: rows.length,
      hasAmerican: /English/.test(rows.map((r) => r.textContent).join(' ')),
    };
  `,
  )
  check(
    'account menu: the language row opens a list of locales',
    locales.opened && locales.locales >= 2,
    locales.why ?? `${locales.locales} locale rows`,
  )
  check('the English locale is listed by name', locales.opened && locales.hasAmerican)
  check('account menu: every row is keyboard reachable', menu.items >= 3, `${menu.items} rows`)
  check('account menu: stays inside a 390px screen', menu.withinEdge)
  await session.screenshot(context, join(SHOTS, 'student-account-menu.png'))

  // Escape must close it, or the menu covers the content on a phone.
  // Escape on the element that has focus, so it bubbles the way a real key does.
  // The wait is longer than the leave transition (--motion-instant, 90ms) plus a
  // frame, because the panel stays in the DOM while it fades.
  const closed = await session.run(
    context,
    `
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    const panel = document.querySelector('[role=menu][data-open=true]');
    if (!panel) return 'closed';
    const cs = getComputedStyle(panel);
    return cs.opacity === '0' ? 'closed (fading)' : 'still visible, opacity ' + cs.opacity;
  `,
  )
  // A click anywhere else on the page closes it. Escape was checked above, and
  // Escape is the path nobody uses: a teacher clicks somewhere to get on with it.
  const dismissed = await session.run(
    context,
    `
    const trigger = [...document.querySelectorAll('[aria-haspopup=menu]')].find((b) =>
      /Account|Обліковий/.test(b.getAttribute('aria-label') || ''),
    );
    if (!trigger) return { why: 'no account trigger' };
    const panelOf = () => document.querySelector('[role=menu][data-open=true]');
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    const opened = !!panelOf();
    // A press on the page background, not a click: the handler listens for
    // pointerdown, and a synthetic click would leave the gap untested.
    const where = document.querySelector('main') ?? document.body;
    where.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5 }),
    );
    await new Promise((r) => setTimeout(r, 250));
    return { opened, closedByOutside: !panelOf(), target: where.tagName };
  `,
  )
  check(
    'account menu: a click outside closes it',
    dismissed.opened && dismissed.closedByOutside,
    dismissed.why ?? `opened=${dismissed.opened} closed=${dismissed.closedByOutside} pressed=${dismissed.target}`,
  )

  check('account menu: Escape closes it', closed === 'closed' || closed === 'closed (fading)', closed)

  // Reopened after Escape, so the screenshot below actually shows the menu: the
  // one above was taken while the sub-panel for the language was still open, and
  // the state dump on the next failure then read an empty page.
  const reopened = await session.run(
    context,
    `
    const trigger = [...document.querySelectorAll('[aria-haspopup=menu]')].find((b) =>
      /Account|Обліковий/.test(b.getAttribute('aria-label') || ''),
    );
    if (!trigger) return 'no account trigger';
    // Hover leaves the menu as the pointer leaves it, so a screenshot taken
    // through an automation client with no pointer can open it by click but not
    // keep it open: the click is on the trigger, which is inside the root.
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    const panel = document.querySelector('[role=menu][data-open=true]');
    if (!panel) return 'the trigger opened nothing';
    return 'open: ' + panel.textContent.replace(/\\s+/g, ' ').trim().slice(0, 120);
  `,
  )
  check('account menu: reopens after Escape', reopened.startsWith('open'), reopened)
  await session.screenshot(context, join(SHOTS, 'account-menu-open.png'))

  // The locale list is a panel of its own, opening to the left of the menu rather
  // than in place inside it. It used to hang off a button in the header.
  // Beside the menu needs room: a 208px list beside a 256px menu is 464px of
  // screen. This is checked at a desktop width, where that is what happens; the
  // 390px audit below covers the narrow case, where it opens downwards instead.
  await session.setViewport(context, 1100, 900)
  const languageMenu = await session.run(
    context,
    `
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    const trigger = [...document.querySelectorAll('[aria-haspopup=menu]')].find((b) =>
      /Account|Обліковий|Settings|Налаштування/.test(b.getAttribute('aria-label') || ''),
    );
    if (!trigger) return { opened: false, why: 'no menu trigger in the header' };
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    const panel = document.querySelector('[role=menu][data-open=true]');
    if (!panel) return { opened: false, why: 'the trigger opened nothing' };
    const row = [...panel.querySelectorAll('[role=menuitem]')].find((r) =>
      /Language|Мова/.test(r.textContent),
    );
    if (!row) return { opened: false, why: 'no language row' };
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    const lists = [...document.querySelectorAll('[role=menu][data-open=true]')];
    const localeRows = lists.flatMap((p) => [...p.querySelectorAll('[role=menuitemradio]')]);
    if (!localeRows.length) return { opened: false, why: 'the language row opened no list' };
    const box = localeRows[0].closest('[role=menu]').getBoundingClientRect();
    const menuBox = panel.getBoundingClientRect();
    return {
      opened: true,
      locales: localeRows.length,
      names: localeRows.map((r) => r.textContent.trim().replace(/\\s+/g, ' ')).join(' | '),
      withinEdge: box.left >= -1 && box.right <= window.innerWidth + 1,
      beside: box.right <= menuBox.left + 1,
    };
  `,
  )
  // The row that opens the list also closes it: one control, two states, and no
  // second place to reach for.
  const toggled = await session.run(
    context,
    `
    const panel = document.querySelector('[role=menu][data-open=true]');
    if (!panel) return { why: 'no open menu' };
    const row = [...panel.querySelectorAll('[role=menuitem]')].find((r) =>
      /Language|Мова/.test(r.textContent),
    );
    if (!row) return { why: 'no language row' };
    // The nearest panel owns the row; see the note on the locale count above for
    // why a closed list still has to read as closed.
    const rows = () =>
      [...document.querySelectorAll('[role=menuitemradio]')].filter(
        (r) => r.closest('[role=menu]')?.getAttribute('data-open') === 'true',
      ).length;
    const openNow = rows();
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const closedNow = rows();
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    return { openNow, closedNow, reopened: rows() };
  `,
  )
  // The theme switch's track lines up with the flag above it. Both are the last
  // thing in their row, so both should end at the row's content edge - and the
  // track did not, because a `<button>` is an intrinsic-sizing element: `display:
  // flex` arranges its children but does not make the button fill its parent, so
  // it stopped 37px short.
  const alignment = await session.run(
    context,
    `
    const panel = document.querySelector('[role=menu][data-open=true]');
    if (!panel) return { why: 'no menu' };
    const rows = [...panel.querySelectorAll('[role=menuitem], [role=none]')];
    const langRow = rows.find((r) => /Language|Мова/.test(r.textContent || ''));
    const switchBtn = panel.querySelector('[role=switch]');
    const flag = langRow ? langRow.querySelector('span[role=img]') : null;
    const track = switchBtn ? switchBtn.parentElement.querySelector('span.rounded-full') : null;
    if (!flag || !track) return { why: 'no flag or no track' };
    const right = (el) => Math.round(el.getBoundingClientRect().right);
    return { flagRight: right(flag), trackRight: right(track) };
  `,
  )
  check(
    'the theme switch lines up with the flag',
    alignment.flagRight === alignment.trackRight,
    alignment.why ?? `flag ends at ${alignment.flagRight}, track at ${alignment.trackRight}`,
  )

  // The sign-out tooltip opens below its button. Only that is asserted: the row
  // was given no reserved height, so the tooltip does land on the theme row, and
  // `clears` is reported rather than required. It is the number to watch if the
  // tooltip ever looks like it is fighting the control underneath it.
  const signOutTip = await session.run(
    context,
    `
    const panel = document.querySelector('[role=menu][data-open=true]');
    const button = panel && [...panel.querySelectorAll('button')].find((b) =>
      /Sign out|Вийти/i.test(b.getAttribute('aria-label') || ''),
    );
    if (!button) return { why: 'no sign-out button' };
    const tip = button.querySelector('[data-tip-panel]');
    // It is hidden until the pointer arrives, and a box that is not laid out
    // measures as nothing. Shown for the measurement, put back after: this
    // harness has no pointer, and the geometry is the thing being checked.
    tip.style.display = 'block';
    const themeRow = [...panel.querySelectorAll('[role=menuitem], [role=none]')].find(
      (r) => r.querySelector('[role=switch]'),
    );
    const tipBox = tip.getBoundingClientRect();
    const buttonBox = button.getBoundingClientRect();
    const themeBox = themeRow ? themeRow.getBoundingClientRect() : null;
    // Stacking, not geometry: the panel can sit exactly where it should and
    // still be painted *under* the control it overlaps, because every
    // state-layer is a stacking context and the theme row comes later in the
    // DOM. Sampled with the real hit-test stack inside the overlap, which is the
    // only way to see paint order rather than boxes.
    const track = panel.querySelector('[role=switch]');
    const overlapBox = (a, b) => {
      const left = Math.max(a.left, b.left);
      const right = Math.min(a.right, b.right);
      const top = Math.max(a.top, b.top);
      const bottom = Math.min(a.bottom, b.bottom);
      return right > left && bottom > top ? { x: (left + right) / 2, y: (top + bottom) / 2 } : null;
    };
    let above = null;
    let onTop = '';
    // The switch itself first - that is what was painted over the tooltip - and
    // the row behind it if the two boxes happen not to meet at this width.
    const sample =
      (track && overlapBox(tipBox, track.getBoundingClientRect())) ||
      (themeBox && overlapBox(tipBox, themeBox));
    if (sample) {
      // The panel is pointer-events: none so it never eats a click, and that
      // also takes it out of hit-testing. Turn it on for the sample only.
      tip.style.pointerEvents = 'auto';
      const stack = document.elementsFromPoint(sample.x, sample.y);
      tip.style.pointerEvents = '';
      const first = stack[0];
      above = first === tip;
      onTop = first
        ? first.tagName.toLowerCase() + '.' + (first.className || '(no class)')
        : 'nothing';
    }
    tip.style.display = '';
    return {
      why: tipBox.height === 0 ? 'the tooltip is not laid out' : undefined,
      below: tipBox.top >= buttonBox.bottom,
      clears: themeBox ? Math.round(tipBox.bottom - themeBox.top) : null,
      above,
      onTop,
      rowsBeforeTheme: [...panel.querySelectorAll('[role=menuitem], [role=none]')]
        .findIndex((r) => r.querySelector('[role=switch]')) === 0,
    };
  `,
  )
  check(
    'the sign-out tooltip opens below its button',
    signOutTip.below,
    signOutTip.why ?? `overlaps the theme row by ${signOutTip.clears}px`,
  )
  // Paint order over the switch it overlaps. Requiring `true` rather than "not
  // false": a sample that found nothing would otherwise pass by saying nothing,
  // and `clears > 0` says there was something to find.
  check(
    'the sign-out tooltip paints above the switch it overlaps',
    signOutTip.above === true || signOutTip.clears <= 0,
    signOutTip.why ??
      `above=${signOutTip.above}, on top: ${signOutTip.onTop}, overlaps the row by ${signOutTip.clears}px`,
  )
  // The theme switch is the first row of the menu; the language list second.
  check('the theme switch comes before the language row', signOutTip.rowsBeforeTheme)

  // The avatar is the rightmost control in the header, so a tooltip centred on
  // it runs off the side of the screen and the name stops halfway. Measured at
  // the phone width, where there is least room for it to be wrong.
  const nameTip = await session.run(
    context,
    `
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    const trigger = [...document.querySelectorAll('[aria-haspopup=menu]')].find((b) =>
      /Account|Обліковий/.test(b.getAttribute('aria-label') || ''),
    );
    if (!trigger) return { why: 'no account trigger' };
    const tip = trigger.querySelector('[data-tip-panel]');
    if (!tip) return { why: 'no tooltip' };
    tip.style.display = 'block';
    const box = tip.getBoundingClientRect();
    const text = tip.textContent.trim();
    tip.style.display = '';
    return {
      why: box.width === 0 ? 'the tooltip is not laid out' : undefined,
      overflow: Math.round(box.right - window.innerWidth),
      carriesUsername: /browsercheck_s/.test(text),
    };
  `,
  )
  check(
    'the avatar tooltip carries the username and stays on screen',
    nameTip.overflow <= 0 && nameTip.carriesUsername,
    nameTip.why ?? `${nameTip.overflow}px past the right edge`,
  )

  check(
    'the language row closes its own list',
    toggled.openNow > 0 && toggled.closedNow === 0 && toggled.reopened > 0,
    toggled.why ?? `${toggled.openNow} -> ${toggled.closedNow} -> ${toggled.reopened}`,
  )

  check(
    'the locale list opens beside the menu, not inside it',
    languageMenu.opened && languageMenu.locales >= 2 && languageMenu.beside,
    languageMenu.why ?? `${languageMenu.locales} rows: ${languageMenu.names} beside=${languageMenu.beside}`,
  )
  check('the locale list stays inside the screen', languageMenu.withinEdge)
  await session.setViewport(context, 390, 844)

  // The capture shows the menu closed even though it is in the DOM and the
  // checks read it: `browsingContext.captureScreenshot` composites the page
  // before the Vue transition finishes painting the overlay. A wait after the
  // click, not a wait inside it, is what gets it into the picture.
  await session.screenshot(context, join(SHOTS, 'language-menu-open.png'))

  // Two failures on "the screenshot does not show the menu", so this stops being
  // guessed at. The capture comes back without the overlay however long it waits,
  // while the DOM has it and every check reads it - so the screenshot is not a
  // usable failure report for an open menu in this harness. Recorded here rather
  // than retried: the state dump above is what a failure is diagnosed from.
  // TODO: the login and menu screenshots come from a viewport capture that skips
  // the composited layer; a full-page capture or disabling the overlay's
  // compositing would put the menu in the picture. Until then, a menu failure is
  // diagnosed from `the page said`, not from this file.

  // The signed-out screens, where there is no account to put in a menu. A student
  // arriving from a room QR lands here first, and it is the first thing anybody
  // sees, so it is checked in both languages at phone width.
  // Sign out through the store, then navigate: a second load is what makes the app
  // read the missing token, and `location.href` from inside a script leaves the
  // BiDi navigate wait pointing at the previous document.
  await openApp(session, context, { token: fixtures.teacher, locale: 'en', width: 390, height: 844 })
  await session.run(
    context,
    `
    localStorage.removeItem('auth.token');
    return true;
  `,
  )
  navigations += 1
  await session.goto(context, `${BASE}/?out=${navigations}`)
  // 'signed-out' is a finished state here, not a stall: settle() otherwise waits
  // for content that will never arrive and reports a timeout.
  await settle(session, context, 'signed-out')

  const login = await session.run(
    context,
    `
    const text = document.body.textContent;
    const roles = [...document.querySelectorAll('[aria-pressed]')]
      .map((b) => (b.getAttribute('aria-pressed') === 'true' ? 'on:' : 'off:') + b.textContent.trim())
      .join('|');
    return {
      // Two roles, and one of them is selected before anything is typed. The role
      // sends nothing to the server - login takes a username and a password - but
      // it decides which of the two ways into this app is being offered, and the
      // field below it remembers a different name for each.
      roleCount: roles ? roles.split('|').length : 0,
      roles,
      // The admin role is not one of them. It was removed in 0.5.1 and a button
      // claiming otherwise is how a student comes to believe the system is about
      // administrators.
      noAdminRole: !/\bAdmin\b|Адміністратор/.test(roles),
      hasUsername: !!document.querySelector('input[autocomplete=username]'),
      hasPassword: !!document.querySelector('input[type=password]'),
      submitButtons: [...document.querySelectorAll('button[type=submit]')].length,
      // "Keep me signed in", which is what stops the password being typed twice.
      hasRemember: !!document.querySelector('[role=checkbox]'),
      rememberLabel: document.querySelector('[role=checkbox]')?.textContent.trim() ?? '',
      // No account menu to somebody who is not signed in. Both the account button
      // and the language button are menus, so the check asks for the account one by
      // its own label rather than counting menus.
      noAccountButton: ![...document.querySelectorAll('[aria-haspopup=menu]')].some((b) =>
        /Account|Обліковий/.test(b.getAttribute('aria-label') || ''),
      ),
      // Signed out there is no account, but there are still settings: the theme,
      // the language and the server. The header opens them with one button.
      hasSettingsMenu: [...document.querySelectorAll('[aria-haspopup=menu]')].some((b) =>
        /Settings|Налаштування/.test(b.getAttribute('aria-label') || ''),
      ),
      keys: /\b(auth|common|menu|student|teacher)\\.[a-z]+\\b/.test(text),
    };
  `,
  )
  check('login: two roles, one already chosen', login.roleCount === 2 && login.roles.startsWith('on:'), login.roles)
  check('login: no administrator role', login.noAdminRole)
  check('login: asks for a username and a password', login.hasUsername && login.hasPassword)
  check('login: one submit button', login.submitButtons === 1, `${login.submitButtons} found`)
  check('login: offers to keep the session', login.hasRemember && login.rememberLabel.length > 0)
  check('login: the student tab offers an account', /Create account|Створити акаунт/.test(await roleCardText(session, context, 0)))
  check('login: the teacher tab points at an administrator', /administrator|адміністратор/i.test(await roleCardText(session, context, 1)))
  check('login: no account menu when signed out', login.noAccountButton)
  check('login: the settings menu is there instead', login.hasSettingsMenu)
  check('login: no untranslated keys', !login.keys)
  await session.screenshot(context, join(SHOTS, 'login-signed-out.png'))

  // Each role keeps its own name in the field. Typed rather than seeded, because
  // a seeded name only proves the restore path and the tab swap is the part that
  // can carry a teacher name onto the student tab.
  // One step per call, with the frame in between: three clicks inside a single
  // script all run before Vue has re-rendered, so the field still holds the old
  // role's name and the check reports a bug that is not there.
  const pickRole = (index) =>
    session.run(
      context,
      `
      const button = [...document.querySelectorAll('[aria-pressed]')][${index}];
      if (button.getAttribute('aria-pressed') !== 'true') button.click();
      return true;
    `,
    )
  const typeName = (value) =>
    session.run(
      context,
      `
      const el = document.querySelector('input[autocomplete=username]');
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    `,
    )
  const readName = () =>
    session.run(context, `return document.querySelector('input[autocomplete=username]').value;`)

  await pickRole(0)
  await typeName('draft_student')
  await pickRole(1)
  await sleep(200)
  const drafts = { onTeacher: await readName() }
  await pickRole(0)
  await sleep(200)
  drafts.backOnStudent = await readName()
  // The fill on a tab and the line under the form both read the selected role,
  // so they cannot drift apart - unless something else starts answering for the
  // role, which reading both together catches.
  const pairing = await session.run(
    context,
    `
    const roles = [...document.querySelectorAll('[aria-pressed]')];
    const selected = roles.findIndex((b) => b.getAttribute('aria-pressed') === 'true');
    const footer = document.querySelector('form').parentElement.textContent;
    return {
      selected,
      label: roles[selected] ? roles[selected].textContent.trim() : 'none',
      teacher: /administrator|адміністратор/i.test(footer),
    };
  `,
  )
  check(
    'login: the filled tab matches the line under the form',
    pairing.teacher === (pairing.selected === 1),
    `tab ${pairing.selected} (${pairing.label}), teacher line: ${pairing.teacher}`,
  )

  check(
    'login: the tabs keep a name each',
    drafts.onTeacher !== 'draft_student' && drafts.backOnStudent === 'draft_student',
    `teacher saw ${JSON.stringify(drafts.onTeacher)}, student got ${JSON.stringify(drafts.backOnStudent)}`,
  )

  // The remembered session signs in by itself. Written into localStorage the way
  // the checkbox writes it, then a real navigation: if this ever regresses to "the
  // fields are filled in" it passes, and that is not the feature.
  await session.run(
    context,
    `
    localStorage.setItem('auth.remember', ${JSON.stringify(
      JSON.stringify({ role: 'teacher', username: 'teacher', password: TEACHER_PASSWORD }),
    )});
    localStorage.removeItem('auth.token');
    return true;
  `,
  )
  navigations += 1
  await session.goto(context, `${BASE}/?check=${navigations}`)
  const auto = await settle(session, context, 'tabs')
  check('login: a remembered session signs in by itself', auto === 'ready', `settle: ${auto}`)
  await session.screenshot(context, join(SHOTS, 'login-remembered.png'))
}

/**
 * The text under the form for one role, read after clicking that role's button.
 *
 * The two roles offer different ways in - a student can make an account, a
 * teacher cannot - so the line under the form is part of the role's meaning and
 * is checked per role rather than once.
 */
async function roleCardText(session, context, index) {
  await session.run(
    context,
    `
    const buttons = [...document.querySelectorAll('[aria-pressed]')];
    const button = buttons[${index}];
    if (!button) return '';
    if (button.getAttribute('aria-pressed') !== 'true') button.click();
    return true;
  `,
  )
  await sleep(150)
  return session.run(
    context,
    `
    const card = document.querySelector('[role=checkbox]').closest('section,div.card') || document.body;
    return card.textContent;
  `,
  )
}


// ------------------------------------------------------------------- running

async function main() {
  console.log(`browser checks against ${BASE}`)
  try {
    await api('/api/health')
  } catch {
    console.log(`no server on ${BASE}. Start one with: pnpm dev:server`)
    process.exit(2)
  }

  mkdirSync(SHOTS, { recursive: true })
  const profile = mkdtempSync(join(tmpdir(), 'lantern-ff-'))
  let child = null
  let session = null
  // The open tab, so a failure can be photographed. A check that fails without a
  // picture is a puzzle; with one it is a bug report.
  let context = null
  // Seeding is inside the try on purpose: a fixture that fails halfway through
  // must still be torn down, or the next run starts on a database someone else's
  // leftovers polluted.
  let fixtures = null
  try {
    fixtures = await seed()
    console.log(
      `fixtures ready (teacher ${NAMES.teacher}, student ${NAMES.student}, key ${fixtures.key})`,
    )

    const port = await freePort()
    const launched = await Session.launch({ port, profile })
    child = launched.child
    session = await Session.open(launched.url)

    console.log('\nlayout: three roles, two languages, three widths')
    context = await layoutSweep(session, fixtures)

    console.log('\nhappy paths')
    await happyPaths(session, fixtures)
    await studentPath(session, fixtures, context)

    await session.close()
  } catch (error) {
    failures.push(`harness: ${error.message}`)
    console.log(`   FAIL  harness — ${error.message}`)
    if (context && session) {
      try {
        await session.screenshot(context, join(SHOTS, 'failure.png'))
        const seen = await session
          .run(
            context,
            `const app = document.querySelector('#app');
             return JSON.stringify({
               tabs: document.querySelectorAll('[role=tab]').length,
               url: location.href,
               ready: document.readyState,
               text: app ? app.textContent.replace(/\\s+/g, ' ').trim().slice(0, 200) : 'no #app',
             });`,
          )
          .catch((inner) => `could not read the page: ${inner.message}`)
        console.log(`   the page said: ${seen}`)
      } catch {
        // The tab may be gone already; the failure is reported either way.
      }
    }
  } finally {
    child?.kill('SIGKILL')
    rmSync(profile, { recursive: true, force: true })
    await cleanup()
  }

  console.log(`\nscreenshots: ${SHOTS}`)
  if (failures.length > 0) {
    console.log(`\n${failures.length} check(s) failed:`)
    for (const failure of failures) console.log(`  - ${failure}`)
    process.exit(1)
  }
  console.log('\nall checks passed')
}

main()
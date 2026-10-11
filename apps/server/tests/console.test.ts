import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp, type TestingApp } from '../src/app'
import {
  CONSOLE_COMMANDS,
  type CommandSpec,
  executeCommand,
  parseCommand,
  type ConsoleContext,
  type ConsoleCommandName,
} from '../src/lib/console'
import { hashPassword } from '../src/lib/passwords'
import { createSession } from '../src/lib/tokens'

let app: TestingApp
let tmpDir: string

function now(): string {
  return new Date().toISOString()
}

/** A console wired to the test database, with output captured instead of printed. */
function makeContext(overrides: Partial<ConsoleContext> = {}): ConsoleContext {
  return {
    db: app.database.raw,
    logs: app.logs,
    uploadsDir: join(tmpDir, 'uploads'),
    stop: async () => {},
    clearScreen: '<CLEAR>',
    ...overrides,
  }
}

/** Runs a line of input the way the terminal would, and returns what it printed. */
async function run(line: string, ctx = makeContext()): Promise<string[]> {
  const parsed = parseCommand(line)
  if (parsed.kind !== 'ok') throw new Error(`not a command: ${line} (${parsed.kind})`)
  return executeCommand(parsed.command, ctx)
}

function seedUser(username: string, role: string, status = 'approved', password = 'secret-pass-1'): string {
  const id = crypto.randomUUID()
  app.database.raw
    .prepare(
      `INSERT INTO users (id, role, status, username, password_hash, full_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, role, status, username, hashPassword(password), `${username} person`, now(), now())
  return id
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'testsys-console-'))
  app = buildApp({
    host: '127.0.0.1',
    port: 0,
    dbPath: join(tmpDir, 'test.db'),
    webRoot: null,
  })
})

afterAll(() => {
  app.server.close()
  app.database.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('reading a line of console input', () => {
  it('ignores an empty line instead of complaining about it', () => {
    expect(parseCommand('')).toEqual({ kind: 'empty' })
    expect(parseCommand('   ')).toEqual({ kind: 'empty' })
  })

  it('parses a command and its arguments', () => {
    expect(parseCommand('approve olena')).toEqual({
      kind: 'ok',
      command: { name: 'approve', args: ['olena'] },
    })
  })

  it('collapses the spaces a pasted line comes with', () => {
    expect(parseCommand('  password    olena   hunter2hunter  ')).toEqual({
      kind: 'ok',
      command: { name: 'password', args: ['olena', 'hunter2hunter'] },
    })
  })

  it('is not case sensitive about the command itself', () => {
    expect(parseCommand('HELP')).toEqual({ kind: 'ok', command: { name: 'help', args: [] } })
  })

  it('says what it knows when the command is unknown', () => {
    const result = parseCommand('deploy')
    expect(result.kind).toBe('unknown')
    if (result.kind !== 'unknown') return
    expect(result.message).toContain('deploy')
    // The message has to be usable: it lists what is available.
    expect(result.message).toContain('approve')
  })

  it('shows the usage when an argument is missing', () => {
    const result = parseCommand('approve')
    expect(result).toEqual({ kind: 'usage', message: 'usage: approve <username>' })
  })

  it('shows the usage when there are too many arguments', () => {
    const result = parseCommand('status now please')
    expect(result).toEqual({ kind: 'usage', message: 'usage: status' })
  })

  it('allows the optional argument of `students`', () => {
    expect(parseCommand('students')).toEqual({ kind: 'ok', command: { name: 'students', args: [] } })
    expect(parseCommand('students pending')).toEqual({
      kind: 'ok',
      command: { name: 'students', args: ['pending'] },
    })
    expect(parseCommand('students a b').kind).toBe('usage')
  })

  it('leaves the meaning of an argument to the command, not to the parser', async () => {
    // The parser counts arguments; it does not know which words are valid. The
    // command does, and says what is allowed.
    expect(parseCommand('students approved')).toEqual({
      kind: 'ok',
      command: { name: 'students', args: ['approved'] },
    })
    const lines = await run('students approved')
    expect(lines).toEqual(['usage: students [pending]'])
  })

  it('documents every command it accepts, so `help` cannot drift from the parser', () => {
    const filler: Record<string, string[]> = {
      approve: ['someone'],
      block: ['someone'],
      password: ['someone', 'a-password-1'],
      admin: ['someone', 'a-password-1'],
      level: ['info'],
    }
    for (const name of Object.keys(CONSOLE_COMMANDS) as ConsoleCommandName[]) {
      const spec: CommandSpec = CONSOLE_COMMANDS[name]
      const line = [name, ...(filler[name] ?? [])].join(' ')
      expect(parseCommand(line)).toEqual({
        kind: 'ok',
        command: { name, args: filler[name] ?? [] },
      })
      expect(spec.usage.startsWith(name)).toBe(true)
      expect(spec.summary.length).toBeGreaterThan(3)
    }
  })
})

describe('what the console is allowed to do', () => {
  it('approves a pending account, through the same function the API uses', async () => {
    seedUser('olena', 'student', 'pending')
    const lines = await run('approve olena')
    expect(lines.join(' ')).toContain('approved')
    const row = app.database.raw
      .prepare('SELECT status FROM users WHERE username = ?')
      .get('olena') as { status: string }
    expect(row.status).toBe('approved')
  })

  it('ends every session of a blocked account, the way the API does', async () => {
    const id = seedUser('petro', 'student')
    createSession(app.database.raw, id)
    expect(
      app.database.raw.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(id),
    ).toEqual({ n: 1 })

    await run('block petro')
    expect(
      (app.database.raw.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(id) as {
        n: number
      }).n,
    ).toBe(0)
  })

  it('creates an admin — nobody has to have one from the start', async () => {
    const lines = await run('admin principal a-password-1')
    expect(lines.join(' ')).toContain('now an admin')
    const row = app.database.raw
      .prepare("SELECT role, status FROM users WHERE username = 'principal'")
      .get() as { role: string; status: string }
    expect(row.role).toBe('admin')
    expect(row.status).toBe('approved')
  })

  it('refuses to create a second account under a name already taken', async () => {
    const lines = await run('admin principal another-password')
    expect(lines.join(' ')).toContain('already an account')
  })

  it('refuses to block an admin, exactly as the API refuses', async () => {
    const lines = await run('block principal')
    expect(lines.join(' ')).toContain('admin')
    const row = app.database.raw
      .prepare("SELECT status FROM users WHERE username = 'principal'")
      .get() as { status: string }
    expect(row.status).toBe('approved')
  })

  it('allows an admin password reset — that is how a lockout is recovered', async () => {
    const lines = await run('password principal a-new-password')
    expect(lines.join(' ')).toContain('password set')
  })

  it('says so when the account does not exist', async () => {
    expect((await run('approve nobody')).join(' ')).toContain('no such account')
    expect((await run('password nobody whatever1')).join(' ')).toContain('no such account')
  })

  it('refuses a short password before touching the database', async () => {
    const before = app.database.raw
      .prepare("SELECT password_hash FROM users WHERE username = 'admin'")
      .get()
    expect((await run('password admin short')).join(' ')).toContain('8 characters')
    expect(
      app.database.raw.prepare("SELECT password_hash FROM users WHERE username = 'admin'").get(),
    ).toEqual(before)
  })
})

describe('what the console prints', () => {
  it('lists every account with the columns aligned', async () => {
    seedUser('short', 'student')
    seedUser('averyverylongusername', 'teacher')
    const lines = await run('users')
    expect(lines[0]).toContain('username')

    // Aligned means every value starts at the same offset, whatever its length.
    // The offset of a *gap* is not the thing to compare: a short name pads, so
    // its run of spaces starts earlier than the longest name's.
    const fields = lines.map((line) => line.split(/\s{2,}/))
    const widths = fields[0]!.map((_, column) =>
      Math.max(...fields.map((row) => (row[column] ?? '').length)),
    )
    const offsets: number[] = []
    let cursor = 0
    for (const width of widths) {
      offsets.push(cursor)
      cursor += width + 2
    }

    for (const [index, line] of lines.entries()) {
      for (const [column, value] of fields[index]!.entries()) {
        const at = offsets[column]!
        expect(line.slice(at, at + value.length)).toBe(value)
      }
    }
    // A long name pushes every other column, rather than overlapping it.
    expect(lines.some((line) => line.includes('averyverylongusername'))).toBe(true)
    expect(fields[0]).toHaveLength(4)
  })

  it('lists students, and only students', async () => {
    seedUser('stud1', 'student')
    seedUser('teach1', 'teacher')
    const lines = await run('students')
    expect(lines.join('\n')).toContain('stud1')
    expect(lines.join('\n')).not.toContain('teach1')
  })

  it('narrows students to those awaiting approval', async () => {
    seedUser('waiting', 'student', 'pending')
    seedUser('alreadyhere', 'student', 'approved')
    const lines = await run('students pending')
    const listed = lines.slice(1).map((line) => line.split(/\s{2,}/)[0])
    expect(listed).toContain('waiting')
    expect(listed).not.toContain('alreadyhere')
  })

  it('says there is nothing to show rather than printing an empty table', async () => {
    const lines = await run('sessions')
    expect(lines).toEqual(['no sessions yet'])
  })

  it('reports status with the numbers a teacher would ask for', async () => {
    seedUser('someone', 'student', 'pending')
    const text = (await run('status')).join('\n')
    expect(text).toContain('uptime')
    expect(text).toContain('database    ok')
    // The number is read from the database, so it cannot go stale as the file's
    // other tests seed more accounts.
    const pending = (
      app.database.raw
        .prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'pending'")
        .get() as { n: number }
    ).n
    expect(text).toContain(`pending     ${pending}`)
    const total = (app.database.raw.prepare('SELECT COUNT(*) AS n FROM users').get() as {
      n: number
    }).n
    expect(text).toMatch(new RegExp(`accounts\\s+${total} total`))
  })

  it('shows the current log level, changes it, and rejects an unknown one', async () => {
    const shown = (await run('level')).join('')
    expect(shown).toContain(app.logs.logger.level)

    await run('level warn')
    expect(app.logs.logger.level).toBe('warn')

    const rejected = (await run('level shout')).join(' ')
    expect(rejected).toContain('unknown level')
    // A rejected level leaves the real one alone.
    expect(app.logs.logger.level).toBe('warn')
    await run('level info')
  })

  it('clears the screen through the injected sequence, not a literal escape', async () => {
    expect(await run('clear')).toEqual(['<CLEAR>'])
  })

  it('lists the commands in `help`, from the same table the parser validates', async () => {
    const text = (await run('help')).join('\n')
    for (const spec of Object.values(CONSOLE_COMMANDS)) {
      expect(text).toContain(spec.usage)
    }
  })

  it('stops the server when told to, and says so before it goes', async () => {
    let stopped = false
    const before = app.logs.buffer.latest()
    const lines = await run('stop', makeContext({ stop: async () => { stopped = true } }))
    expect(stopped).toBe(true)
    // The confirmation goes through the log, not the return value: stop ends the
    // process, so a returned line would never be printed.
    expect(lines).toEqual([])
    const written = app.logs.buffer.all().filter((entry) => entry.seq > before)
    expect(written.some((entry) => entry.msg.includes('stopping'))).toBe(true)
  })

  it('runs every command without throwing, against an almost empty database', async () => {
    const names = Object.keys(CONSOLE_COMMANDS) as ConsoleCommandName[]
    const args: Record<string, string[]> = {
      approve: ['someone'],
      block: ['someone'],
      password: ['someone', 'a-password-1'],
      admin: ['new-admin', 'a-password-1'],
      students: ['pending'],
      level: ['info'],
    }
    for (const name of names) {
      const line = [name, ...(args[name] ?? [])].join(' ')
      await expect(run(line)).resolves.toBeInstanceOf(Array)
    }
  })
})
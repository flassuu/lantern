import type { DatabaseSync } from 'node:sqlite'
import { setPasswordByUsername, setUserStatusByUsername } from './accountActions'
import { isLogLevel, LOG_LEVELS, type LogHub } from './log'
import { listSessions } from './sessions'
import { createUser, findUserByUsername, listUsers } from './users'

/**
 * The server console: typed commands on the terminal the server runs in.
 *
 * A teacher in a school computer room is alone with the machine that serves the
 * class, so "restart it, check who is pending, approve them, shut it down" has to
 * work from that keyboard. The commands call the same library functions the HTTP
 * API calls — `approve` is not a second implementation of approval, it is the
 * same `setUserStatus` — because a console that drifts from the API is a console
 * that eventually does something the app would not.
 *
 * The terminal is the operator: whoever can type here can do what an admin can
 * over HTTP, and nobody else can reach it.
 */

export type ConsoleCommandName =
  | 'help'
  | 'status'
  | 'sessions'
  | 'users'
  | 'students'
  | 'approve'
  | 'block'
  | 'password'
  | 'admin'
  | 'level'
  | 'clear'
  | 'stop'

export interface CommandSpec {
  usage: string
  summary: string
  /** Exact argument count, or an inclusive range. */
  args: number | [number, number]
}

export const CONSOLE_COMMANDS: Record<ConsoleCommandName, CommandSpec> = {
  help: { usage: 'help', summary: 'this list', args: 0 },
  status: { usage: 'status', summary: 'uptime, accounts, database', args: 0 },
  sessions: { usage: 'sessions', summary: 'live and recent runs', args: 0 },
  users: { usage: 'users', summary: 'every account', args: 0 },
  students: { usage: 'students [pending]', summary: 'students, or only those awaiting approval', args: [0, 1] },
  approve: { usage: 'approve <username>', summary: 'approve a registered account', args: 1 },
  block: { usage: 'block <username>', summary: 'block an account and revoke its sessions', args: 1 },
  password: {
    usage: 'password <username> <password>',
    summary: 'set a password and end that account’s sessions',
    args: 2,
  },
  admin: {
    usage: 'admin <username> <password>',
    summary: 'create an admin account for institution-wide management',
    args: 2,
  },
  level: { usage: 'level [name]', summary: `log level: ${LOG_LEVELS.join(', ')}`, args: [0, 1] },
  clear: { usage: 'clear', summary: 'clear the screen', args: 0 },
  stop: { usage: 'stop', summary: 'shut the server down', args: 0 },
}

export interface ParsedCommand {
  name: ConsoleCommandName
  args: string[]
}

export type ParseResult =
  | { kind: 'empty' }
  | { kind: 'unknown'; message: string }
  | { kind: 'usage'; message: string }
  | { kind: 'ok'; command: ParsedCommand }

/**
 * Reads one line of input.
 *
 * Pure, so every rule — an unknown word, a missing argument, one too many — is a
 * test rather than something discovered by typing at a running server.
 */
export function parseCommand(line: string): ParseResult {
  const parts = line.trim().split(/\s+/).filter((part) => part !== '')
  if (parts.length === 0) return { kind: 'empty' }

  const name = parts[0]!.toLowerCase()
  if (!(name in CONSOLE_COMMANDS)) {
    const known = Object.keys(CONSOLE_COMMANDS).join(', ')
    return { kind: 'unknown', message: `unknown command "${parts[0]}" — try: ${known}` }
  }
  const spec = CONSOLE_COMMANDS[name as ConsoleCommandName]
  const args = parts.slice(1)
  const [min, max] = Array.isArray(spec.args) ? spec.args : [spec.args, spec.args]
  if (args.length < min || args.length > max) {
    return { kind: 'usage', message: `usage: ${spec.usage}` }
  }
  return { kind: 'ok', command: { name: name as ConsoleCommandName, args } }
}

export interface ConsoleContext {
  db: DatabaseSync
  logs: LogHub
  /** Graceful shutdown, called by `stop`. */
  stop: () => Promise<void>
  /** Escape sequence that clears the screen; injectable so tests stay plain. */
  clearScreen?: string
}

const CLEAR_SCREEN = '[2J[H'

/** Columns of `width` for each value, so a list lines up without a table lib. */
function table(headers: string[], rows: string[][]): string[] {
  if (rows.length === 0) return []
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
  )
  const line = (cells: string[]) =>
    cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd()
  return [line(headers), ...rows.map(line)]
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}m`
}

/**
 * Runs one command and returns the lines to print.
 *
 * Returns text rather than printing it: that is what makes every command
 * testable without a terminal, and it lets the caller decide where the output
 * goes.
 */
export async function executeCommand(
  command: ParsedCommand,
  ctx: ConsoleContext,
): Promise<string[]> {
  const { db, logs } = ctx
  const [first, second] = command.args

  switch (command.name) {
    case 'help':
      return table(
        ['command', 'what it does'],
        Object.values(CONSOLE_COMMANDS).map((spec) => [spec.usage, spec.summary]),
      )

    case 'status': {
      const users = listUsers(db, {})
      const byRole = (role: string) => users.filter((user) => user.role === role).length
      const pending = users.filter((user) => user.status === 'pending').length
      const database = (db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined) !== undefined
      return [
        `uptime      ${formatDuration(process.uptime() * 1000)}`,
        `database    ${database ? 'ok' : 'unavailable'}`,
        `accounts    ${users.length} total — ${byRole('admin')} admin, ${byRole('teacher')} teacher, ${byRole('student')} student`,
        `pending     ${pending}`,
        `log level   ${logs.logger.level}`,
        `log buffer  ${logs.buffer.size} lines`,
      ]
    }

    case 'sessions': {
      const sessions = listSessions(db)
      const lines = table(
        ['code', 'status', 'submitted', 'test', 'started'],
        sessions.map((session) => [
          session.joinCode,
          session.status,
          `${session.submittedCount}/${session.joinedCount}`,
          session.title,
          session.startedAt ? session.startedAt.slice(0, 16).replace('T', ' ') : 'in lobby',
        ]),
      )
      return lines.length > 0 ? lines : ['no sessions yet']
    }

    case 'users': {
      const rows = listUsers(db, {})
      const lines = table(
        ['username', 'role', 'status', 'name'],
        rows.map((user) => [user.username, user.role, user.status, user.full_name]),
      )
      return lines.length > 0 ? lines : ['no accounts']
    }

    case 'students': {
      const onlyPending = first === 'pending'
      if (first !== undefined && first !== 'pending') {
        return [`usage: ${CONSOLE_COMMANDS.students.usage}`]
      }
      const rows = listUsers(db, {
        role: 'student',
        ...(onlyPending ? { status: 'pending' } : {}),
      })
      const lines = table(
        ['username', 'status', 'name'],
        rows.map((user) => [user.username, user.status, user.full_name]),
      )
      return lines.length > 0 ? lines : [onlyPending ? 'nobody is waiting' : 'no students yet']
    }

    case 'approve': {
      const result = setUserStatusByUsername(db, first!, 'approved')
      if (!result.ok) return [statusChangeMessage(result.reason, first!, 'approve')]
      logs.logger.info({ username: first, source: 'console' }, 'account approved from the console')
      return [`${first} is approved and can sign in`]
    }

    case 'block': {
      const result = setUserStatusByUsername(db, first!, 'blocked')
      if (!result.ok) return [statusChangeMessage(result.reason, first!, 'block')]
      logs.logger.warn({ username: first, source: 'console' }, 'account blocked from the console')
      return [`${first} is blocked; their sessions were revoked`]
    }

    case 'password': {
      if (second!.length < 8) return ['the password needs at least 8 characters']
      if (!setPasswordByUsername(db, first!, second!)) return [`no such account: ${first}`]
      logs.logger.warn({ username: first, source: 'console' }, 'password changed from the console')
      return [`password set for ${first}; their sessions were ended`]
    }

    case 'admin': {
      // An admin is optional: one teacher runs a class without one. This is how
      // an institution creates one later, from the terminal that is already
      // trusted, rather than by editing the seed variables and restarting.
      if (findUserByUsername(db, first!)) {
        return [`there is already an account called ${first}`]
      }
      createUser(db, {
        role: 'admin',
        status: 'approved',
        username: first!,
        password: second!,
        fullName: 'Administrator',
      })
      logs.logger.warn({ username: first, source: 'console' }, 'admin account created from the console')
      return [`${first} is now an admin; sign in with that password to manage every account`]
    }

    case 'level': {
      if (first === undefined) return [`log level is ${logs.logger.level}`]
      if (!isLogLevel(first)) {
        return [`unknown level "${first}" — use: ${LOG_LEVELS.join(', ')}`]
      }
      logs.logger.level = first
      // Written straight out: a level change that only shows on the next log line
      // is a change nobody believes.
      logs.logger.info({ level: first, source: 'console' }, 'log level changed')
      return [`log level is now ${first}`]
    }

    case 'clear':
      return [ctx.clearScreen ?? CLEAR_SCREEN]

    case 'stop':
      // Written to the log *before* the shutdown, because stop ends the process:
      // a line returned from here would never be printed. Warn level, so it is
      // visible even if the operator has turned the level up past info.
      logs.logger.warn({ source: 'console' }, 'stopping the server from the console')
      await ctx.stop()
      return []

    default: {
      // parseCommand cannot produce this, but a switch that can fall through is
      // a switch that will, one version later.
      const exhaustive: never = command.name
      return [String(exhaustive)]
    }
  }
}

function statusChangeMessage(
  reason: 'not_found' | 'is_admin',
  username: string,
  verb: string,
): string {
  return reason === 'not_found'
    ? `no such account: ${username}`
    : `${username} is an admin — an admin account cannot be ${verb === 'approve' ? 'approved' : 'blocked'}`
}

export interface ConsoleHandle {
  close(): void
}

/**
 * Attaches the interactive console when there is a terminal to attach to.
 *
 * Returns null when stdin or stdout is not a TTY — that is the piped case, a CI
 * run or a desktop app starting the server as a child — and when `--no-console`
 * was given. Silently: the absence of a console is the normal state in two of
 * those three cases, and it should not print a line about itself.
 */
export async function attachConsole(
  ctx: ConsoleContext,
  options: { enabled: boolean; input?: NodeJS.ReadStream; output?: NodeJS.WriteStream },
): Promise<ConsoleHandle | null> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  if (!options.enabled) return null
  if (!input.isTTY || !output.isTTY) return null

  const readline = await import('node:readline')
  const rl = readline.createInterface({ input, output, terminal: true })
  const prompt = '› '

  const write = (line: string) => output.write(`${line}\n`)
  /** readline's prompt is written by prompt(), and prompt(prompt) is a *cursor*
   *  option — the text itself is set on the interface. */
  const reprompt = () => {
    rl.setPrompt(prompt)
    rl.prompt()
  }
  write('')
  write('LANtern server console — `help` for commands, `stop` to shut down.')

  rl.on('line', (line) => {
    const parsed = parseCommand(line)
    if (parsed.kind === 'empty') {
      reprompt()
      return
    }
    if (parsed.kind === 'unknown' || parsed.kind === 'usage') {
      write(parsed.message)
      reprompt()
      return
    }
    void executeCommand(parsed.command, {
      ...ctx,
      clearScreen: `${CLEAR_SCREEN}`,
    })
      .then((lines) => {
        for (const line of lines) write(line)
      })
      .catch((error: unknown) => {
        write(`command failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(reprompt)
  })

  reprompt()

  return {
    close() {
      rl.close()
    },
  }
}
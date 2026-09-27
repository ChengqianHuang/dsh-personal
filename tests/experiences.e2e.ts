// Real-API e2e for the dsh-personal bundle (experiences model) through the
// production headless profile. Two runs share one database: the second is a
// cold restart on the same file, proving experiences survive without any
// conversation memory. Run from the dsh repo root:
//   npx vitest run --config dsh-personal/vitest.e2e.config.ts
// Reads the real harness home's default model route; self-skips without one.
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { todayIso } from '../src/dates.ts'
import { openPersonalDatabase } from '../src/store/open.ts'

const driver = fileURLToPath(new URL('./fixtures/driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/experiences.patch.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../tsconfig.json', import.meta.url))

/** The provider route the test runs on, read from the real harness settings. */
interface ProviderRoute {
  provider: string
  model: string
}

/** Date zone shared by the driver subprocess and these assertions. */
const ZONE = 'Asia/Shanghai'

const HOME = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')

/** Resolve the default model route from the real Harness home settings. */
function resolveRoute(): ProviderRoute | undefined {
  const settingsPath = join(HOME, 'settings.yaml')
  if (!existsSync(settingsPath)) return undefined
  // Minimal targeted parse of the machine-written settings file: pull the
  // provider/model lines directly under the `agent-default-model:` key.
  const lines = readFileSync(settingsPath, 'utf8').split('\n')
  const keyIndex = lines.findIndex(line => line.trim() === 'agent-default-model:')
  if (keyIndex === -1) return undefined
  let provider: string | undefined
  let model: string | undefined
  for (let index = keyIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!
    if (line.trim().length > 0 && !line.startsWith(' ')) break
    const match = /^\s+(provider|model):\s*(.+)$/.exec(line)
    if (match?.[1] === 'provider') provider = match[2]!.trim()
    if (match?.[1] === 'model') model = match[2]!.trim()
  }
  if (provider === undefined || model === undefined) return undefined
  return { provider, model }
}

const route = resolveRoute()

const CAPTURE_TASKS = [
  '今天看了《灵媒》，7.5 分。',
  '读完了《失控》的第一章，8 分。',
  '听了 Daft Punk 的《Random Access Memories》，这张专辑太棒了。',
  '周末去看了teamLab的展览。',
  'Forge 今天把 Pi MiniMax streaming 中文错位问题定位清楚了。',
  '周末看《沙丘 3》。',
  '我最近看了哪些电影？',
  '我最近读过什么书？',
  'Forge 最近都做了什么？',
]

async function jsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return jsonlFiles(path)
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : []
  }))
  return paths.flat()
}

/** Collect session events from one run's persisted logs. */
async function readSessionEvents(cwd: string): Promise<SessionEvent[]> {
  const logs = await jsonlFiles(join(cwd, '.sessions'))
  const events: SessionEvent[] = []
  for (const log of logs) {
    const lines = (await readFile(log, 'utf8')).trimEnd().split('\n')
    events.push(...lines.slice(1).map(line => JSON.parse(line) as SessionEvent))
  }
  return events
}

/**
 * Run one headless smoke on a hermetic copy of the real harness home: the
 * subprocess reads the same settings and credentials as a user boot, while
 * sessions and the personal database land in test-owned paths.
 * @param params - run label, task list, database path, and inspect hook.
 * @returns the smoke result (stdout and stderr).
 */
async function runPersonalSmoke(params: {
  label: string
  tasks: string[]
  dbPath: string
  inspect: (cwd: string) => Promise<void>
}): Promise<{ stdout: string; stderr: string }> {
  return runLoaderSmoke({
    label: params.label,
    tempDirPrefix: `dsh-personal-e2e-${params.label}-`,
    binScript: driver,
    configPath,
    tsconfigPath: repoTsconfig,
    processTimeoutMs: 600_000,
    env: {
      TZ: ZONE,
      E2E_PROVIDER: (route as ProviderRoute).provider,
      E2E_MODEL: (route as ProviderRoute).model,
      E2E_TASKS: JSON.stringify(params.tasks),
      E2E_DB: params.dbPath,
    },
    prepare: async (cwd) => {
      await mkdir(join(cwd, '.dsh'), { recursive: true })
      await copyFile(join(HOME, 'settings.yaml'), join(cwd, '.dsh', 'settings.yaml'))
      await copyFile(join(HOME, '.credentials.yaml'), join(cwd, '.dsh', '.credentials.yaml'))
    },
    inspect: params.inspect,
  })
}

describe.skipIf(route === undefined || !existsSync(join(HOME, '.credentials.yaml')))('dsh-personal experiences e2e (real provider)', () => {
  it('captures open-category experiences, routes planned items to tasks, and survives a restart', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dsh-personal-e2e-'))
    try {
      const dbPath = join(parent, 'run1', 'personal.db')
      let first: { stdout: string; stderr: string }
      try {
        first = await runPersonalSmoke({
          label: 'capture',
          tasks: CAPTURE_TASKS,
          dbPath,
          inspect: async (cwd) => {
            await assertCapturedRows(dbPath)
            await assertToolCalls(cwd)
          },
        })
      } catch (error) {
        // Print the subprocess evidence without letting vitest's stack parser
        // trip over binary sourcemap comments in nested error stacks.
        console.log('CAPTURE-FAILURE:', (error as Error).message?.slice(0, 4000))
        throw new Error('capture run failed')
      }
      expect(first.stderr).not.toContain('UNHANDLED')

      // Cold restart on the same database bytes: a fresh session has no
      // conversation memory, so any correct answer must come from SQLite.
      const dbPath2 = join(parent, 'run2', 'personal.db')
      await mkdir(join(parent, 'run2'), { recursive: true })
      await copyFile(dbPath, dbPath2)
      const second = await runPersonalSmoke({
        label: 'restart',
        tasks: ['我最近看了哪些电影？我最近读过什么书？'],
        dbPath: dbPath2,
        inspect: async (cwd) => {
          const events = await readSessionEvents(cwd)
          const calls = events.filter(event => event.type === 'tool/call')
            .map(event => (event.data as { name: string }).name)
          expect(calls).toContain('query_experiences')
          const resultText = JSON.stringify(events.filter(event => event.type === 'tool/result'))
          expect(resultText).toContain('灵媒')
          expect(resultText).toContain('失控')
        },
      })
      expect(second.stderr).not.toContain('UNHANDLED')
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  }, 900_000)

  /**
   * The capture turns must have written these exact facts: four experience
   * categories through one tool and one table, one planned item as a task,
   * one project log, and no spurious daily log.
   */
  async function assertCapturedRows(path: string): Promise<void> {
    const db = await openPersonalDatabase(path)
    try {
      const experiences = db.prepare(
        'SELECT category, action, title, rating FROM experiences ORDER BY category',
      ).all() as Array<{ category: string; action: string; title: string; rating: number | null }>
      const byCategory = new Map(experiences.map(row => [row.category, row]))
      expect(byCategory.get('movie')).toMatchObject({ action: 'watched', title: '灵媒', rating: 7.5 })
      expect(byCategory.get('book')).toMatchObject({ action: 'read', title: '失控' })
      expect(byCategory.get('album')).toMatchObject({ action: 'listened' })
      expect(byCategory.get('exhibition')).toMatchObject({ action: 'visited' })

      // Planned items are tasks, not experiences.
      const plannedTask = db.prepare(
        "SELECT status FROM tasks WHERE title LIKE '%沙丘%'",
      ).all() as Array<{ status: string }>
      expect(plannedTask).toHaveLength(1)
      expect(plannedTask[0]!.status).toBe('TODO')
      expect(db.prepare("SELECT COUNT(*) AS n FROM experiences WHERE title LIKE '%沙丘 3%'").get()).toEqual({ n: 0 })

      // Mixed input wrote its project log and no spurious daily log.
      expect(db.prepare("SELECT COUNT(*) AS n FROM project_logs WHERE title LIKE '%中文错位%'").get()).toEqual({ n: 1 })
      expect(db.prepare('SELECT COUNT(*) AS n FROM daily_logs').get()).toEqual({ n: 0 })
    } finally {
      db.close()
    }
  }

  /** The capture turns used the experience tools, never movie-era ones. */
  async function assertToolCalls(cwd: string): Promise<void> {
    const events = await readSessionEvents(cwd)
    const calls = events.filter(event => event.type === 'tool/call')
      .map(event => (event.data as { name: string }).name)
    expect(calls).toContain('record_experience')
    expect(calls).toContain('create_task')
    expect(calls).toContain('record_project_log')
    expect(calls).toContain('query_experiences')
    expect(calls).not.toContain('record_movie')
    expect(calls).not.toContain('query_movies')
    expect(calls).not.toContain('record_daily_log')
  }
})

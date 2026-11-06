/**
 * Self-update checks for the Expenses panel.
 *
 * DSH installs a GitHub plugin as a pnpm dependency pinned to one commit, and
 * nothing polls `main` afterwards. This host module fills that gap: it reads
 * the installed half, asks GitHub for the current version (and, for a local
 * git checkout, fetches the remote and counts commits), and can install the
 * update on request. An update is never applied without a user action.
 *
 * Two installation shapes are supported:
 *  - a `link:` checkout with `.git` — `git pull --ff-only`;
 *  - a pnpm tarball under `node_modules` — `pnpm update dsh-expenses` in the
 *    active profile, using the pnpm runtime that DSH itself ships.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** Absolute browser-authenticated routes for the update panel. */
export const UPDATE_STATUS_PATH = '/api/expenses.update'
export const UPDATE_CHECK_PATH = '/api/expenses.update.check'
export const UPDATE_APPLY_PATH = '/api/expenses.update.apply'

/** The public repository this plugin updates from. */
export const UPDATE_REPOSITORY = 'mikhailnarzik-source/dsh-expenses'

/** The raw manifest is not rate-limited like the REST API and is enough for a version check. */
export const REMOTE_MANIFEST_URL = `https://raw.githubusercontent.com/${UPDATE_REPOSITORY}/main/package.json`

/** A startup check waits this long so the first page paint and session restore win. */
export const STARTUP_DELAY_MS = 8_000

/** Background checks run this often; a manual "check" button always bypasses the cache. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/** A successful check is reused for this long by the passive status route. */
export const CHECK_TTL_MS = 6 * 60 * 60 * 1000

/** A failed check is retried by the passive status route after this pause. */
export const FAILED_RETRY_MS = 5 * 60 * 1000

const FETCH_TIMEOUT_MS = 8_000
const GIT_TIMEOUT_MS = 30_000
const GIT_PULL_TIMEOUT_MS = 90_000
const PNPM_TIMEOUT_MS = 180_000

/** Request headers that keep GitHub from refusing a server-side client. */
const GITHUB_HEADERS = {
  accept: 'text/plain, application/json;q=0.9',
  'accept-language': 'en',
  'user-agent': 'dsh-expenses-updater',
}

/**
 * Parse a semver-ish version: `1.2.3`, optional `-prerelease`.
 * @returns the parts, or `null` for a value that is not a version.
 */
export function parseVersion(value) {
  const text = String(value ?? '').trim().replace(/^v/u, '')
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(text)
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? '',
  }
}

/**
 * Compare two versions the way `semver` would for the shapes this plugin uses.
 * @returns a negative number, zero or a positive number.
 */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null || b === null) return 0
  for (const field of ['major', 'minor', 'patch']) {
    if (a[field] !== b[field]) return a[field] - b[field]
  }
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === '') return 1
  if (b.prerelease === '') return -1
  return a.prerelease < b.prerelease ? -1 : 1
}

/** Whether `latest` is strictly newer than `installed`. */
export function isNewerVersion(latest, installed) {
  return compareVersions(latest, installed) > 0
}

/** The DSH home directory, honouring the environment the desktop sets. */
function dshHome() {
  const fromEnvironment = process.env.DSH_HOME
  if (typeof fromEnvironment === 'string' && fromEnvironment.trim() !== '') return fromEnvironment.trim()
  return join(homedir(), '.dsh')
}

/** Read a small UTF-8 file without failing the whole check when it is missing. */
async function readText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Run a command and capture its output through temporary files.
 * Pipes can be unavailable in a confined host, while files always work.
 * @returns the exit code, stdout and stderr; a timeout is exit code 124.
 */
async function runCapture(command, args, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-expenses-update-'))
  const outPath = join(dir, 'out')
  const errPath = join(dir, 'err')
  const out = await open(outPath, 'w')
  const err = await open(errPath, 'w')
  try {
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : GIT_TIMEOUT_MS
    const code = await new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          ...(options.env ?? {}),
        },
        stdio: ['ignore', out.fd, err.fd],
        windowsHide: true,
      })
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          // The process may have already exited.
        }
        resolve(124)
      }, timeoutMs)
      timer.unref?.()
      child.once('error', () => {
        clearTimeout(timer)
        resolve(-1)
      })
      child.once('close', (value) => {
        clearTimeout(timer)
        resolve(value ?? -1)
      })
    })
    return {
      code,
      stdout: await readText(outPath) ?? '',
      stderr: await readText(errPath) ?? '',
    }
  } finally {
    await out.close().catch(() => {})
    await err.close().catch(() => {})
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Run one git command against the plugin checkout. */
function git(dir, args, timeoutMs = GIT_TIMEOUT_MS) {
  return runCapture('git', ['-C', dir, ...args], { timeoutMs })
}

/** Run git and return trimmed stdout, throwing a readable error on failure. */
async function gitText(dir, args, timeoutMs = GIT_TIMEOUT_MS) {
  const result = await git(dir, args, timeoutMs)
  if (result.code !== 0) {
    const reason = (result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ')
    throw new Error(reason === '' ? `git ${args.join(' ')} exited with ${result.code}` : reason)
  }
  return result.stdout.trim()
}

/** Read the manifest version of the installed plugin half. */
async function readInstalledVersion(pluginDir) {
  const text = await readText(join(pluginDir, 'package.json'))
  if (text === null) throw new Error('installed package.json is not readable')
  try {
    const manifest = JSON.parse(text)
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  } catch {
    throw new Error('installed package.json is not valid JSON')
  }
}

/** Ask GitHub for the current `main` manifest; the response is small and uncached. */
export async function fetchRemoteManifest(fetchImpl = fetch) {
  const response = await fetchImpl(`${REMOTE_MANIFEST_URL}?t=${Date.now()}`, {
    headers: GITHUB_HEADERS,
    cache: 'no-store',
    signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(FETCH_TIMEOUT_MS)
      : undefined,
  })
  if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status}`)
  const text = await response.text()
  try {
    const manifest = JSON.parse(text)
    if (typeof manifest.version !== 'string') throw new Error('no version')
    return manifest
  } catch {
    throw new Error('GitHub returned an unexpected package.json')
  }
}

/** Find the pnpm launcher that this DSH installation ships. */
async function findPnpmScript() {
  const runtimesRoot = join(dshHome(), 'dsh-runtimes')
  let runtimes = []
  try {
    runtimes = await readdir(runtimesRoot, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of runtimes) {
    if (!entry.isDirectory()) continue
    for (const name of ['pnpm.cjs', 'pnpm.mjs']) {
      const candidate = join(runtimesRoot, entry.name, 'dependencies', 'pnpm', 'bin', name)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** Find the Node binary that can run the pnpm launcher. */
async function findNodeBinary() {
  const runtimesRoot = join(dshHome(), 'dsh-runtimes')
  try {
    const runtimes = await readdir(runtimesRoot, { withFileTypes: true })
    for (const entry of runtimes) {
      if (!entry.isDirectory()) continue
      const candidate = join(runtimesRoot, entry.name, 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
      if (existsSync(candidate)) return candidate
    }
  } catch {
    // Fall through to the running executable.
  }
  return process.execPath
}

/** The profile directory that owns a tarball installation. */
function profileDirFor(pluginDir) {
  const fromEnvironment = process.env.DSH_PROFILE_DIR
  if (typeof fromEnvironment === 'string' && fromEnvironment.trim() !== '') return fromEnvironment.trim()
  return dirname(dirname(pluginDir))
}

/**
 * Create the update service. The returned object owns one cached state and
 * serializes overlapping checks.
 * @param options.pluginDir - the installed plugin directory (the one holding index.js).
 * @param options.fetch - fetch implementation (tests inject one).
 */
export function createUpdateService(options = {}) {
  const pluginDir = options.pluginDir
  if (typeof pluginDir !== 'string' || pluginDir === '') throw new Error('pluginDir is required')
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : fetch
  const now = () => Date.now()

  let state = {
    status: 'idle',
    mode: existsSync(join(pluginDir, '.git')) ? 'git' : 'package',
    installedVersion: '',
    latestVersion: '',
    available: false,
    behind: 0,
    dirty: false,
    canInstall: false,
    notes: [],
    checkedAt: 0,
    failedAt: 0,
    error: null,
    warning: null,
    localCommit: '',
    remoteCommit: '',
    restartRequired: false,
  }
  let inFlight = null
  let installedCache = null

  /** A copy safe to hand to JSON and to a browser. */
  const snapshot = () => ({
    ...state,
    notes: [...state.notes],
    checking: inFlight !== null,
  })

  /** The installed version, read once per process. */
  async function installedVersion() {
    if (installedCache !== null) return installedCache
    installedCache = await readInstalledVersion(pluginDir)
    return installedCache
  }

  /** Check a linked git checkout: fetch, count commits, report local dirt. */
  async function checkGit(installed) {
    const origin = await gitText(pluginDir, ['remote', 'get-url', 'origin'])
    if (!origin.toLowerCase().includes(UPDATE_REPOSITORY)) {
      throw new Error(`origin is ${origin}; expected ${UPDATE_REPOSITORY}`)
    }

    let warning = null
    let behind = 0
    let localCommit = ''
    let remoteCommit = ''
    let notes = []
    let dirty = false
    try {
      localCommit = await gitText(pluginDir, ['rev-parse', '--short', 'HEAD'])
      dirty = (await gitText(pluginDir, ['status', '--porcelain', '--untracked-files=no'])) !== ''
      await git(pluginDir, ['fetch', '--quiet', '--prune', 'origin', 'main'], GIT_TIMEOUT_MS)
      remoteCommit = await gitText(pluginDir, ['rev-parse', '--short', 'FETCH_HEAD'])
      behind = Number(await gitText(pluginDir, ['rev-list', '--count', 'HEAD..FETCH_HEAD'])) || 0
      if (behind > 0) {
        const log = await gitText(pluginDir, ['log', '--format=%h %s', '-n', '8', 'HEAD..FETCH_HEAD'])
        notes = log.split('\n').map(line => line.trim()).filter(Boolean)
      }
    } catch (error) {
      warning = error instanceof Error ? error.message : String(error)
    }

    let latestVersion = installed
    try {
      const remote = await fetchRemoteManifest(fetchImpl)
      latestVersion = remote.version
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      warning = warning === null ? `GitHub: ${reason}` : `${warning}; GitHub: ${reason}`
    }

    const available = behind > 0 || isNewerVersion(latestVersion, installed)
    return {
      available,
      latestVersion,
      behind,
      dirty,
      canInstall: available && !dirty,
      notes,
      warning,
      localCommit,
      remoteCommit,
      error: null,
    }
  }

  /** Check a tarball installation: compare the installed version with GitHub's. */
  async function checkPackage(installed) {
    const remote = await fetchRemoteManifest(fetchImpl)
    const available = isNewerVersion(remote.version, installed)
    return {
      available,
      latestVersion: remote.version,
      behind: 0,
      dirty: false,
      canInstall: available,
      notes: [],
      warning: null,
      localCommit: '',
      remoteCommit: '',
      error: null,
    }
  }

  /**
   * Read the update state, hitting GitHub at most once per TTL unless forced.
   * Overlapping callers share the same in-flight read.
   */
  async function check(checkOptions = {}) {
    const force = checkOptions.force === true
    if (inFlight !== null) return inFlight
    if (!force && state.checkedAt > 0 && now() - state.checkedAt < CHECK_TTL_MS && state.status === 'ready') return snapshot()
    inFlight = (async () => {
      state = { ...state, status: 'checking', error: null }
      try {
        const installed = await installedVersion()
        const mode = existsSync(join(pluginDir, '.git')) ? 'git' : 'package'
        const result = mode === 'git' ? await checkGit(installed) : await checkPackage(installed)
        state = {
          ...state,
          ...result,
          status: 'ready',
          mode,
          installedVersion: installed,
          checkedAt: now(),
          failedAt: 0,
          restartRequired: false,
        }
      } catch (error) {
        state = {
          ...state,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
          checkedAt: now(),
          failedAt: now(),
          available: false,
          canInstall: false,
        }
      } finally {
        inFlight = null
      }
      return snapshot()
    })()
    return inFlight
  }

  /** Install the linked checkout's fast-forward. */
  async function applyGit() {
    const origin = await gitText(pluginDir, ['remote', 'get-url', 'origin'])
    if (!origin.toLowerCase().includes(UPDATE_REPOSITORY)) {
      throw new Error(`origin is ${origin}; refusing to pull from it`)
    }
    const dirty = await gitText(pluginDir, ['status', '--porcelain', '--untracked-files=no'])
    if (dirty !== '') throw new Error('local changes block the update')
    const result = await git(pluginDir, ['pull', '--ff-only', 'origin', 'main'], GIT_PULL_TIMEOUT_MS)
    if (result.code !== 0) {
      const reason = (result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ')
      throw new Error(reason === '' ? `git pull exited with ${result.code}` : reason)
    }
    installedCache = null
  }

  /** Install the tarball update through the profile's pnpm. */
  async function applyPackage() {
    const pnpm = await findPnpmScript()
    if (pnpm === null) throw new Error('the bundled pnpm launcher was not found')
    const node = await findNodeBinary()
    const profileDir = profileDirFor(pluginDir)
    const result = await runCapture(node, [pnpm, 'update', 'dsh-expenses'], {
      cwd: profileDir,
      timeoutMs: PNPM_TIMEOUT_MS,
      env: process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: '1' },
    })
    if (result.code !== 0) {
      const reason = (result.stderr || result.stdout).trim().split('\n').slice(-4).join(' ')
      throw new Error(reason === '' ? `pnpm update exited with ${result.code}` : reason)
    }
    installedCache = null
  }

  /** Install the available update. Never called by the check itself. */
  async function apply() {
    const current = await check({ force: true })
    if (current.status !== 'ready') {
      return { ok: false, error: current.error ?? 'the update check failed', status: snapshot() }
    }
    if (!current.available) {
      return { ok: true, restartRequired: false, message: 'already-current', status: snapshot() }
    }
    if (current.dirty) {
      return { ok: false, error: 'local changes block the update', status: snapshot() }
    }
    try {
      if (current.mode === 'git') await applyGit()
      else await applyPackage()
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), status: snapshot() }
    }
    state = { ...state, restartRequired: true, checkedAt: 0, failedAt: 0 }
    try {
      await check({ force: true })
    } catch {
      // The files are already in place; a failed recheck only leaves the old numbers.
    }
    return { ok: true, restartRequired: true, message: 'installed', status: snapshot() }
  }

  return { check, apply, snapshot, pluginDir }
}

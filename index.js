/**
 * dsh-backup — Host half.
 *
 * Archives, into one time-named folder per day under a cloud-drive folder:
 *   - every stored DSH conversation (all workspaces, from DSH_HOME/sessions),
 *   - the files of every workspace those conversations belong to,
 *   - the installed plugin / app configuration of the current DSH profile.
 *
 * A second backup on the same day replaces the earlier one, so the cloud
 * folder always holds exactly one backup per day. The backup runs
 * automatically shortly after DSH starts (see `scheduleStartupBackup`), and the
 * settings panel can trigger it manually.
 *
 * The Host half also serves the small HTTP API consumed by the Client half
 * (`client.js`, a settings section): current backup state, the folder/provider
 * switches, and "open folder".
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { execFile, spawn } from 'node:child_process'

const PLUGIN_VERSION = '1.0.0'
const BACKUP_FOLDER_NAME = 'DeepSeek Harness备份'
const DAY_PREFIX = 'backup-'
const TEMP_PREFIX = '.dsh-backup-tmp-'
const STARTUP_DELAY_MS = 5000
const STATUS_ROUTE = '/api/dsh-backup/state'
const ACTION_ROUTE = '/api/dsh-backup/action'

const HOME = os.homedir()
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')
const PROFILE_NAME = process.env.DSH_PROFILE || 'desktop'
const PROFILE_DIR = process.env.DSH_PROFILE_DIR || path.join(DSH_HOME, 'profiles', PROFILE_NAME)
const STATE_DIR = path.join(DSH_HOME, 'dsh-backup')
const SETTINGS_PATH = path.join(STATE_DIR, 'settings.json')
const STATUS_PATH = path.join(STATE_DIR, 'status.json')

/**
 * The HTTP API is exposed through the host `connection` service. Declaring the
 * dependency makes cordis defer `apply` until that service exists. Without it a
 * bundle can be instantiated during boot before the connection plugin has
 * created the service, and the old early return then skipped both route
 * registration (the settings panel fetched "not found") and the startup backup.
 */
export const inject = ['connection']

/** Every cloud provider this plugin knows how to recognise. */
const PROVIDERS = [
  {
    id: 'huawei',
    name: '华为云盘',
    roots: [
      path.join(HOME, '华为云盘'),
      path.join(HOME, 'Huawei Cloud Drive'),
      path.join(HOME, 'HuaweiDrive'),
    ],
    // The drive can be relocated (e.g. `D:\华为云盘`), so every fixed drive is
    // also probed for these folder names.
    folderNames: ['华为云盘', 'Huawei Cloud Drive', 'HuaweiDrive'],
    processes: ['HuaweiDrive', 'HuaweiCloudDrive', 'HwCloudDrive', 'HuaweiCloud', 'HUAWEI Cloud', 'SyncService'],
    services: ['HWSyncService'],
  },
  {
    id: 'onedrive',
    name: 'OneDrive',
    roots: [path.join(HOME, 'OneDrive')],
    folderNames: ['OneDrive'],
    processes: ['OneDrive'],
    services: ['OneDrive.Sync.Service'],
  },
  {
    id: 'nutstore',
    name: '坚果云',
    roots: [
      path.join(HOME, 'Nutstore', '1', '我的坚果云'),
      path.join(HOME, 'Nutstore', '我的坚果云'),
      path.join(HOME, 'Nutstore'),
      path.join(HOME, '我的坚果云'),
    ],
    folderNames: ['我的坚果云', 'Nutstore'],
    processes: ['Nutstore', 'NutstoreClient'],
    services: ['NutstoreDriverSvc'],
  },
  {
    id: 'wps',
    name: 'WPS云盘',
    roots: [
      path.join(HOME, 'WPS Cloud Files'),
      path.join(HOME, 'WPSDrive'),
      path.join(HOME, 'WPS Cloud'),
    ],
    folderNames: ['WPS Cloud Files', 'WPSDrive'],
    processes: ['wpscloudsvr', 'wps', 'wpscloud'],
    services: ['wpscloudsvr'],
  },
  {
    id: 'baidu',
    name: '百度网盘',
    roots: [
      path.join(HOME, 'BaiduNetdiskWorkspace'),
      path.join(HOME, 'BaiduNetdisk'),
      path.join(HOME, '百度网盘'),
    ],
    folderNames: ['BaiduNetdisk', 'BaiduNetdiskWorkspace', '百度网盘'],
    processes: ['BaiduNetdisk', 'baidunetdisk', 'BaiduNetdiskHost'],
    services: [],
  },
]

const CUSTOM_PROVIDER = { id: 'custom', name: '自定义文件夹', roots: [], processes: [] }

const WORKSPACE_EXCLUDES = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.nuxt',
  '.cache',
  'dist',
  'build',
  'target',
  '.turbo',
]

const STAGE_LABELS = {
  preparing: '准备备份目录',
  flush: '刷新会话日志',
  conversations: '归档对话记录',
  workspaces: '归档工作区文件',
  config: '归档插件与应用配置',
  manifest: '生成备份清单',
  finishing: '写入每日备份文件夹',
}

/** Cross-instance guard: a plugin HMR reload must not start a second copy. */
const ENGINE_KEY = Symbol.for('dsh-backup.engine.v1')
const engine = globalThis[ENGINE_KEY] || (globalThis[ENGINE_KEY] = { running: false, processNamesAt: 0, processNames: [], servicesAt: 0, services: [] })
engine.routesRegistered = engine.routesRegistered || false

const STATE = {
  ctx: null,
  settings: null,
  status: {
    state: 'idle',
    reason: null,
    stage: null,
    stageLabel: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    progress: { files: 0, bytes: 0 },
    result: null,
    lastError: null,
  },
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function safeStatSync(target) {
  try {
    return fs.statSync(target)
  } catch {
    return null
  }
}

function exists(target) {
  return !!safeStatSync(target)
}

function isDir(target) {
  const stat = safeStatSync(target)
  return !!stat && stat.isDirectory()
}

function readJsonSync(target) {
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'))
  } catch {
    return null
  }
}

async function writeJsonAtomic(target, value) {
  await fsp.mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fsp.rename(tmp, target)
}

function pad(value) {
  return String(value).padStart(2, '0')
}

function dayStamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function timeStamp(date = new Date()) {
  return `${dayStamp(date)}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
}

function pathSlug(target) {
  return target.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'workspace'
}

function isInside(parent, child) {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
}

function providerById(id) {
  return PROVIDERS.find((provider) => provider.id === id) || CUSTOM_PROVIDER
}

/**
 * Cloud drives are often relocated: Huawei Cloud Drive can sit at
 * `D:\华为云盘`, Baidu Netdisk at `D:\BaiduNetdisk`, and so on. Both the
 * detection and the "where should the default backup folder go" logic probe
 * every fixed drive for the known folder names, not only the user profile.
 */
const DRIVE_LETTERS = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
let fixedDriveCache = { at: 0, roots: [] }

function fixedDriveRoots() {
  const now = Date.now()
  if (fixedDriveCache.roots.length > 0 && now - fixedDriveCache.at < 60000) return fixedDriveCache.roots
  const roots = []
  for (const letter of DRIVE_LETTERS) {
    const root = `${letter}:\\`
    if (exists(root)) roots.push(root)
  }
  fixedDriveCache = { at: now, roots }
  return roots
}

/** All candidate sync roots of a provider: profile locations + fixed drives. */
function providerRoots(provider) {
  const roots = provider.roots.slice()
  for (const drive of fixedDriveRoots()) {
    for (const folderName of provider.folderNames || []) {
      const candidate = path.join(drive, folderName)
      if (!roots.some((root) => samePath(root, candidate))) roots.push(candidate)
    }
  }
  return roots
}

function providerDetectedRoot(provider) {
  const existing = providerRoots(provider).filter((root) => exists(root))
  if (existing.length === 0) return null
  // A root that already holds our backup folder is definitely the live one. If
  // several do (a stale placeholder plus the relocated real drive), prefer the
  // one whose backup folder was written most recently.
  const withBackup = existing
    .map((root) => ({ root, stat: safeStatSync(path.join(root, BACKUP_FOLDER_NAME)) }))
    .filter((entry) => !!entry.stat)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
  if (withBackup.length > 0) return withBackup[0].root
  // Prefer a relocated drive over a stale/empty profile placeholder.
  const outsideHome = existing.find((root) => !isInside(HOME, root) && !samePath(HOME, root))
  if (outsideHome) return outsideHome
  return existing[0]
}

function defaultRootFor(providerId) {
  const provider = providerById(providerId)
  const root = providerDetectedRoot(provider)
  if (root) return path.join(root, BACKUP_FOLDER_NAME)
  const candidates = providerRoots(provider)
  if (candidates.length > 0) return path.join(candidates[0], BACKUP_FOLDER_NAME)
  return path.join(HOME, BACKUP_FOLDER_NAME)
}

function detectProviderForPath(target) {
  if (!target) return null
  let best = null
  for (const provider of PROVIDERS) {
    for (const root of providerRoots(provider)) {
      if (exists(root) && (samePath(target, root) || isInside(root, target))) {
        if (!best || root.length > best.root.length) best = { provider, root }
      }
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Settings (plugin-owned runtime state, kept out of the Loader config so a
// path/provider change never restarts the plugin)
// ---------------------------------------------------------------------------

function defaultSettings() {
  const provider = 'huawei'
  return {
    version: 1,
    provider,
    backupRoot: defaultRootFor(provider),
    autoBackup: true,
    workspaceExcludes: WORKSPACE_EXCLUDES.slice(),
    maxFileBytes: 0,
    updatedAt: null,
  }
}

function loadSettings() {
  if (STATE.settings) return STATE.settings
  const stored = readJsonSync(SETTINGS_PATH)
  const settings = { ...defaultSettings(), ...(stored && typeof stored === 'object' ? stored : {}) }
  if (!Array.isArray(settings.workspaceExcludes) || settings.workspaceExcludes.length === 0) {
    settings.workspaceExcludes = WORKSPACE_EXCLUDES.slice()
  }
  if (!settings.backupRoot || typeof settings.backupRoot !== 'string') {
    settings.backupRoot = defaultRootFor(settings.provider)
  } else {
    // The folder itself says which cloud drive it belongs to. A relocated drive
    // (e.g. `D:\华为云盘\DeepSeek Harness备份`) is matched even when the saved
    // provider was `custom`, so the panel shows the real sync state instead of
    // "仅本地保存".
    const detected = detectProviderForPath(settings.backupRoot)
    if (detected && detected.provider.id !== settings.provider) {
      settings.provider = detected.provider.id
      settings.updatedAt = new Date().toISOString()
      void writeJsonAtomic(SETTINGS_PATH, settings).catch(() => {})
    }
  }
  STATE.settings = settings
  return settings
}

async function saveSettings(patch) {
  const settings = { ...loadSettings(), ...patch, updatedAt: new Date().toISOString() }
  STATE.settings = settings
  await writeJsonAtomic(SETTINGS_PATH, settings)
  return settings
}

function publicSettings() {
  const settings = loadSettings()
  const provider = providerById(settings.provider)
  return {
    provider: provider.id,
    providerName: provider.name,
    backupRoot: settings.backupRoot,
    autoBackup: settings.autoBackup !== false,
    workspaceExcludes: settings.workspaceExcludes,
    maxFileBytes: settings.maxFileBytes || 0,
  }
}

// ---------------------------------------------------------------------------
// Status persistence
// ---------------------------------------------------------------------------

function statusFilePathStatus() {
  const stored = readJsonSync(STATUS_PATH)
  if (!stored || typeof stored !== 'object' || !stored.status) return null
  if (stored.status.state === 'running') {
    // Previous process died mid-backup.
    stored.status = {
      ...stored.status,
      state: 'error',
      stage: null,
      stageLabel: null,
      lastError: '上一次备份未正常结束（DSH 在备份过程中退出）',
      finishedAt: stored.status.startedAt || Date.now(),
    }
  }
  return stored.status
}

async function persistStatus() {
  try {
    await writeJsonAtomic(STATUS_PATH, { status: STATE.status, savedAt: Date.now() })
  } catch {
    // Status persistence is best-effort only.
  }
}

const RUNTIME_PATH = path.join(STATE_DIR, 'runtime.json')

/** Diagnostics: proves whether the Host half found the connection service and
 * registered its HTTP routes in the currently running DSH process. */
function recordRuntime(patch) {
  const current = readJsonSync(RUNTIME_PATH) || {}
  const next = { ...current, ...patch, pluginVersion: PLUGIN_VERSION, updatedAt: Date.now() }
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(RUNTIME_PATH, JSON.stringify(next, null, 2))
  } catch {
    // Diagnostics are best-effort only.
  }
}

function setStage(stage, progressPatch) {
  STATE.status.stage = stage
  STATE.status.stageLabel = STAGE_LABELS[stage] || stage
  if (progressPatch) Object.assign(STATE.status.progress, progressPatch)
}

function bumpProgress(stats) {
  STATE.status.progress = { files: stats.files, bytes: stats.bytes }
}

function publicStatus() {
  const status = STATE.status
  return {
    state: status.state,
    reason: status.reason,
    stage: status.stage,
    stageLabel: status.stageLabel,
    startedAt: status.startedAt,
    finishedAt: status.finishedAt,
    durationMs: status.durationMs,
    progress: { ...status.progress },
    result: status.result,
    lastError: status.lastError,
  }
}

// ---------------------------------------------------------------------------
// Cloud / process detection
// ---------------------------------------------------------------------------

async function runningProcessNames() {
  const now = Date.now()
  if (engine.processNames && now - engine.processNamesAt < 30000) return engine.processNames
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (error, out) => {
        if (error) reject(error)
        else resolve(String(out || ''))
      })
    })
    const names = []
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^"([^"]+)"/.exec(line)
      if (match) names.push(match[1].toLowerCase().replace(/\.exe$/, ''))
    }
    engine.processNames = names
    engine.processNamesAt = now
    return names
  } catch {
    engine.processNames = []
    engine.processNamesAt = now
    return []
  }
}

async function runningServiceNames() {
  const now = Date.now()
  if (engine.services && now - engine.servicesAt < 30000) return engine.services
  const names = new Set()
  const candidates = [...new Set(PROVIDERS.flatMap((provider) => provider.services || []))]
  await Promise.all(
    candidates.map(
      (name) =>
        new Promise((resolve) => {
          execFile('sc.exe', ['query', name], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
            if (!error && /STATE\s*:\s*4\b/i.test(String(stdout || ''))) names.add(name.toLowerCase())
            resolve(null)
          })
        }),
    ),
  )
  engine.services = [...names]
  engine.servicesAt = now
  return engine.services
}

function providerClientRunning(provider, processNames, serviceNames) {
  if (!provider || provider.id === 'custom') return false
  if (Array.isArray(processNames) && processNames.length > 0) {
    if (provider.processes.some((name) => processNames.includes(name.toLowerCase()))) return true
  }
  if (Array.isArray(serviceNames) && serviceNames.length > 0) {
    if ((provider.services || []).some((name) => serviceNames.includes(name.toLowerCase()))) return true
  }
  return false
}

async function detectionSnapshot() {
  const [processNames, serviceNames] = await Promise.all([runningProcessNames(), runningServiceNames()])
  const out = {}
  for (const provider of PROVIDERS) {
    out[provider.id] = {
      root: providerDetectedRoot(provider),
      candidates: providerRoots(provider),
      running: providerClientRunning(provider, processNames, serviceNames),
    }
  }
  out.custom = { root: null, candidates: [], running: false }
  return out
}

async function cloudSnapshot(settings, detection) {
  const provider = providerById(settings.provider)
  if (provider.id === 'custom') {
    return {
      provider: 'custom',
      providerName: provider.name,
      syncState: 'local',
      label: '仅本地保存',
      detail: '备份文件夹是自定义目录，未与任何云盘同步客户端关联。',
      clientRunning: false,
      inCloudFolder: false,
      providerRoot: null,
    }
  }
  const info = detection[provider.id] || { root: null, running: false }
  const inCloudFolder = !!info.root && (samePath(settings.backupRoot, info.root) || isInside(info.root, settings.backupRoot))
  if (!inCloudFolder) {
    return {
      provider: provider.id,
      providerName: provider.name,
      syncState: 'local',
      label: '未同步到云盘',
      detail: `备份文件夹不在${provider.name}的同步目录内，当前只保存在本地磁盘。`,
      clientRunning: info.running,
      inCloudFolder: false,
      providerRoot: info.root,
    }
  }
  if (!info.running) {
    return {
      provider: provider.id,
      providerName: provider.name,
      syncState: 'pending',
      label: '待同步',
      detail: `备份已写入${provider.name}同步目录，但未检测到${provider.name}客户端在运行，云盘暂时不会上传。`,
      clientRunning: false,
      inCloudFolder: true,
      providerRoot: info.root,
    }
  }
  return {
    provider: provider.id,
    providerName: provider.name,
    syncState: 'synced',
    label: '已同步到云盘',
    detail: `${provider.name}客户端正在运行，备份位于同步目录内，将自动上传到云端。`,
    clientRunning: true,
    inCloudFolder: true,
    providerRoot: info.root,
  }
}

// ---------------------------------------------------------------------------
// Copy engine
// ---------------------------------------------------------------------------

/**
 * Recursively copy `src` into `dest`, counting files and bytes.
 * Symlinks/reparse points are skipped (cloud-drive junctions must never be
 * followed), as are excluded directory names and anything under `avoidDirs`.
 */
async function copyTree(src, dest, options = {}) {
  const excludes = new Set((options.excludes || []).map((name) => name.toLowerCase()))
  const avoidDirs = (options.avoidDirs || []).filter(Boolean).map((entry) => path.resolve(entry).toLowerCase())
  const maxFileBytes = options.maxFileBytes || 0
  const onProgress = options.onProgress
  const stats = { files: 0, dirs: 0, bytes: 0, skipped: 0, errors: [] }

  async function walk(from, to, depth) {
    let entries
    try {
      entries = await fsp.readdir(from, { withFileTypes: true })
    } catch (error) {
      stats.errors.push({ path: from, error: error.code || String(error) })
      return
    }
    try {
      await fsp.mkdir(to, { recursive: true })
    } catch (error) {
      stats.errors.push({ path: to, error: error.code || String(error) })
      return
    }
    stats.dirs += 1
    for (const entry of entries) {
      const name = entry.name
      if (excludes.has(name.toLowerCase())) {
        stats.skipped += 1
        continue
      }
      const source = path.join(from, name)
      const target = path.join(to, name)
      const sourceLower = source.toLowerCase()
      if (avoidDirs.some((avoid) => samePath(sourceLower, avoid) || isInside(avoid, sourceLower))) {
        stats.skipped += 1
        continue
      }
      let stat
      try {
        stat = await fsp.lstat(source)
      } catch {
        stats.skipped += 1
        continue
      }
      if (stat.isSymbolicLink()) {
        stats.skipped += 1
        continue
      }
      if (stat.isDirectory()) {
        if (depth >= 24) {
          stats.skipped += 1
          continue
        }
        await walk(source, target, depth + 1)
      } else if (stat.isFile()) {
        if (maxFileBytes > 0 && stat.size > maxFileBytes) {
          stats.skipped += 1
          continue
        }
        try {
          await fsp.copyFile(source, target)
          stats.files += 1
          stats.bytes += stat.size
          if (onProgress) onProgress(stats)
        } catch (error) {
          stats.errors.push({ path: source, error: error.code || String(error) })
        }
      }
    }
  }

  if (isDir(src)) await walk(src, dest, 0)
  return stats
}

async function copyFileIfExists(src, dest) {
  try {
    const stat = await fsp.stat(src)
    if (!stat.isFile()) return { files: 0, bytes: 0 }
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    await fsp.copyFile(src, dest)
    return { files: 1, bytes: stat.size }
  } catch {
    return { files: 0, bytes: 0 }
  }
}

// ---------------------------------------------------------------------------
// Session / workspace discovery
// ---------------------------------------------------------------------------

/** Read the session header line from a stored session directory (cwd, createdAt, id). */
function sessionHeaderFromDisk(sessionDir) {
  try {
    const names = fs.readdirSync(sessionDir)
    const file = names.find((name) => name.endsWith('.jsonl.zstd')) || names.find((name) => name.endsWith('.jsonl'))
    if (!file) return null
    const buffer = fs.readFileSync(path.join(sessionDir, file))
    const text = file.endsWith('.zstd') && typeof zlib.zstdDecompressSync === 'function'
      ? zlib.zstdDecompressSync(buffer).toString('utf8')
      : buffer.toString('utf8')
    const newline = text.indexOf('\n')
    const firstLine = newline > 0 ? text.slice(0, newline) : text.slice(0, 4096)
    const header = JSON.parse(firstLine)
    return {
      id: typeof header.id === 'string' ? header.id : null,
      cwd: typeof header.cwd === 'string' && header.cwd ? header.cwd : null,
      createdAt: typeof header.createdAt === 'number' ? header.createdAt : null,
      parentSession: typeof header.parentSession === 'string' ? header.parentSession : null,
    }
  } catch {
    return null
  }
}

/** Scan the on-disk layout `sessions/<workspace-key>/session-<id>/`. */
async function scanSessionsOnDisk() {
  const found = []
  const sessionsRoot = path.join(DSH_HOME, 'sessions')
  let workspaceKeys = []
  try {
    workspaceKeys = await fsp.readdir(sessionsRoot)
  } catch {
    return found
  }
  for (const workspaceKey of workspaceKeys) {
    const workspaceDir = path.join(sessionsRoot, workspaceKey)
    if (!isDir(workspaceDir)) continue
    let sessionDirNames = []
    try {
      sessionDirNames = await fsp.readdir(workspaceDir)
    } catch {
      continue
    }
    for (const sessionDirName of sessionDirNames) {
      const sessionDir = path.join(workspaceDir, sessionDirName)
      if (!isDir(sessionDir)) continue
      const header = sessionHeaderFromDisk(sessionDir)
      const stat = await fsp.stat(sessionDir).catch(() => null)
      found.push({
        id: (header && header.id) || sessionDirName,
        cwd: header ? header.cwd : null,
        createdAt: (header && header.createdAt) || (stat ? Math.round(stat.mtimeMs) : null),
        parentSession: header ? header.parentSession : null,
        isSeeded: false,
        eventCount: null,
        sizeBytes: null,
        location: sessionDir,
      })
    }
  }
  return found
}

/**
 * Every stored conversation. The persistence service knows the live sessions,
 * the disk scan knows the archived ones, so the two sources are merged (and the
 * disk header fills in a missing `cwd`, which drives workspace discovery).
 */
async function listSessions() {
  const ctx = STATE.ctx
  const service = ctx && typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : null
  const merged = []
  if (service && typeof service.list === 'function') {
    try {
      const snapshots = await service.list()
      for (const snapshot of snapshots || []) {
        const header = snapshot.header || {}
        merged.push({
          id: header.id,
          cwd: header.cwd || null,
          createdAt: header.createdAt || null,
          parentSession: header.parentSession || null,
          isSeeded: header.isSeeded === true,
          eventCount: typeof snapshot.eventCount === 'number' ? snapshot.eventCount : null,
          sizeBytes: typeof snapshot.sizeBytes === 'number' ? snapshot.sizeBytes : null,
          location: snapshot.location && snapshot.location.path ? snapshot.location.path : null,
        })
      }
    } catch {
      // fall through to the disk scan
    }
  }
  const disk = await scanSessionsOnDisk()
  for (const session of disk) {
    const existing = merged.find((item) => item.id === session.id)
      || (session.location ? merged.find((item) => item.location && samePath(item.location, session.location)) : null)
    if (!existing) {
      merged.push(session)
      continue
    }
    if (!existing.cwd && session.cwd) existing.cwd = session.cwd
    if (!existing.createdAt && session.createdAt) existing.createdAt = session.createdAt
    if (!existing.location && session.location) existing.location = session.location
  }
  return merged
}

function workspaceRootsFromSessions(sessions) {
  const roots = []
  for (const session of sessions) {
    if (!session.cwd || typeof session.cwd !== 'string') continue
    if (!isDir(session.cwd)) continue
    if (!roots.some((root) => samePath(root, session.cwd))) roots.push(session.cwd)
  }
  return roots
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

async function readPluginInventory() {
  const profilePackage = readJsonSync(path.join(PROFILE_DIR, 'package.json')) || {}
  const dsh = profilePackage.dsh && typeof profilePackage.dsh === 'object' ? profilePackage.dsh : {}
  const profile = dsh.profile && typeof dsh.profile === 'object' ? dsh.profile : {}
  const dependencies = profilePackage.dependencies && typeof profilePackage.dependencies === 'object' ? profilePackage.dependencies : {}
  let installed = []
  try {
    const managerDir = path.join(PROFILE_DIR, '.plugin-manager')
    installed = (await fsp.readdir(managerDir)).filter((name) => !name.startsWith('.')).slice(0, 200)
  } catch {
    installed = []
  }
  return {
    profile: PROFILE_NAME,
    profileName: profilePackage.name || null,
    bundles: Array.isArray(profile.bundles) ? profile.bundles : [],
    dependencies,
    pluginManagerEntries: installed,
  }
}

async function backupProfileConfig(targetDir) {
  const stats = { files: 0, bytes: 0, errors: [] }
  const merge = (result) => {
    stats.files += result.files || 0
    stats.bytes += result.bytes || 0
    if (result.errors) stats.errors.push(...result.errors)
  }
  const profileFiles = ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', '.npmrc']
  for (const name of profileFiles) {
    merge(await copyFileIfExists(path.join(PROFILE_DIR, name), path.join(targetDir, 'profile', name)))
  }
  const profileDirs = ['.plugin-manager', '.dsh-market']
  for (const name of profileDirs) {
    const source = path.join(PROFILE_DIR, name)
    if (!isDir(source)) continue
    merge(await copyTree(source, path.join(targetDir, 'profile', name), {
      excludes: ['node_modules', '.cache', 'tmp', 'logs'],
    }))
  }
  // DSH home level configuration: *.json / *.yml / *.yaml plus selected dirs.
  let homeEntries = []
  try {
    homeEntries = await fsp.readdir(DSH_HOME, { withFileTypes: true })
  } catch {
    homeEntries = []
  }
  const skippedHomeFiles = new Set(['.credentials.yaml', '.credentials.yml', '.credentials.json'])
  for (const entry of homeEntries) {
    if (!entry.isFile()) continue
    if (skippedHomeFiles.has(entry.name.toLowerCase())) continue
    if (!/\.(json|ya?ml)$/i.test(entry.name)) continue
    merge(await copyFileIfExists(path.join(DSH_HOME, entry.name), path.join(targetDir, 'home', entry.name)))
  }
  for (const name of ['storages', 'dsh-market']) {
    const source = path.join(DSH_HOME, name)
    if (!isDir(source)) continue
    merge(await copyTree(source, path.join(targetDir, 'home', name), { excludes: ['node_modules', '.cache', 'tmp'] }))
  }
  merge(await writeTextFile(path.join(targetDir, 'profile-inventory.json'), JSON.stringify(await readPluginInventory(), null, 2)))
  return stats
}

async function writeTextFile(target, content) {
  try {
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, content, 'utf8')
    return { files: 1, bytes: Buffer.byteLength(content, 'utf8') }
  } catch (error) {
    return { files: 0, bytes: 0, errors: [{ path: target, error: String(error) }] }
  }
}

async function removeStaleFolders(rootBase, keepName) {
  let entries = []
  try {
    entries = await fsp.readdir(rootBase, { withFileTypes: true })
  } catch {
    return []
  }
  const today = dayStamp()
  const todayPrefix = `${DAY_PREFIX}${today}`
  const removed = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (keepName && entry.name === keepName) continue
    const isToday = entry.name.startsWith(todayPrefix)
    const isTemp = entry.name.startsWith(TEMP_PREFIX)
    if (!isToday && !isTemp) continue
    try {
      await fsp.rm(path.join(rootBase, entry.name), { recursive: true, force: true })
      removed.push(entry.name)
    } catch {
      // A locked folder is reported through the final stats instead of aborting.
    }
  }
  return removed
}

async function runBackup(ctx, reason) {
  if (engine.running) return publicStatus()
  engine.running = true
  STATE.ctx = ctx
  const settings = loadSettings()
  const startedAt = Date.now()
  const startedDate = new Date()

  STATE.status = {
    state: 'running',
    reason: reason || 'manual',
    stage: 'preparing',
    stageLabel: STAGE_LABELS.preparing,
    startedAt,
    finishedAt: null,
    durationMs: null,
    progress: { files: 0, bytes: 0 },
    result: null,
    lastError: null,
  }
  void persistStatus()

  const rootBase = settings.backupRoot
  const folderName = `${DAY_PREFIX}${timeStamp(startedDate)}`
  const tempDir = path.join(rootBase, `${TEMP_PREFIX}${process.pid}-${startedAt}`)
  const finalDir = path.join(rootBase, folderName)

  try {
    await fsp.mkdir(rootBase, { recursive: true })

    // Durability barrier so the copies below include the newest session events.
    setStage('flush')
    const persistence = typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : null
    if (persistence && typeof persistence.flush === 'function') {
      try {
        await persistence.flush()
      } catch {
        // A session owned elsewhere may fail to flush; the copy still proceeds.
      }
    }

    const sessions = await listSessions()
    const workspaceRoots = workspaceRootsFromSessions(sessions)

    await fsp.rm(tempDir, { recursive: true, force: true })
    await fsp.mkdir(tempDir, { recursive: true })

    // 1) Conversations — every stored session of every workspace.
    setStage('conversations')
    const conversationsStats = await copyTree(path.join(DSH_HOME, 'sessions'), path.join(tempDir, 'conversations'), {
      onProgress: bumpProgress,
    })
    await writeTextFile(path.join(tempDir, 'conversations', 'index.json'), JSON.stringify(sessions, null, 2))

    // 2) Workspace files.
    setStage('workspaces')
    const workspaceStats = []
    for (const root of workspaceRoots) {
      const folder = pathSlug(root)
      const stats = await copyTree(root, path.join(tempDir, 'workspaces', folder), {
        excludes: settings.workspaceExcludes,
        avoidDirs: [rootBase, finalDir, tempDir],
        maxFileBytes: settings.maxFileBytes || 0,
        onProgress: bumpProgress,
      })
      workspaceStats.push({
        root,
        folder,
        files: stats.files,
        bytes: stats.bytes,
        skipped: stats.skipped,
        errors: stats.errors.slice(0, 20),
      })
    }

    // 3) Plugin / app configuration.
    setStage('config')
    const configStats = await backupProfileConfig(path.join(tempDir, 'dsh-config'))

    // 4) Manifest + human-readable README.
    setStage('manifest')
    const totalFiles = conversationsStats.files + workspaceStats.reduce((sum, item) => sum + item.files, 0) + configStats.files
    const totalBytes = conversationsStats.bytes + workspaceStats.reduce((sum, item) => sum + item.bytes, 0) + configStats.bytes
    const pluginInventory = await readPluginInventory()
    const manifest = {
      format: 'dsh-backup',
      version: 1,
      pluginVersion: PLUGIN_VERSION,
      generatedAt: startedDate.toISOString(),
      generatedAtMs: startedAt,
      reason,
      day: dayStamp(startedDate),
      folderName,
      source: {
        dshHome: DSH_HOME,
        profile: PROFILE_NAME,
        profileDir: PROFILE_DIR,
        workspaceRoots,
        platform: process.platform,
        node: process.version,
      },
      provider: {
        id: settings.provider,
        name: providerById(settings.provider).name,
        root: rootBase,
      },
      contents: {
        conversations: {
          sessions: sessions.length,
          files: conversationsStats.files,
          bytes: conversationsStats.bytes,
          errors: conversationsStats.errors.slice(0, 20),
        },
        workspaces: workspaceStats,
        config: {
          files: configStats.files,
          bytes: configStats.bytes,
          errors: (configStats.errors || []).slice(0, 20),
        },
        plugins: pluginInventory,
      },
      excludes: {
        workspace: settings.workspaceExcludes,
        skippedHomeSecrets: ['.credentials.yaml'],
      },
      totals: { files: totalFiles, bytes: totalBytes },
    }
    await writeTextFile(path.join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    await writeTextFile(path.join(tempDir, 'README.txt'), backupReadme(manifest))

    // 5) Replace today's earlier backup with this one.
    setStage('finishing')
    const removed = await removeStaleFolders(rootBase, path.basename(tempDir))
    await fsp.rename(tempDir, finalDir)

    STATE.status = {
      state: 'success',
      reason,
      stage: 'done',
      stageLabel: '备份完成',
      startedAt,
      finishedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      progress: { files: totalFiles, bytes: totalBytes },
      result: {
        folderName,
        folderPath: finalDir,
        day: dayStamp(startedDate),
        provider: settings.provider,
        providerName: providerById(settings.provider).name,
        counts: {
          sessions: sessions.length,
          workspaces: workspaceRoots.length,
          files: totalFiles,
          bytes: totalBytes,
          conversations: conversationsStats.files,
          config: configStats.files,
        },
        workspaceRoots,
        replaced: removed,
      },
      lastError: null,
    }
  } catch (error) {
    STATE.status = {
      state: 'error',
      reason,
      stage: STATE.status.stage,
      stageLabel: STATE.status.stageLabel,
      startedAt,
      finishedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      progress: { ...STATE.status.progress },
      result: null,
      lastError: error && error.message ? String(error.message) : String(error),
    }
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  } finally {
    engine.running = false
    await persistStatus()
  }
  return publicStatus()
}

function backupReadme(manifest) {
  return [
    'DeepSeek Harness 备份',
    '====================',
    '',
    `生成时间：${new Date(manifest.generatedAtMs).toLocaleString('zh-CN')}`,
    `备份方式：${manifest.reason === 'startup' ? 'DSH 启动时自动备份' : '手动备份'}`,
    `DSH 配置目录：${manifest.source.dshHome}`,
    `配置档案（profile）：${manifest.source.profile}`,
    '',
    '目录内容：',
    '  conversations/   所有工作区的 DSH 对话记录（sessions 原始文件）与 index.json',
    `  workspaces/      工作区文件快照（${manifest.contents.workspaces.length} 个工作区）`,
    '  dsh-config/      当前 profile 的插件清单、cordis 配置、应用配置、storages',
    '  manifest.json    完整的备份清单（可机器读取）',
    '',
    `总文件数：${manifest.totals.files}，总大小：${(manifest.totals.bytes / 1024 / 1024).toFixed(2)} MB`,
    '',
    '说明：',
    '  * 同一天再次备份会删除并替换当天已有的备份文件夹，每天只保留一份。',
    '  * 工作区备份会跳过 node_modules、.git、dist 等依赖/构建目录。',
    '  * 出于安全考虑，.credentials.yaml 等密钥文件不会被备份。',
    '  * 恢复时把 conversations/ 放回 DSH 的 sessions 目录，把 dsh-config/profile/ 中的文件放回 profile 目录即可。',
    '',
  ].join('\n')
}

function scheduleStartupBackup(ctx) {
  const settings = loadSettings()
  if (settings.autoBackup === false) return
  const timer = setTimeout(() => {
    runBackup(ctx, 'startup').catch(() => {})
  }, STARTUP_DELAY_MS)
  if (typeof timer.unref === 'function') timer.unref()
  ctx.effect(() => () => clearTimeout(timer), 'startup-backup')
}

// ---------------------------------------------------------------------------
// Snapshot for the client
// ---------------------------------------------------------------------------

async function latestFolderSnapshot(settings) {
  const rootBase = settings.backupRoot
  const snapshot = {
    root: rootBase,
    rootExists: isDir(rootBase),
    todayName: `${DAY_PREFIX}${dayStamp()}`,
    entries: [],
    latest: null,
  }
  if (!snapshot.rootExists) return snapshot
  let entries = []
  try {
    entries = await fsp.readdir(rootBase, { withFileTypes: true })
  } catch {
    return snapshot
  }
  const days = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(DAY_PREFIX))
    .map((entry) => entry.name)
    .sort()
    .reverse()
  snapshot.entries = days.slice(0, 6)
  const latestName = days[0]
  if (latestName) {
    const folderPath = path.join(rootBase, latestName)
    const manifest = readJsonSync(path.join(folderPath, 'manifest.json'))
    const stat = safeStatSync(folderPath)
    snapshot.latest = {
      name: latestName,
      path: folderPath,
      createdAt: manifest && manifest.generatedAtMs ? manifest.generatedAtMs : stat ? Math.round(stat.mtimeMs) : null,
      counts: manifest && manifest.totals ? manifest.totals : null,
      isToday: latestName.startsWith(snapshot.todayName),
    }
  }
  return snapshot
}

async function buildSnapshot() {
  const settings = loadSettings()
  const detection = await detectionSnapshot()
  const cloud = await cloudSnapshot(settings, detection)
  const folder = await latestFolderSnapshot(settings)
  const sessions = await listSessions()
  return {
    ok: true,
    plugin: { name: 'dsh-backup', version: PLUGIN_VERSION },
    now: Date.now(),
    settings: publicSettings(),
    status: publicStatus(),
    cloud,
    folder,
    detection,
    providers: [...PROVIDERS.map((provider) => ({ id: provider.id, name: provider.name })), { id: 'custom', name: CUSTOM_PROVIDER.name }],
    sessions: {
      count: sessions.length,
      workspaces: workspaceRootsFromSessions(sessions),
    },
    startupBackup: settings.autoBackup !== false,
    rules: {
      folderName: BACKUP_FOLDER_NAME,
      sameDayOverwrite: true,
    },
  }
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function openFolder(target) {
  try {
    const child = spawn('explorer.exe', [target], { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    return true
  } catch {
    return false
  }
}

async function handleAction(ctx, body) {
  const op = body && typeof body.op === 'string' ? body.op : ''
  const payload = body && typeof body.payload === 'object' && body.payload ? body.payload : {}
  const settings = loadSettings()

  if (op === 'backup') {
    void runBackup(ctx, 'manual').catch(() => {})
    return { ok: true, message: '已开始备份' }
  }

  if (op === 'setProvider') {
    const provider = PROVIDERS.find((item) => item.id === payload.provider)
    if (!provider) return { ok: false, error: '未知的云盘类型' }
    const detected = providerDetectedRoot(provider)
    const patch = { provider: provider.id }
    let message = `已切换到${provider.name}`
    if (detected) {
      patch.backupRoot = path.join(detected, BACKUP_FOLDER_NAME)
      message += `，备份位置：${patch.backupRoot}`
    } else {
      message += `，但未检测到${provider.name}的同步目录，请用“更改备份文件夹”手动选择`
    }
    await saveSettings(patch)
    return { ok: true, message }
  }

  if (op === 'pickFolder') {
    const picker = typeof ctx.get === 'function' ? ctx.get('directoryPickerController') : null
    if (!picker || typeof picker.pick !== 'function') {
      return { ok: false, error: '当前运行环境不支持选择文件夹' }
    }
    let chosen = null
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000)
      chosen = await picker.pick(controller.signal)
      clearTimeout(timer)
    } catch (error) {
      return {
        ok: false,
        error: `打开文件夹选择器失败：${error && error.message ? error.message : String(error)}；可以改用“手动填写路径”直接输入`,
      }
    }
    if (!chosen) return { ok: true, message: '已取消选择' }
    const detected = detectProviderForPath(chosen)
    await saveSettings({ backupRoot: chosen, provider: detected ? detected.provider.id : 'custom' })
    return {
      ok: true,
      message: detected ? `备份文件夹已更改为 ${chosen}（${detected.provider.name}）` : `备份文件夹已更改为 ${chosen}`,
    }
  }

  if (op === 'setFolder') {
    const raw = typeof payload.path === 'string' ? payload.path.trim().replace(/^["']|["']$/g, '') : ''
    if (!raw) return { ok: false, error: '请输入备份文件夹的完整路径' }
    const target = path.resolve(raw)
    if (!path.isAbsolute(target)) {
      return { ok: false, error: '请填写绝对路径，例如 C:\\Users\\<用户名>\\OneDrive\\DeepSeek Harness备份' }
    }
    try {
      await fsp.mkdir(target, { recursive: true })
    } catch (error) {
      return { ok: false, error: `无法创建该文件夹：${error && error.message ? error.message : String(error)}` }
    }
    const probe = path.join(target, `.dsh-backup-write-probe-${process.pid}-${Date.now()}`)
    try {
      await fsp.writeFile(probe, 'ok', 'utf8')
      await fsp.rm(probe, { force: true })
    } catch (error) {
      return { ok: false, error: `该文件夹不可写入：${error && error.message ? error.message : String(error)}` }
    }
    const detected = detectProviderForPath(target)
    await saveSettings({ backupRoot: target, provider: detected ? detected.provider.id : 'custom' })
    return {
      ok: true,
      message: detected
        ? `备份文件夹已更改为 ${target}（${detected.provider.name}）`
        : `备份文件夹已更改为 ${target}（自定义文件夹）`,
    }
  }

  if (op === 'resetFolder') {
    const root = defaultRootFor(settings.provider)
    await saveSettings({ backupRoot: root })
    return { ok: true, message: `备份文件夹已恢复为 ${root}` }
  }

  if (op === 'setAutoBackup') {
    const enabled = payload.enabled !== false
    await saveSettings({ autoBackup: enabled })
    return { ok: true, message: enabled ? '已开启启动时自动备份' : '已关闭启动时自动备份' }
  }

  if (op === 'openFolder') {
    const which = payload.which === 'latest' ? 'latest' : 'root'
    if (which === 'latest') {
      const folder = await latestFolderSnapshot(settings)
      if (!folder.latest) return { ok: false, error: '还没有可打开的备份文件夹' }
      openFolder(folder.latest.path)
      return { ok: true, message: '已在资源管理器中打开最近一次备份' }
    }
    await fsp.mkdir(settings.backupRoot, { recursive: true }).catch(() => {})
    openFolder(settings.backupRoot)
    return { ok: true, message: '已在资源管理器中打开备份文件夹' }
  }

  return { ok: false, error: `未知操作：${op}` }
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  STATE.ctx = ctx

  const storedStatus = statusFilePathStatus()
  if (storedStatus && STATE.status.state === 'idle') STATE.status = storedStatus

  loadSettings()
  // Materialize settings.json on first run so it is inspectable/editable on disk.
  if (!exists(SETTINGS_PATH)) void saveSettings({}).catch(() => {})

  // Start the startup backup before touching optional services: archiving the
  // workspace must work even if the HTTP API below cannot be registered.
  scheduleStartupBackup(ctx)

  const routes = [
    {
      path: STATUS_ROUTE,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          return jsonResponse(200, await buildSnapshot())
        } catch (error) {
          return jsonResponse(500, { ok: false, error: error && error.message ? error.message : String(error) })
        }
      },
    },
    {
      path: ACTION_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          let body = null
          try {
            body = await request.json()
          } catch {
            body = null
          }
          const result = await handleAction(ctx, body)
          const snapshot = await buildSnapshot()
          return jsonResponse(200, { ...result, snapshot })
        } catch (error) {
          return jsonResponse(500, { ok: false, error: error && error.message ? error.message : String(error) })
        }
      },
    },
  ]

  const getConnection = () => {
    const candidate = typeof ctx.get === 'function' ? ctx.get('connection') : null
    if (candidate && candidate.fetch && typeof candidate.fetch.register === 'function') return candidate
    return null
  }

  let registered = false
  const registerRoutes = (connection) => {
    if (registered) return
    registered = true
    const disposers = []
    ctx.effect(() => {
      const okPaths = []
      for (const route of routes) {
        try {
          disposers.push(connection.fetch.register(route))
          okPaths.push(route.path)
        } catch {
          // A duplicate registration after HMR must not break the plugin.
        }
      }
      recordRuntime({ routesRegistered: true, routesRegisteredAt: Date.now(), routes: okPaths })
      return async () => {
        await Promise.allSettled(disposers.map((dispose) => Promise.resolve().then(() => dispose())))
      }
    }, 'routes')
  }

  recordRuntime({ applyAt: Date.now(), dshHome: DSH_HOME, profileDir: PROFILE_DIR })
  const readyConnection = getConnection()
  if (readyConnection) {
    recordRuntime({ connectionReady: true })
    registerRoutes(readyConnection)
  } else {
    // `inject` normally guarantees the service. As a safety net (for a host
    // that starts the connection service late) keep probing briefly so the
    // settings panel recovers on its own instead of showing "not found" until
    // the next restart.
    recordRuntime({ connectionReady: false })
    console.warn('[dsh-backup] connection service not ready yet; waiting for it')
    let tries = 0
    const timer = setInterval(() => {
      tries += 1
      const connection = getConnection()
      if (connection) {
        clearInterval(timer)
        recordRuntime({ connectionReady: true, connectionWaitMs: tries * 1000 })
        registerRoutes(connection)
      } else if (tries >= 60) {
        clearInterval(timer)
        console.warn('[dsh-backup] connection service never became available; HTTP API disabled')
      }
    }, 1000)
    if (typeof timer.unref === 'function') timer.unref()
  }
}
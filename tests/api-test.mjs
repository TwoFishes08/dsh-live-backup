// Standalone harness: exercises the dsh-backup HTTP surface (the same routes the
// settings page calls) through a fake Context that captures route handlers.
// Run from the package root: node tests/api-test.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const SETTINGS_PATH = path.join(DSH_HOME, 'dsh-backup', 'settings.json')

const routes = new Map()
const fakeCtx = {
  get(name) {
    if (name === 'connection') {
      return {
        fetch: {
          register(route) {
            routes.set(route.path, route)
            return async () => {}
          },
        },
      }
    }
    if (name === 'sessionPersistence') return { flush: async () => {} }
    return null
  },
  effect(fn) {
    try {
      fn()
    } catch {}
    return () => {}
  },
  log: console,
  fiber: { entry: { id: 'dsh-backup-test' } },
}

const mod = await import('../index.js')
mod.apply(fakeCtx, {})

const stateRoute = routes.get('/api/dsh-backup/state')
const actionRoute = routes.get('/api/dsh-backup/action')
if (!stateRoute || !actionRoute) {
  console.log('ROUTES_MISSING', [...routes.keys()])
  process.exit(1)
}

const getState = async () => JSON.parse(await (await stateRoute.fetch(new Request('http://x/api/dsh-backup/state'))).text())
const act = async (op, payload) => {
  const response = await actionRoute.fetch(new Request('http://x/api/dsh-backup/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op, payload: payload || {} }),
  }))
  return JSON.parse(await response.text())
}
const show = (label, value) => console.log(label + '=' + JSON.stringify(value))

const snap = await getState()
const original = snap.settings
show('STATE_OK', snap.ok)
show('PROVIDERS', (snap.providers || []).map((p) => p.id))
show('SETTINGS', original)
show('CLOUD', snap.cloud)
show('FOLDER', { root: snap.folder.root, latest: snap.folder.latest && snap.folder.latest.name, entries: snap.folder.entries })
show('DETECTION', Object.entries(snap.detection || {}).map(([id, value]) => ({ id, detected: !!value.root, running: value.running })))

const switchToOneDrive = await act('setProvider', { provider: 'onedrive' })
show('SET_ONEDRIVE_MESSAGE', switchToOneDrive.message)

const autoOff = await act('setAutoBackup', { enabled: false })
show('AUTO_OFF', autoOff.message)
const autoOn = await act('setAutoBackup', { enabled: true })
show('AUTO_ON', autoOn.message)

const backToOriginal = await act('setFolder', { path: original.backupRoot })
show('RESTORE_FOLDER_MESSAGE', backToOriginal.message)
show('FINAL_SETTINGS', JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')))

const cancelPick = await act('pickFolder')
show('PICK_WITHOUT_PICKER', cancelPick.ok + ' / ' + cancelPick.error)

const badOp = await act('nope')
show('BAD_OP', badOp.ok + ' / ' + badOp.error)

const unknownProvider = await act('setProvider', { provider: 'dropbox' })
show('UNKNOWN_PROVIDER', unknownProvider.ok + ' / ' + unknownProvider.error)

const emptyFolder = await act('setFolder', { path: '   ' })
show('EMPTY_FOLDER', emptyFolder.ok + ' / ' + emptyFolder.error)

process.exit(0)
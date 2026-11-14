// Read-only harness: prints what the settings page would receive from
// GET /api/dsh-backup/state (settings, cloud sync state, provider detection).
// It never changes the persisted settings. Run from the package root:
//   node tests/state-check.mjs
import path from 'node:path'
import os from 'node:os'

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
  fiber: { entry: { id: 'dsh-backup-state-check' } },
}

const mod = await import('../index.js')
mod.apply(fakeCtx, {})

const stateRoute = routes.get('/api/dsh-backup/state')
if (!stateRoute) {
  console.log('STATE_ROUTE_MISSING', [...routes.keys()])
  process.exit(1)
}

const snap = JSON.parse(await (await stateRoute.fetch(new Request('http://x/api/dsh-backup/state'))).text())
const detection = {}
for (const [id, info] of Object.entries(snap.detection || {})) {
  detection[id] = { root: info.root, running: info.running }
}

console.log(
  JSON.stringify(
    {
      provider: snap.settings.provider,
      providerName: snap.settings.providerName,
      backupRoot: snap.settings.backupRoot,
      autoBackup: snap.settings.autoBackup,
      cloud: snap.cloud,
      detection,
      folder: snap.folder,
      lastStatus: snap.status && snap.status.state,
    },
    null,
    2,
  ),
)
process.exit(0)
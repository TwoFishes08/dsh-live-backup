/**
 * Regression test for the "settings panel shows `not found`" bug.
 *
 * At DSH start the plugin could be instantiated before the host `connection`
 * service existed; the old code returned early, so neither the HTTP routes nor
 * the startup backup were ever set up. `apply` must now:
 *   1. schedule the startup backup regardless of the connection service, and
 *   2. register its routes as soon as the service appears (late-connection
 *      probe), so a boot-time race heals itself instead of needing a restart.
 *
 * Run: node tests/late-connection-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Keep the test's settings/status/diagnostics files out of the real DSH home.
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-backup-late-'))
process.env.DSH_HOME = sandboxHome
process.env.DSH_PROFILE = 'test'
process.env.DSH_PROFILE_DIR = path.join(sandboxHome, 'profiles', 'test')

const routes = []
const fakeConnection = {
  fetch: {
    register(route) {
      routes.push(route)
      return async () => {}
    },
  },
}

let connectionAvailable = false
const ctx = {
  get(name) {
    if (name === 'connection') return connectionAvailable ? fakeConnection : null
    if (name === 'sessionPersistence') return { list: async () => [], flush: async () => {} }
    return null
  },
  effect(fn) {
    fn()
    return () => {}
  },
  fiber: { entry: {} },
}

const mod = await import('../index.js')
assert.equal(typeof mod.apply, 'function')
assert.deepEqual(mod.inject, ['connection'], 'host half must declare the connection dependency')

mod.apply(ctx)

assert.equal(routes.length, 0, 'no routes can be registered while the service is missing')

// The service appears a moment later, like a late-plugged host service.
connectionAvailable = true
await new Promise((resolve) => setTimeout(resolve, 2500))

assert.equal(routes.length, 2, 'both HTTP routes must register once the service appears')
assert.deepEqual(
  routes.map((route) => route.path).sort(),
  ['/api/dsh-backup/action', '/api/dsh-backup/state'],
)

// Register the routes exactly once even if the service is read repeatedly.
connectionAvailable = true
await new Promise((resolve) => setTimeout(resolve, 1200))
assert.equal(routes.length, 2, 'routes must not be registered twice')

console.log('LATE_CONNECTION_OK=true routes=' + routes.length)
process.exit(0)
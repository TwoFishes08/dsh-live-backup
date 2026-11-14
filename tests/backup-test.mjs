// Standalone harness: loads the dsh-backup host half with a fake Context,
// lets the scheduled startup backup run, then reports the persisted status.
// Run from the package root: node tests/backup-test.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATUS_PATH = path.join(DSH_HOME, 'dsh-backup', 'status.json')

const fakeCtx = {
  get(name) {
    if (name === 'connection') {
      return { fetch: { register: () => async () => {} } }
    }
    if (name === 'sessionPersistence') {
      return { flush: async () => {} }
    }
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

const readStatus = () => {
  try {
    return JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8')).status
  } catch {
    return null
  }
}

let status = null
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  status = readStatus()
  if (i > 12 && status && (status.state === 'success' || status.state === 'error')) break
}

console.log('FINAL_STATE=' + (status ? status.state : 'none'))
console.log('FINAL_JSON=' + JSON.stringify(status && (status.lastError || status.result)))
process.exit(0)
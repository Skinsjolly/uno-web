// engine.js — loads the self-contained Luau web engine (luau-web WASM) and
// exposes a promise-based RPC over a single shared LuauState. All requests are
// serialized through a FIFO mutex; each returns {ok, gid, events, error}.
import { LuauState } from 'luau-web'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ENGINE_SRC = join(__dirname, '..', 'engine', 'web_engine.lua')

class EngineBridge {
  constructor() {
    this.state = null
    this.dispatch = null
    this._queue = Promise.resolve()
  }

  async init() {
    this.state = await LuauState.createAsync({})
    // luau-web has no Lua-side loadstring; expose one backed by the VM compiler.
    this.state.env.global.set('__jsLoadstring', (src, name) => {
      const fn = this.state.loadstring(src, name || 'chunk', false)
      if (typeof fn !== 'function') {
        throw new Error('compile failed: ' + JSON.stringify(fn))
      }
      return fn
    })
    // make the global `loadstring` available to the bridge chunks
    await this.state.loadstring(
      `loadstring = __jsLoadstring\nreturn true`,
      'set-loadstring',
      true,
    )()

    const src = readFileSync(ENGINE_SRC, 'utf8')
    await this.state.loadstring(src, '=web_engine', true)()
    // __rpc is a global table set by the bridge; read it from the env.
    this.rpc = await this.state.env.global.get('__rpc')
    this.dispatchFn = await this.rpc.get('dispatch')
    if (!this.dispatchFn) throw new Error('engine boot did not expose dispatch')
    return this
  }

  // dispatch(req) -> Promise<response object>. Serialized on a single queue so
  // a request never interleaves the engine's outbox with another request.
  request(req) {
    const run = async () => {
      const out = await this.dispatchFn(JSON.stringify(req))
      return JSON.parse(out[0])
    }
    const p = this._queue.then(run, run)
    this._queue = p.then(() => {}, () => {})
    return p
  }

  destroy() {
    if (this.state) this.state.destroy()
  }
}

export default EngineBridge
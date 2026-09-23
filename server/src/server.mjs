// server.mjs — UNO web server: HTTP auth API + WebSocket game bridge.
// The game logic lives in the Luau engine (server/engine/web_engine.lua) run
// inside the luau-web WASM VM; this file only routes messages and manages state.
import http from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import EngineBridge from './engine.js'
import { createStore } from './store.mjs'
import { hashPassword, verifyPassword, signToken, verifyToken } from './auth.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const CLIENT_DIR = join(__dirname, '..', '..', 'client')
const PORT = Number(process.env.PORT || 3000)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
}

// --- lobby registry ---------------------------------------------------------
// code -> { gid, sockets: Map<userId, ws>, active: bool }
const lobbies = new Map()

const codeChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function makeCode() {
  let c = ''
  for (let i = 0; i < 6; i++) c += codeChars[Math.floor(Math.random() * codeChars.length)]
  return lobbies.has(c) ? makeCode() : c
}

function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  })
  res.end(JSON.stringify(obj))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 64 * 1024) reject(new Error('too large'))
    })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  if (urlPath === '/') urlPath = '/index.html'
  const safe = normalize(urlPath).replace(/^(\.\.[/\\])+/, '')
  const file = join(CLIENT_DIR, safe)
  if (!file.startsWith(CLIENT_DIR) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
    return
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' })
  res.end(readFileSync(file))
}

// --- engine routing ---------------------------------------------------------
// Forward a lobby action to the engine and fan the returned events back out
// to the sockets for that lobby.
async function engineCall(engine, code, req) {
  const lobby = lobbies.get(code)
  if (!lobby) return { ok: false, error: 'no lobby' }
  const out = await engine.request({ ...req, gid: code, t: nowSec() })
  if (out.events) {
    for (const ev of out.events) {
      const ws = lobby.sockets.get(Number(ev.userId))
      if (ws && ws.readyState === ws.OPEN) {
        if (ev.kind === 'state' && ev.state) {
          ws.send(JSON.stringify({ type: 'state', state: JSON.parse(ev.state) }))
        } else if (ev.kind === 'notice' && ev.notice) {
          ws.send(JSON.stringify({ type: 'notice', notice: JSON.parse(ev.notice) }))
        }
      }
    }
  }
  return out
}

const nowSec = () => Date.now() / 1000

// Heartbeat: advance the engine clock for active lobbies so deadlines
// (turn timer, opening pick, challenges, round/game-over auto-advance) fire.
function startTickLoop(engine, onClose) {
  const h = setInterval(async () => {
    for (const [code, lobby] of lobbies) {
      if (!lobby.active) continue
      try {
        await engineCall(engine, code, { op: 'tick' })
      } catch (e) {
        // engine hiccup on a dead lobby; drop it
        lobbies.delete(code)
      }
    }
  }, 250)
  onClose(() => clearInterval(h))
}

// --- main -------------------------------------------------------------------
export async function startServer(port = PORT) {
  const store = await createStore()
  const engine = await new EngineBridge().init()

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    if (req.method === 'OPTIONS') return json(res, 204, {})
    if (url.pathname === '/api/register' && req.method === 'POST') {
      try {
        const { username, password } = await readBody(req)
        if (!username || !password) return json(res, 400, { error: 'username and password required' })
        if (!/^[a-zA-Z0-9_]{3,20}$/.test(username))
          return json(res, 400, { error: 'username must be 3-20 chars (letters, digits, _)' })
        if (password.length < 6) return json(res, 400, { error: 'password must be at least 6 characters' })
        const hash = await hashPassword(password)
        const user = await store.createUser(username, hash)
        const token = signToken(user)
        return json(res, 201, { token, user: { id: user.id, username: user.username } })
      } catch (e) {
        if (e && e.message === 'username_taken') return json(res, 409, { error: 'username taken' })
        return json(res, 500, { error: 'server error' })
      }
    }
    if (url.pathname === '/api/login' && req.method === 'POST') {
      try {
        const { username, password } = await readBody(req)
        const user = await store.findByName(username)
        if (!user || !(await verifyPassword(password, user.passwordHash)))
          return json(res, 401, { error: 'invalid credentials' })
        const token = signToken(user)
        return json(res, 200, { token, user: { id: user.id, username: user.username } })
      } catch {
        return json(res, 500, { error: 'server error' })
      }
    }
    if (url.pathname === '/api/me' && req.method === 'GET') {
      const auth = req.headers.authorization || ''
      const user = verifyToken(auth.replace(/^Bearer /i, ''))
      return user
        ? json(res, 200, { user: { id: user.id, username: user.name } })
        : json(res, 401, { error: 'unauthorized' })
    }
    // static client (local dev; production serves this from Cloudflare Pages)
    return serveStatic(req, res)
  })

  const wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://x')
    const user = verifyToken(url.searchParams.get('token') || '')
    if (!user) {
      ws.close(4001, 'unauthorized')
      return
    }
    let code = null

    const send = (obj) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj))
    }

    ws.on('message', async (raw) => {
      let msg
      try {
        msg = JSON.parse(raw)
      } catch {
        return
      }
      try {
        if (msg.type === 'create') {
          if (code) return send({ type: 'error', error: 'already in a game' })
          code = makeCode()
          lobbies.set(code, { gid: code, sockets: new Map(), active: true })
          const lobby = lobbies.get(code)
          lobby.sockets.set(Number(user.id), ws)
          await engineCall(engine, code, {
            op: 'create',
            players: [{ userId: Number(user.id), name: user.name }],
            capacity: Number(msg.capacity) || 4,
          })
          send({ type: 'joined', code, userId: Number(user.id) })
          await engineCall(engine, code, { op: 'sync', userId: Number(user.id) })
        } else if (msg.type === 'join') {
          if (code) return send({ type: 'error', error: 'already in a game' })
          const target = String(msg.code || '').toUpperCase()
          const lobby = lobbies.get(target)
          if (!lobby) return send({ type: 'error', error: 'game not found' })
          code = target
          lobby.sockets.set(Number(user.id), ws)
          const out = await engineCall(engine, code, {
            op: 'join',
            userId: Number(user.id),
            name: user.name,
          })
          if (!out.ok) {
            lobby.sockets.delete(Number(user.id))
            code = null
            return send({ type: 'error', error: out.error || 'could not join' })
          }
          send({ type: 'joined', code, userId: Number(user.id) })
          await engineCall(engine, code, { op: 'sync', userId: Number(user.id) })
        } else if (msg.type === 'action') {
          if (!code) return send({ type: 'error', error: 'not in a game' })
          const out = await engineCall(engine, code, {
            op: 'action',
            userId: Number(user.id),
            action: msg.action,
          })
          if (!out.ok) send({ type: 'error', error: out.error || 'action failed' })
        } else if (msg.type === 'leave') {
          if (!code) return
          const lobby = lobbies.get(code)
          if (lobby) {
            lobby.sockets.delete(Number(user.id))
            await engineCall(engine, code, { op: 'leave', userId: Number(user.id) })
            if (lobby.sockets.size === 0) lobbies.delete(code)
          }
          code = null
        } else if (msg.type === 'sync') {
          if (code) await engineCall(engine, code, { op: 'sync', userId: Number(user.id) })
        }
      } catch (e) {
        send({ type: 'error', error: 'server error' })
      }
    })

    ws.on('close', async () => {
      if (!code) return
      const lobby = lobbies.get(code)
      if (!lobby) return
      if (lobby.sockets.get(Number(user.id)) === ws) {
        lobby.sockets.delete(Number(user.id))
        try {
          await engineCall(engine, code, { op: 'leave', userId: Number(user.id) })
        } catch {}
        if (lobby.sockets.size === 0) lobbies.delete(code)
      }
    })
  })

  let onCloseCb = null
  startTickLoop(engine, (cb) => (onCloseCb = cb))

  await new Promise((resolve) => server.listen(port, resolve))
  return {
    server,
    engine,
    store,
    port: server.address().port,
    close: async () => {
      if (onCloseCb) onCloseCb()
      for (const ws of wss.clients) ws.terminate()
      await new Promise((r) => wss.close(r))
      await new Promise((r) => server.close(r))
      engine.destroy()
    },
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer().then((s) => {
    console.log(`UNO web server listening on http://localhost:${s.port}`)
  })
}
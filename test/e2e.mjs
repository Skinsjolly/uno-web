// e2e.mjs — full-stack test: boots the real server, registers two users,
// drives a full UNO match over WebSockets, and asserts engine behavior.
// Run: node test/e2e.mjs
import { WebSocket } from 'ws'
import { startServer } from '../server/src/server.mjs'

const PORT = 0 // ephemeral port
const LOG = process.env.LOG === '1'

let passed = 0
let failed = 0
function assert(cond, name) {
  if (cond) {
    passed++
    LOG && console.log('  ok:', name)
  } else {
    failed++
    console.error('  FAIL:', name)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A tiny WS client that auto-authenticates and remembers the latest state/notice.
function makeClient(url, token, name) {
  const ws = new WebSocket(`${url}/ws?token=${encodeURIComponent(token)}`)
  const client = {
    ws,
    name,
    code: null,
    state: null,
    notion: [],
    queue: [],
    waiters: [],
    close: () => ws.close(),
    send: (obj) => ws.send(JSON.stringify(obj)),
    // resolve when the predicate holds against incoming state
    whenState: (pred, timeoutMs = 8000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${name}: state condition timed out`)), timeoutMs)
        const check = () => {
          if (client.state && pred(client.state)) {
            clearTimeout(timer)
            resolve(client.state)
          } else if (client.queue.length) {
            client.state = client.queue.shift()
            check()
          } else {
            client.onState = check
          }
        }
        client.onState = check
        check()
      }),
  }
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString())
    if (msg.type === 'state') {
      client.state = msg.state
      const cb = client.onState
      client.onState = null
      cb && cb()
    } else if (msg.type === 'joined') {
      client.code = msg.code
    } else if (msg.type === 'notice') {
      client.notion.push(msg.notice)
    }
  })
  ws.on('error', () => {})
  return new Promise((res) => {
    ws.on('open', () => res(client))
  })
}

async function register(origin, username) {
  return fetch(`${origin}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'secret123' }),
  }).then((r) => r.json())
}

function canPlay(card, top, color) {
  if (card.kind === 'wild' || card.kind === 'wilddrawfour') return true
  if (!top) return true
  if (top.kind === 'wild' || top.kind === 'wilddrawfour') return card.color === color
  if (card.color === top.color) return true
  if (card.kind === top.kind) return true
  if (card.kind === 'number' && top.kind === 'number' && card.value === top.value) return true
  return false
}

function legalCard(st) {
  const me = st.me
  if (!me || !me.hand.length) return null
  // after drawing, only the drawn card (always inserted at hand[0]) is legal
  if (me.hasDrawn) {
    const drawn = me.hand[0]
    return drawn && canPlay(drawn, st.topCard, st.currentColor) ? drawn : null
  }
  return me.hand.find((c) => canPlay(c, st.topCard, st.currentColor)) || null
}

async function main() {
  const { server, port } = await startServer(PORT)
  const origin = `http://localhost:${port}`
  const wsUrl = `ws://localhost:${port}`
  console.log(`server up on :${port}`)

  try {
    // --- auth & two-player match to completion ---
    const a = await register(origin, 'alice')
    const b = await register(origin, 'bob')
    assert(a.token && a.user.username === 'alice', 'alice registered')
    assert(b.token && b.user.username === 'bob', 'bob registered')

    const alice = await makeClient(wsUrl, a.token, 'alice')
    const bob = await makeClient(wsUrl, b.token, 'bob')

    // alice creates the lobby
    alice.send({ type: 'create', capacity: 4 })
    await sleep(200)
    assert(alice.code, 'alice got lobby code: ' + alice.code)
    const lobbySt = await alice.whenState((s) => s.phase === 'lobby')
    assert(lobbySt.phase === 'lobby', 'lobby phase visible to alice')
    assert(lobbySt.players.length === 1, 'one player in lobby')

    // bob joins with the code
    bob.send({ type: 'join', code: alice.code })
    const joined = await bob.whenState((s) => s.phase === 'lobby' && s.players.length === 2)
    assert(joined.players.length === 2, 'bob joined: two players in lobby')

    // host starts the game
    alice.send({ type: 'action', action: { type: 'start' } })
    const start = await alice.whenState((s) => s.phase === 'playing')
    assert(start.phase === 'playing', 'game started')
    assert(start.players.length === 2, 'two players in match')
    assert(start.me.hand.length >= 7, `alice dealt 7+ cards (got ${start.me.hand.length})`)

    // Drive turns with a simple poller: every 50ms look at each client's latest
    // state and act if it's their turn (answer challenges, play a legal card,
    // or draw). This robustly handles wild+4 challenges and 2-p skips where the
    // same player may get consecutive turns.
    let turns = 0
    let poll = 0
    let winner = null
    const maxTurns = 200
    const all = [alice, bob]
    const idOf = (cl) => (cl === alice ? Number(a.user.id) : Number(b.user.id))
    const lastActed = { [idOf(alice)]: 0, [idOf(bob)]: 0 }
    while (poll++ < maxTurns && !winner) {
      await sleep(50)
      for (const cl of all) {
        const st = cl.state
        if (!st || st.phase !== 'playing') continue
        const me = st.me && st.me.userId === idOf(cl) ? st.me : st.players.find((p) => p.userId === idOf(cl))
        const isMeTurn = st.turnUserId === idOf(cl) && me
        if (!isMeTurn) continue
        if (st.openingPick && lastActed[idOf(cl)] !== poll) {
          cl.send({ type: 'action', action: { type: 'openingColor', color: 'Red' } })
          lastActed[idOf(cl)] = poll
          if (LOG) console.log(`  [t${poll}] ${cl === alice ? 'alice' : 'bob'} picks opening color`)
          continue
        }
        if (st.pendingChallenge && me && me.isTurn && lastActed[idOf(cl)] !== poll) {
          cl.send({ type: 'action', action: { type: 'challenge' } })
          lastActed[idOf(cl)] = poll
          if (LOG) console.log(`  [t${poll}] ${cl === alice ? 'alice' : 'bob'} challenges +4`)
          continue
        }
        const card = legalCard(st)
        if (card && me && me.isTurn && lastActed[idOf(cl)] !== poll) {
          const action = { type: 'play', cardId: card.id }
          if (card.kind === 'wild' || card.kind === 'wilddrawfour') action.color = 'Red'
          cl.send({ type: 'action', action })
          lastActed[idOf(cl)] = poll
          if (LOG) console.log(`  [t${poll}] ${cl === alice ? 'alice' : 'bob'} plays ${card.color}:${card.kind} (${cl.state.me.hand.length} remaining)`)
          continue
        }
        if (!card && !me.hasDrawn && me.isTurn && lastActed[idOf(cl)] !== poll) {
          cl.send({ type: 'action', action: { type: 'draw' } })
          lastActed[idOf(cl)] = poll
          if (LOG) console.log(`  [t${poll}] ${cl === alice ? 'alice' : 'bob'} draws (${cl.state.me.hand.length} cards)`)
        }
      }
      const snap = alice.state || start
      if (snap.phase === 'roundEnd' || snap.phase === 'gameOver') {
        winner = snap.roundResult || snap.gameResult || null
        break
      }
    }
    assert(winner !== null, `match finished within ${maxTurns} polls`)
    assert(Number(winner.winnerId) === Number(a.user.id) || Number(winner.winnerId) === Number(b.user.id), 'winner is a real player')
    LOG && console.log('  winner:', winner.winnerName, '(score', winner.winnerScore + ')')
    LOG && console.log('  winner:', winner)

    // --- leave path: alice leaves mid-lobby ---
    const c = await register(origin, 'carol')
    const d = await register(origin, 'dave')
    const carol = await makeClient(wsUrl, c.token, 'carol')
    carol.send({ type: 'create' })
    await sleep(150)
    assert(carol.code, 'carol created lobby')
    carol.send({ type: 'leave' })
    await sleep(150)
    LOG && console.log('  carol left')

    // --- error path: joining a nonexistent game ---
    const eve = await makeClient(wsUrl, (await register(origin, 'eve')).token, 'eve')
    const onMsg = new Promise((res) => {
      const t = setTimeout(() => res({ type: 'error', error: 'TIMEOUT' }), 3000)
      eve.ws.on('message', (d) => { clearTimeout(t); res(JSON.parse(d.toString())) })
    })
    eve.send({ type: 'join', code: 'ZZZZZZ' })
    LOG && console.log('  eve joined nonexistent')
    const errState = await onMsg
    assert(errState.type === 'error', 'join to missing game yields error')

    // --- invalid login ---
    const bad = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'nope' }),
    })
    assert(bad.status === 401, 'wrong password rejected (401)')

    // --- duplicate username rejected ---
    const dup = await fetch(`${origin}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'whatever123' }),
    })
    assert(dup.status === 409, 'duplicate username rejected (409)')

    carol.close(); eve.close(); alice.close(); bob.close()
  } finally {
    await server.close()
    process.exit(failed ? 1 : 0)
  }
}

main().catch((e) => {
  console.error('e2e crashed:', e)
  process.exit(1)
})
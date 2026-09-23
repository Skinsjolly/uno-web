import EngineBridge from '../server/src/engine.js'

const eng = await new EngineBridge().init()
const t = Date.now() / 1000

const myId = 1001
const otherId = 1002
const gid = 'AAA111'

// create a 2-player lobby
let r = await eng.request({ t, gid, op: 'create', players: [{ userId: myId, name: 'Me' }, { userId: otherId, name: 'Rival' }], capacity: 4 })
console.log('create ok:', r.ok, 'events:', r.events.length)

// make me the host and start
r = await eng.request({ t, gid, op: 'action', userId: myId, action: { type: 'start' } })
console.log('start ok:', r.ok)
const st = JSON.parse(r.events.find(e => e.userId === myId && e.kind === 'state').state)
console.log('phase:', st.phase, 'players:', st.players.length, 'my hand:', st.me.hand.length, 'turn:', st.turnUserId)

// find who starts
const starter = st.turnUserId
const starterName = starter === myId ? 'me' : 'rival'
console.log('starter is', starterName)

// the current player plays their first legal card and we see what happens
const starterEv = r.events.find(e => e.userId === starter && e.kind === 'state' && e.state)
const startSt = JSON.parse(starterEv.state)
const top = startSt.topCard
const color = startSt.currentColor
function canPlay(card) {
  if (card.kind === 'wild' || card.kind === 'wilddrawfour') return true
  if (!top) return true
  if (top.kind === 'wild' || top.kind === 'wilddrawfour') return card.color === color
  if (card.color === top.color) return true
  if (card.kind === top.kind) return true
  if (card.kind === 'number' && top.kind === 'number' && card.value === top.value) return true
  return false
}
const legal = startSt.me.hand.filter(canPlay)
console.log('legal first cards in starter hand:', legal.length)
if (legal.length > 0) {
  const card = legal[0]
  const pReq = { type: 'play', cardId: card.id }
  if (card.kind === 'wild' || card.kind === 'wilddrawfour') pReq.color = 'Red'
  r = await eng.request({ t, gid, op: 'action', userId: starter, action: pReq })
  console.log('play ok:', r.ok)
  const after = JSON.parse(r.events.find(e => e.userId === myId && e.kind === 'state').state)
  console.log('after play -> top:', JSON.stringify(after.topCard), 'turn:', after.turnUserId)
} else {
  // draw instead
  r = await eng.request({ t, gid, op: 'action', userId: starter, action: { type: 'draw' } })
  console.log('draw ok:', r.ok, 'hand size now:', JSON.parse(r.events.find(e => e.userId === starter && e.kind === 'state').state).me.hand.length)
}

eng.destroy()
console.log('E2E SUCCESS')
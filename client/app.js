// app.js — UNO web client (vanilla, no deps)

const $ = (sel) => document.querySelector(sel)
const API = (window.UNO_CONFIG && window.UNO_CONFIG.api) || ''
const WS_BASE = (window.UNO_CONFIG && window.UNO_CONFIG.ws) || ''

let ws = null
let token = localStorage.getItem('uno_token') || ''
let me = null
let code = null
let state = null
let actions = null // {playableCardIds:Set}
let myUserId = null

const COLORS = ['Red', 'Yellow', 'Green', 'Blue']
const KIND_SYMBOL = {
  number: (c) => c.value,
  skip: () => '⊘',
  reverse: () => '⇄',
  drawtwo: () => '+2',
  wild: () => '★',
  wilddrawfour: () => '+4',
}

// ---------- auth ----------
function showScreen(name) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.add('hidden'))
  $(`#screen-${name}`).classList.remove('hidden')
}

async function api(path, body) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'request failed')
  return data
}

function setTopbar(user) {
  $('#topbar').innerHTML = user
    ? `<span>${escapeHtml(user.username)}</span><button id="btn-logout" class="ghost">Log out</button>`
    : ''
  const b = $('#btn-logout')
  if (b) b.onclick = () => {
    token = ''
    localStorage.removeItem('uno_token')
    location.reload()
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const username = $('#auth-username').value.trim()
  const password = $('#auth-password').value
  const signingUp = $('#auth-title').textContent === 'Sign up'
  $('#auth-error').textContent = ''
  try {
    const path = signingUp ? '/api/register' : '/api/login'
    const data = await api(path, { username, password })
    token = data.token
    me = data.user
    localStorage.setItem('uno_token', token)
    setTopbar(me)
    enterLobby()
  } catch (err) {
    $('#auth-error').textContent = err.message
  }
})

$('#auth-toggle').addEventListener('click', () => {
  const signingUp = $('#auth-title').textContent === 'Sign up'
  $('#auth-title').textContent = signingUp ? 'Log in' : 'Sign up'
  $('#auth-toggle').textContent = signingUp ? 'Sign up instead' : 'Log in instead'
  $('#auth-password').autocomplete = signingUp ? 'current-password' : 'new-password'
  $('#auth-error').textContent = ''
})

// ---------- websocket ----------
let sendQueue = []
function connectWS() {
  if (WS_BASE) {
    ws = new WebSocket(WS_BASE + `?token=${encodeURIComponent(token)}`)
  } else {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`)
  }
  ws.onopen = () => {
    for (const m of sendQueue) ws.send(JSON.stringify(m))
    sendQueue = []
  }
  ws.onclose = () => {
    toast('Connection lost — reconnecting…')
    setTimeout(() => {
      if (token) connectWS()
    }, 1200)
  }
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    handle(msg)
  }
}

function handle(msg) {
  if (msg.type === 'joined') {
    code = msg.code
    myUserId = msg.userId
    $('#lobby-code').textContent = msg.code
    showScreen('lobby')
    renderLobby(null)
  } else if (msg.type === 'error') {
    toast(msg.error, 'danger')
  } else if (msg.type === 'state') {
    state = msg.state
    actions = computeActions(state)
    render()
  } else if (msg.type === 'notice') {
    const n = msg.notice
    toast(n && n.text ? n.text : JSON.stringify(n), n && n.kind)
  }
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj))
  else if (ws && ws.readyState === 0) sendQueue.push(obj)
}

// ---------- lobby ----------
function enterLobby() {
  showScreen('lobby')
  $('#lobby-capacity').innerHTML = ''
  for (let n = 2; n <= 8; n++) $('#lobby-capacity').insertAdjacentHTML('beforeend', `<option value="${n}">${n}</option>`)
  $('#lobby-start').classList.add('hidden')
  $('#lobby-players').innerHTML = '<li class="muted">Create a lobby to get started.</li>'
  $('#lobby-code').textContent = '—'
  send({ type: 'create', capacity: 4 })
}

$('#lobby-capacity').addEventListener('change', () => {
  if (state && state.phase === 'lobby') {
    send({ type: 'action', action: { type: 'setCapacity', capacity: Number($('#lobby-capacity').value) } })
  }
})
$('#lobby-start').addEventListener('click', () => send({ type: 'action', action: { type: 'start' } }))
$('#lobby-leave').addEventListener('click', () => {
  send({ type: 'leave' })
  code = null
  state = null
  enterLobby()
})
$('#lobby-join').addEventListener('click', () => {
  const c = $('#lobby-join-code').value.trim().toUpperCase()
  if (c) send({ type: 'join', code: c })
})

function renderLobby(lobbyState) {
  const st = lobbyState || (state && state.phase === 'lobby' ? state : null)
  if (!st) return
  const players = st.players || []
  $('#lobby-status').textContent = `${players.length} / ${st.capacity}`
  $('#lobby-players').innerHTML = players
    .map((p) => `<li>${escapeHtml(p.name)}<span>${p.isHost ? '<span class="host">HOST</span>' : ''} ${p.userId === myUserId ? '<span class="muted">(you)</span>' : ''}</span></li>`)
    .join('')
  const isHost = players.find((p) => p.userId === myUserId)?.isHost
  $('#lobby-start').classList.toggle('hidden', !isHost)
  $('#lobby-start').disabled = players.length < 2
  $('#lobby-capacity').value = String(st.capacity)
  $('#lobby-host-bar').classList.toggle('hidden', !isHost)
}

// ---------- game logic (mirrors Rules.canPlay) ----------
function computeActions(st) {
  if (st.phase !== 'playing' || !st.me) return { turn: false, playable: new Set(), canDraw: false, canUno: false, canCatch: [] }
  const isTurn = st.me.isTurn
  const top = st.topCard
  const color = st.currentColor
  const playable = new Set()
  if (isTurn) {
    for (const c of st.me.hand) {
      if (canPlay(c, top, color)) playable.add(c.id)
    }
  }
  const mePlayer = st.players.find((p) => p.userId === myUserId)
  const canCatch = isTurn && mePlayer ? st.players.filter((p) => p.catchable && p.userId !== myUserId) : []
  return {
    turn: isTurn,
    playable,
    canDraw: isTurn && !st.me.hasDrawn,
    canUno: isTurn && st.me.hand.length === 2,
    canCatch,
    unoCalled: st.me.unoCalled,
  }
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

// ---------- render ----------
function render() {
  if (!state) return
  switch (state.phase) {
    case 'lobby': renderLobby(state); return
    case 'roundEnd':
      showScreen('game')
      renderGame()
      if (state.roundResult) renderRoundResults(state.roundResult)
      else $('#scorers').classList.add('hidden')
      return
    case 'gameOver':
      showScreen('game')
      renderGame()
      if (state.gameResult) renderRoundResults({ ...state.gameResult, roundPoints: state.gameResult.winnerScore })
      else $('#scorers').classList.add('hidden')
      return
    default:
      showScreen('game')
      renderGame()
      $('#scorers').classList.add('hidden')
  }
}

function renderGame() {
  // opponents
  const opponents = state.players.filter((p) => p.userId !== myUserId)
  const mePlayer = state.players.find((p) => p.userId === myUserId)
  $('#opponents').innerHTML = opponents.map((p) => {
    const isTurn = state.turnUserId === p.userId
    return `<div class="opponent${isTurn ? ' turn' : ''}${p.catchable ? ' catchable' : ''}">
      <div class="name">${p.cardCount === 0 ? '🏆 ' : ''}${escapeHtml(p.name)}${p.userId === myUserId ? ' (you)' : ''}</div>
      <div class="cards">${'🂠'.repeat(Math.max(1, Math.min(p.cardCount, 10)))} ${p.cardCount} ${p.unoCalled ? '<span class="host">UNO!</span>' : ''}</div>
      <div class="muted">${p.score} pts</div>
      ${p.catchable ? '<button class="warn catch-btn" data-id="' + p.userId + '">Catch!</button>' : ''}
    </div>`
  }).join('')
  document.querySelectorAll('.catch-btn').forEach((b) => (b.onclick = () => send({ type: 'action', action: { type: 'catch', targetId: Number(b.dataset.id) } })))
  if (!opponents.length) $('#opponents').innerHTML = '<span class="muted">Waiting…</span>'

  // piles
  const top = state.topCard
  const topHtml = top ? cardHtml(top, 'discard') : '<div class="card back discard" id="discard-placeholder"><div class="card-face"></div></div>'
  $('#discard-wrap').innerHTML = topHtml
  $('#deck-count').textContent = `${state.deckCount} left`

  // meta
  // eslint-disable-next-line no-ternary
  const colorName = state.currentColor ? state.currentColor[0].toUpperCase() + state.currentColor.slice(1) : 'Any'
  $('#current-color').textContent = colorName
  $('#color-badge').style.background = COLORS.includes(state.currentColor) ? `var(--${(state.currentColor || '').toLowerCase()})` : 'var(--panel-2)'
  $('#color-badge').style.color = state.currentColor === 'yellow' ? '#1a1a1a' : ''
  $('#direction').textContent = state.direction >= 0 ? '🔄 clockwise' : '🔄 counter-clockwise'
  const cur = state.players.find((p) => p.userId === state.turnUserId)
  $('#turn-banner').textContent = state.phase === 'playing'
    ? (state.turnUserId === myUserId ? 'Your turn' : `${escapeHtml(cur ? cur.name : '?')}'s turn`)
    : state.phase === 'roundEnd' ? 'Round over — scoring…' : ''

  const deadline = state.deadline || (state.pendingChallenge && state.pendingChallenge.deadline) || (state.openingPick && state.openingPick.deadline)
  if (deadline) {
    const t = Math.max(0, (deadline - (state.serverTime || Date.now() / 1000)))
    $('#deadline').textContent = t > 0 ? `${t.toFixed(1)}s` : ''
  } else $('#deadline').textContent = ''

  if (state.pendingChallenge) {
    const offender = state.players.find((p) => p.userId === state.pendingChallenge.offenderId)
    if (state.me) {
      $('#turn-banner').textContent = `Challenge ${escapeHtml(offender ? offender.name : '')}'s +4?`
      $('#btn-draw').classList.remove('hidden')
      $('#btn-draw').textContent = 'Challenge'
      $('#btn-draw').onclick = () => send({ type: 'action', action: { type: 'challenge' } })
    }
  } else if (state.openingPick && state.me) {
    // color modal
    showColorModal('Pick a color', (color) => send({ type: 'action', action: { type: 'openingColor', color } }))
  } else {
    $('#btn-draw').classList.remove('hidden')
    $('#btn-draw').disabled = !(
      actions &&
      actions.turn &&
      actions.canDraw &&
      state.phase === 'playing' &&
      !state.pendingChallenge &&
      !state.openingPick
    )
    $('#btn-draw').textContent = 'Draw'
    $('#btn-draw').onclick = () => send({ type: 'action', action: { type: 'draw' } })
  }

  // me
  $('#me-name').textContent = escapeHtml(mePlayer ? mePlayer.name : '')
  $('#me-score').textContent = mePlayer ? `${mePlayer.score} pts` : ''
  $('#btn-uno').classList.toggle('hidden', !(actions && actions.canUno && !actions.unoCalled && state.phase === 'playing'))
  $('#btn-uno').onclick = () => send({ type: 'action', action: { type: 'uno' } })

  // hand
  const hand = state.me ? state.me.hand : []
  $('#hand').innerHTML = hand.map((c) => {
    const playable = actions && actions.playable.has(c.id)
    const wal = (c.color || '').toLowerCase()
    const cls = ['card', wal, playable ? 'playable' : 'disabled'].join(' ')
    return `<div class="${cls}" data-id="${c.id}" title="${cardName(c)}"><div class="card-face">${escapeHtml(KIND_SYMBOL[c.kind] ? KIND_SYMBOL[c.kind](c) : (c.value ?? ''))}</div></div>`
  }).join('')
  document.querySelectorAll('#hand .card').forEach((el) => {
    const id = Number(el.dataset.id)
    if (!actions || !actions.playable.has(id)) return
    el.onclick = () => {
      const card = hand.find((c) => c.id === id)
      if (card.kind === 'wild' || card.kind === 'wilddrawfour') {
        showColorModal('Pick a color', (color) => send({ type: 'action', action: { type: 'play', cardId: id, color } }))
      } else {
        send({ type: 'action', action: { type: 'play', cardId: id } })
      }
    }
  })
}

function cardHtml(c, extra) {
  const sym = KIND_SYMBOL[c.kind] ? KIND_SYMBOL[c.kind](c) : (c.value ?? '')
  const wal = (c.color || '').toLowerCase()
  return `<div class="card ${wal || ''} ${extra || ''}"><div class="card-face">${escapeHtml(sym)}</div></div>`
}

function cardName(c) {
  const kind = c.kind === 'number' ? c.value : c.kind
  return `${c.color} ${kind}`
}

function renderRoundResults(rr) {
  $('#scorers').classList.remove('hidden')
  const rows = []
  if (rr.ledger && rr.ledger.length) {
    for (const l of rr.ledger) rows.push(`<li>${escapeHtml(l.name)} — +${l.points} pts</li>`)
  } else {
    rows.push('<li class="muted">No points this round</li>')
  }
  if (rr.gameResult) {
    $('#results').innerHTML = `
      <h4>🏆 ${escapeHtml(rr.winnerName)} WINS THE GAME — ${rr.winnerScore} pts</h4>
      <ul>${rows.join('')}</ul>
      <p class="muted">Returning to lobby…</p>`
    $('#btn-next-round').classList.add('hidden')
  } else {
    $('#results').innerHTML = `
      <h4>🏆 ${escapeHtml(rr.winnerName)} wins the round +${rr.roundPoints}</h4>
      <ul>${rows.join('')}</ul>`
    const isHost = state.players.find((p) => p.userId === myUserId)?.isHost
    $('#btn-next-round').classList.toggle('hidden', !isHost)
    $('#btn-next-round').onclick = () => send({ type: 'action', action: { type: 'nextRound' } })
  }
  $('#btn-lobby').classList.toggle('hidden', !!state.gameResult)
  $('#btn-lobby').onclick = () => send({ type: 'leave' })
}

// ---------- modal / toasts ----------
function showColorModal(title, onPick) {
  hideColorModal()
  $('#modal-inner').innerHTML = `
    <h3>${escapeHtml(title)}</h3>
    <div class="color-row">
      ${COLORS.map((c) => `<div class="color-swatch" data-c="${c}" style="background:var(--${c})"></div>`).join('')}
    </div>
    <button id="modal-cancel" class="ghost">Cancel</button>`
  $('#modal').classList.remove('hidden')
  document.querySelectorAll('.color-swatch').forEach((s) => (s.onclick = () => { onPick(s.dataset.c); hideColorModal() }))
  $('#modal-cancel').onclick = hideColorModal
}
function hideColorModal() { $('#modal').classList.add('hidden') }

function toast(text, kind) {
  const el = document.createElement('div')
  el.className = 'toast'
  if (kind === 'error') el.style.borderLeftColor = 'var(--danger)'
  if (kind === 'warn') el.style.borderLeftColor = 'var(--warn)'
  el.textContent = text
  $('#toasts').appendChild(el)
  setTimeout(() => el.remove(), 4500)
}

// ---------- boot ----------
async function boot() {
  if (token) {
    try {
      const res = await fetch(API + '/api/me', { headers: { Authorization: 'Bearer ' + token } })
      if (res.ok) {
        me = await res.json()
        setTopbar(me.user)
        connectWS()
        showScreen('lobby')
        $('#lobby-players').innerHTML = '<li class="muted">Creating lobby…</li>'

        // the client always starts in a fresh lobby; queue until ws is up
        send({ type: 'create', capacity: 4 })
        return
      }
    } catch {}
    token = ''
    localStorage.removeItem('uno_token')
  }
  showScreen('auth')
}

boot()
# UNO — Web

A playable UNO in the browser. The entire game engine is the **same Luau code
from the Roblox project** (`uno-roblox/src/.../UNO/Game.lua`,
`Rules.lua`, `CardDefs.lua`, `Config.lua`), bundled together (`web_engine.lua`)
and executed unchanged inside a **WASM Luau VM** (`luau-web`) running in Node.
No logic was ported or rewritten — the browser client is just a renderer over
the engine's serialized state.

```
browser (Cloudflare Pages)
   │  /api (register/login) + /ws (game)
   ▼
Node server ── HTTP auth/JWT ── WebSocket hub
   │              │
   ▼              ▼
EngineBridge (luau-web WASM, single Luau VM, FIFO queue)
   │
   ▼
web_engine.lua = Game.lua + Rules.lua + CardDefs.lua + Config.lua + lobby bridge
```

## Layout

```
uno-web/
├── client/            # static frontend (vanilla HTML/CSS/JS), served by Pages
├── server/
│   ├── engine/        # Luau engine packaging
│   │   ├── bridge_body.lua      # Roblox API shims + RPC dispatcher (in-VM)
│   │   ├── json.lua             # JSON codec for the VM
│   │   ├── web_engine.lua       # GENERATED: the committed engine bundle
│   │   └── gen_bundle.sh        # regenerate web_engine.lua from uno-roblox
│   └── src/
│       ├── server.mjs           # HTTP auth API + WebSocket hub + tick loop
│       ├── engine.js            # EngineBridge: WASM loader + serialized RPC
│       ├── auth.mjs             # scrypt password hashing + HMAC JWT (no deps)
│       └── store.mjs            # pg store (Postgres) w/ in-memory fallback
├── test/
│   ├── e2e.mjs                  # full-stack test: auth + full match over WS
│   └── engine_smoke.mjs         # engine bridge boots and plays
└── render.yaml                  # Render blueprint (web service + Postgres)
```

## Run locally

Requires Node ≥ 20.

```bash
npm install            # root (ws for tests)
npm --prefix server install
cd server && node src/server.mjs
```

Then open http://localhost:3000. Without `DATABASE_URL` the server uses an
in-memory user store (resets on restart). Sign up with any username/password,
create a lobby, share the 6-character code, and play — the client auto-renders
your hand, legal highlights, turn/direction/color, and UNO/catch actions.

```bash
# tests — spins up the real server, registers users, plays a full match
npm test              # (node test/e2e.mjs)
node test/engine_smoke.mjs
```

## Deploy

### Backend (Render)
Push the repo, then create a blueprint from `render.yaml` (web service +
managed Postgres). Set `CORS_ORIGIN` to your Pages domain.

### Frontend (Cloudflare Pages)
Build config: **none**; Root directory: `client`. The site is fully static and
calls `/api` + `/ws` on the same origin as where the HTML is served. For the
default Render service the origin is auto-detected from `location.host`; if the
API lives elsewhere, adjust the `API`/WebSocket bases in `client/app.js`.

## WebSocket protocol

Client → server messages (JSON):

| type    | fields                       | purpose                               |
|---------|------------------------------|---------------------------------------|
| create  | `capacity?`                  | host a new lobby                      |
| join    | `code`                       | join a lobby by 6-char code           |
| action  | `action`                     | engine action (see below)             |
| sync    | –                            | re-request your serialized state      |
| leave   | –                            | leave the current game                |

Server → client:

| type   | fields        | purpose                     |
|--------|---------------|-----------------------------|
| joined | `code, userId`| lobby acquired               |
| state  | `state`       | serialized game state for you|
| notice | `notice`      | toast/error (`text, kind`)   |
| error  | `error`       | failed action               |

Engine actions (`send({type:"action", action})`):

```js
{ type: 'start' }                                      // host starts (2+ players)
{ type: 'setCapacity', capacity }                      // host, lobby phase
{ type: 'play', cardId, color? }                       // color required for wild/wild+4 ("Red"|"Yellow"|"Green"|"Blue")
{ type: 'draw' }                                       // draw one
{ type: 'uno' }                                        // call UNO at 1 card
{ type: 'catch', targetId }                            // catch a player who didn't call UNO
{ type: 'challenge' }                                  // challenge a +4 (3+ players)
{ type: 'openingColor', color }                        // first card was a Wild
{ type: 'nextRound' }                                  // host, at roundEnd
```

## State shape (per player)

`state` delivered to a client is the engine's `serializeFor(userId)` output:

```js
{
  phase: 'lobby'|'playing'|'roundEnd'|'gameOver',
  capacity, hostUserId, players: [...publicPlayer],
  me: { userId, hand: [card], isTurn, hasDrawn },      // only for you
  turnUserId, direction, currentColor, topCard,
  deckCount, deadline, serverTime,
  pendingChallenge?, openingPick?, roundResult?, gameResult?
}
// publicPlayer: { userId, name, score, cardCount, isHost, unoCalled, catchable }
// card: { id, color, kind: 'number'|'skip'|'reverse'|'drawtwo'|'wild'|'wilddrawfour', value? }
```

Legal-move highlighting should mirror the engine: `Rules.canPlay(card, topCard,
currentColor)` — wilds always playable; after a wild only `color === currentColor`;
otherwise color, kind, or number match.

## Regenerating the engine bundle

After changing the Roblox sources, regenerate the committed artifact so Render
needs no access to `uno-roblox`:

```bash
sh server/engine/gen_bundle.sh     # reads ../uno-roblox/src, writes web_engine.lua
```
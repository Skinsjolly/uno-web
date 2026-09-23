// store.mjs — user persistence. Uses Postgres when DATABASE_URL is set
// (Render), otherwise a lightweight in-memory store for local dev/e2e.
import pg from 'pg'

const has = (o) => !!o && !!o.rows

function makePgStore(databaseUrl) {
  const pool = new pg.Pool({ connectionString: databaseUrl })
  return {
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id BIGSERIAL PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `)
    },
    async createUser(username, passwordHash) {
      try {
        const r = await pool.query(
          'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
          [username, passwordHash],
        )
        const u = r.rows[0]
        return { id: String(u.id), username: u.username }
      } catch (e) {
        if (e && e.code === '23505') throw new Error('username_taken')
        throw e
      }
    },
    async findByName(username) {
      const r = await pool.query(
        'SELECT id, username, password_hash FROM users WHERE username = $1',
        [username],
      )
      if (!r.rows.length) return null
      const u = r.rows[0]
      return { id: String(u.id), username: u.username, passwordHash: u.password_hash }
    },
  }
}

function makeMemoryStore() {
  const map = new Map()
  let nextId = 1
  return {
    async init() {},
    async createUser(username, passwordHash) {
      if (map.has(username)) throw new Error('username_taken')
      const u = { id: String(nextId++), username, passwordHash }
      map.set(username, u)
      return { id: u.id, username: u.username }
    },
    async findByName(username) {
      const u = map.get(username)
      return u ? { ...u } : null
    },
  }
}

export async function createStore() {
  const databaseUrl = process.env.DATABASE_URL
  const store = databaseUrl ? makePgStore(databaseUrl) : makeMemoryStore()
  await store.init()
  return store
}
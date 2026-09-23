// auth.mjs — password hashing (scrypt) + HMAC-SHA256 JWT, zero dependencies.
import { scrypt, randomBytes, createHmac, timingSafeEqual } from 'node:crypto'

const SCRYPT_KEYLEN = 64

const base64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

function b64urlToBuf(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4) s += '='
  return Buffer.from(s, 'base64')
}

export async function hashPassword(password) {
  const salt = randomBytes(16)
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEYLEN, (err, key) => {
      if (err) return reject(err)
      resolve(`scrypt:${salt.toString('hex')}:${key.toString('hex')}`)
    })
  })
}

export async function verifyPassword(password, stored) {
  const parts = stored.split(':')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const salt = Buffer.from(parts[1], 'hex')
  const expected = Buffer.from(parts[2], 'hex')
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEYLEN, (err, key) => {
      if (err) return reject(err)
      resolve(key.length === expected.length && timingSafeEqual(key, expected))
    })
  })
}

export function signToken(user, ttlSec) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const now = Math.floor(Date.now() / 1000)
  const payload = base64url(
    JSON.stringify({ sub: user.id, name: user.username, iat: now, exp: now + (ttlSec || 7 * 86400) }),
  )
  const secret = process.env.JWT_SECRET || 'dev-secret-change-me'
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${sig}`
}

export function verifyToken(token) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) return null
  const secret = process.env.JWT_SECRET || 'dev-secret-change-me'
  const [header, payload, sig] = parts
  const expect = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  if (expect !== sig) return null
  try {
    const data = JSON.parse(b64urlToBuf(payload).toString('utf8'))
    if (data.exp && data.exp < Math.floor(Date.now() / 1000)) return null
    return { id: String(data.sub), name: data.name }
  } catch {
    return null
  }
}
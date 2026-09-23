// client/config.js — origin configuration for the UNO web game.
// In dev, frontend and backend share an origin (Node serves client/), so the
// empty values mean "same origin". For production (Cloudflare Pages frontend +
// Render backend) set the absolute URLs here. NOT loaded by the server; the
// static file is served as-is.
window.UNO_CONFIG = window.UNO_CONFIG || {
  api: '', // e.g. 'https://uno-web-server.onrender.com'
  ws: '',  // e.g. 'wss://uno-web-server.onrender.com/ws'
}
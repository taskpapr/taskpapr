'use strict';
// In-process SSE connections for real-time change notifications.
// Keyed by user ID (string or number).
//
// When any write commits, call emitUserChange(userId) to push a 'change'
// notification to every open EventSource for that user. The client re-fetches
// only when it receives the event — no idle DB queries.
const connections = new Map(); // userId → Set<res>
let closing = false;            // set once shutdown has begun

function addConnection(userId, res) {
  // A stream opened on an already-accepted keep-alive socket after shutdown
  // began would otherwise hold server.close() open; end it straight away.
  if (closing) { res.end(); return; }
  const key = String(userId);
  if (!connections.has(key)) connections.set(key, new Set());
  connections.get(key).add(res);
}

function removeConnection(userId, res) {
  const key = String(userId);
  const set  = connections.get(key);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) connections.delete(key);
}

function emitUserChange(userId) {
  const set = connections.get(String(userId));
  if (!set || set.size === 0) return;
  const payload = 'data: change\n\n';
  for (const res of set) {
    try { res.write(payload); } catch (_) { /* client disconnected */ }
  }
}

// Graceful shutdown: SSE responses never end on their own, so server.close()
// would wait for them forever. End every stream (clients reconnect via
// EventSource + the polling fallback) and refuse new ones from here on.
function closeAllConnections() {
  closing = true;
  for (const set of connections.values()) {
    for (const res of set) {
      try { res.end(); } catch (_) { /* already gone */ }
    }
  }
  connections.clear();
}

module.exports = { addConnection, removeConnection, emitUserChange, closeAllConnections };

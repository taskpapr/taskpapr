'use strict';
// In-process SSE connections for real-time change notifications.
// Keyed by user ID (string or number).
//
// When any write commits, call emitUserChange(userId) to push a 'change'
// notification to every open EventSource for that user. The client re-fetches
// only when it receives the event — no idle DB queries.
const connections = new Map(); // userId → Set<res>

function addConnection(userId, res) {
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

module.exports = { addConnection, removeConnection, emitUserChange };

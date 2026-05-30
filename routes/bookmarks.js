'use strict';

const { queries, queryRun } = require('../db');
const { LIMITS, validateLen, asTrimmedString, checkQuota } = require('../lib/helpers');
const { rateLimitWrites } = require('../lib/rateLimits');
const { emitUserChange } = require('../lib/events');

module.exports = function register(app) {

  // GET /api/bookmarks
  app.get('/api/bookmarks', async (req, res) => {
    res.json(await queries.bookmarks.all.all(req.user.id));
  });

  // POST /api/bookmarks
  app.post('/api/bookmarks', rateLimitWrites, async (req, res) => {
    const { name, x, y, zoom } = req.body;
    const uid = req.user.id;
    const nameTrim = asTrimmedString(name);
    if (!nameTrim) return res.status(400).json({ error: 'name required' });
    if (typeof x !== 'number' || typeof y !== 'number' || typeof zoom !== 'number') {
      return res.status(400).json({ error: 'x, y, zoom must be numbers' });
    }
    const lenErr = validateLen(nameTrim, LIMITS.nameLen, 'Bookmark name');
    if (lenErr) return res.status(400).json({ error: lenErr });
    const quotaErr = await checkQuota('bookmarks', 'user_id', uid, LIMITS.bookmarks, 'Bookmark');
    if (quotaErr) return res.status(429).json({ error: quotaErr });
    const info = await queries.bookmarks.insert.run(uid, nameTrim, x, y, zoom, uid);
    emitUserChange(uid);
    res.json(await queries.bookmarks.byId.get(info.id, uid));
  });

  // PATCH /api/bookmarks/:id — update name, x, y, zoom, and/or position
  app.patch('/api/bookmarks/:id', async (req, res) => {
    const id  = parseInt(req.params.id);
    const uid = req.user.id;
    const current = await queries.bookmarks.byId.get(id, uid);
    if (!current) return res.status(404).json({ error: 'not found' });

    const { name, x, y, zoom, position } = req.body;

    if (name !== undefined) {
      const nameTrim = asTrimmedString(name);
      if (!nameTrim) return res.status(400).json({ error: 'name cannot be empty' });
      await queries.bookmarks.rename.run(nameTrim, id, uid);
    }

    if (x !== undefined || y !== undefined || zoom !== undefined) {
      const newX    = typeof x    === 'number' ? x    : current.x;
      const newY    = typeof y    === 'number' ? y    : current.y;
      const newZoom = typeof zoom === 'number' ? zoom : current.zoom;
      await queryRun(
        'UPDATE bookmarks SET x = ?, y = ?, zoom = ? WHERE id = ? AND user_id = ?',
        [newX, newY, newZoom, id, uid]
      );
    }

    if (position !== undefined) {
      if (typeof position !== 'number') return res.status(400).json({ error: 'position must be a number' });
      await queryRun(
        'UPDATE bookmarks SET position = ? WHERE id = ? AND user_id = ?',
        [position, id, uid]
      );
    }

    emitUserChange(uid);
    res.json(await queries.bookmarks.byId.get(id, uid));
  });

  // DELETE /api/bookmarks/:id
  app.delete('/api/bookmarks/:id', async (req, res) => {
    await queries.bookmarks.delete.run(parseInt(req.params.id), req.user.id);
    emitUserChange(req.user.id);
    res.json({ ok: true });
  });

};

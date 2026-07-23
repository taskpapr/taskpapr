'use strict';

const { queries, queryOne } = require('../db');
const { LIMITS, validateLen, asTrimmedString, checkQuota } = require('../lib/helpers');
const { rateLimitWrites } = require('../lib/rateLimits');
const { emitUserChange } = require('../lib/events');

module.exports = function register(app) {

  app.get('/api/columns', async (req, res) => {
    res.json(await queries.columns.all.all(req.user.id));
  });

  app.post('/api/columns', rateLimitWrites, async (req, res) => {
    const { name, x, y, width, color } = req.body;
    const nameTrim = asTrimmedString(name);
    if (!nameTrim) return res.status(400).json({ error: 'name required' });
    const uid = req.user.id;
    const lenErr = validateLen(nameTrim, LIMITS.nameLen, 'Tile name');
    if (lenErr) return res.status(400).json({ error: lenErr });
    const quotaErr = await checkQuota('columns', 'user_id', uid, LIMITS.tiles, 'Tile');
    if (quotaErr) return res.status(429).json({ error: quotaErr });
    const info = await queries.columns.insert.run(uid, nameTrim, uid, x ?? 0, y ?? 0, width ?? 260, color ?? null);
    emitUserChange(uid);
    res.json(await queries.columns.byId.get(info.id, uid));
  });

  app.patch('/api/columns/:id', async (req, res) => {
    const id  = parseInt(req.params.id);
    const uid = req.user.id;
    const { name, position, x, y, width, color, hidden, scale } = req.body;
    if (name !== undefined) {
      const nameTrim = asTrimmedString(name);
      if (!nameTrim) return res.status(400).json({ error: 'name cannot be empty' });
      const lenErr = validateLen(nameTrim, LIMITS.nameLen, 'Tile name');
      if (lenErr) return res.status(400).json({ error: lenErr });
    }
    if (name     !== undefined) await queries.columns.rename.run(asTrimmedString(name), id, uid);
    if (position !== undefined) await queries.columns.reorder.run(position, id, uid);
    if (x !== undefined && y !== undefined) await queries.columns.move.run(x, y, id, uid);
    if (width    !== undefined) await queries.columns.resize.run(width, id, uid);
    if (color    !== undefined) await queries.columns.setColor.run(color, id, uid);
    if (hidden   !== undefined) await queries.columns.setHidden.run(hidden ? 1 : 0, id, uid);
    if (scale    !== undefined) await queries.columns.setScale.run(Math.max(0.5, Math.min(2.0, Number(scale))), id, uid);
    emitUserChange(uid);
    res.json(await queries.columns.byId.get(id, uid));
  });

  app.delete('/api/columns/:id', async (req, res) => {
    const uid = req.user.id;
    await queries.columns.delete.run(parseInt(req.params.id), uid);
    emitUserChange(uid);
    res.json({ ok: true });
  });

};

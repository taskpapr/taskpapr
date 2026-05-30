'use strict';

const { queries } = require('../db');
const { LIMITS, validateLen, asTrimmedString, checkQuota } = require('../lib/helpers');
const { rateLimitWrites } = require('../lib/rateLimits');
const { emitUserChange } = require('../lib/events');

module.exports = function register(app) {

  app.get('/api/goals', async (req, res) => {
    res.json(await queries.goals.all.all(req.user.id));
  });

  app.post('/api/goals', rateLimitWrites, async (req, res) => {
    const { title, notes } = req.body;
    const uid = req.user.id;
    const titleTrim = asTrimmedString(title);
    if (!titleTrim) return res.status(400).json({ error: 'title required' });
    const lenErr = validateLen(titleTrim, LIMITS.nameLen, 'Goal title');
    if (lenErr) return res.status(400).json({ error: lenErr });
    const quotaErr = await checkQuota('goals', 'user_id', uid, LIMITS.goals, 'Goal');
    if (quotaErr) return res.status(429).json({ error: quotaErr });
    const notesVal = (typeof notes === 'string' && notes) ? notes : null;
    const info = await queries.goals.insert.run(uid, titleTrim, notesVal, uid);
    emitUserChange(uid);
    res.json(await queries.goals.byId.get(info.id, uid));
  });

  app.patch('/api/goals/:id', async (req, res) => {
    const id  = parseInt(req.params.id);
    const uid = req.user.id;
    const { title, notes } = req.body;
    const current = await queries.goals.byId.get(id, uid);
    if (!current) return res.status(404).json({ error: 'not found' });
    if (title !== undefined && typeof title !== 'string') return res.status(400).json({ error: 'title must be a string' });
    await queries.goals.update.run(
      title !== undefined ? (title.trim() || current.title) : current.title,
      notes !== undefined ? ((typeof notes === 'string' && notes) ? notes : null) : current.notes,
      id,
      uid
    );
    emitUserChange(uid);
    res.json(await queries.goals.byId.get(id, uid));
  });

  app.delete('/api/goals/:id', async (req, res) => {
    const uid = req.user.id;
    await queries.goals.delete.run(parseInt(req.params.id), uid);
    emitUserChange(uid);
    res.json({ ok: true });
  });

};

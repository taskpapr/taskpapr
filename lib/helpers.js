'use strict';
const { queryOne } = require('../db');

const LIMITS = {
  tasks:     parseInt(process.env.LIMIT_TASKS     || '2000'),
  tiles:     parseInt(process.env.LIMIT_TILES     || '50'),
  goals:     parseInt(process.env.LIMIT_GOALS     || '50'),
  bookmarks: parseInt(process.env.LIMIT_BOOKMARKS || '20'),
  titleLen:  parseInt(process.env.LIMIT_TITLE_LEN || '500'),
  nameLen:   parseInt(process.env.LIMIT_NAME_LEN  || '100'),
  notesLen:  parseInt(process.env.LIMIT_NOTES_LEN || '50000'),
};

function validateLen(value, max, fieldName) {
  if (typeof value === 'string' && value.length > max) {
    return `${fieldName} must be ${max} characters or fewer (got ${value.length})`;
  }
  return null;
}

function asTrimmedString(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t ? t : null;
}

function asLowerTrimmedString(value) {
  const t = asTrimmedString(value);
  return t ? t.toLowerCase() : null;
}

// Escape user-authored text for Telegram parse_mode:'HTML' messages.
// Telegram rejects the entire message (HTTP 400) if it contains an
// unescaped < or & — one weird task title would silently kill a digest.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Accepted race: the count-then-insert window means a burst of concurrent
// creates can land a few rows past the limit. Quotas are resource guards,
// not billing enforcement — a handful over is harmless, so no lock is taken.
async function checkQuota(table, userIdCol, userId, limit, resource) {
  const row = await queryOne(`SELECT COUNT(*) as c FROM ${table} WHERE ${userIdCol} = ?`, [userId]);
  if (row && row.c >= limit) {
    return `${resource} limit reached (max ${limit})`;
  }
  return null;
}

// Returns YYYY-MM-DD of the next due date given a current date and recurrence string.
// Supported formats: daily, weekly, monthly, Nd, Nw, Nm (e.g. "7d", "2w", "1m")
function advanceDate(fromDateStr, recurrence) {
  const d = new Date(fromDateStr + 'T12:00:00Z'); // noon UTC avoids DST edge cases
  const r = (typeof recurrence === 'string' ? recurrence : '').toLowerCase().trim();

  if (r === 'daily'  || r === '1d') { d.setUTCDate(d.getUTCDate() + 1); }
  else if (r === 'weekly' || r === '1w') { d.setUTCDate(d.getUTCDate() + 7); }
  else if (r === 'monthly' || r === '1m') { d.setUTCMonth(d.getUTCMonth() + 1); }
  else {
    const match = r.match(/^(\d+)([dwm])$/);
    if (match) {
      const n    = parseInt(match[1]);
      const unit = match[2];
      if (unit === 'd') d.setUTCDate(d.getUTCDate() + n);
      else if (unit === 'w') d.setUTCDate(d.getUTCDate() + n * 7);
      else if (unit === 'm') d.setUTCMonth(d.getUTCMonth() + n);
    } else {
      d.setUTCDate(d.getUTCDate() + 7); // unknown format → +7d
    }
  }
  return d.toISOString().slice(0, 10);
}

module.exports = { LIMITS, validateLen, asTrimmedString, asLowerTrimmedString, escapeHtml, checkQuota, advanceDate };

'use strict';
const rateLimit = require('express-rate-limit');

const rateLimitGlobal = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_GLOBAL || '300'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please slow down.' },
});

const rateLimitWrites = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_WRITES || '30'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many write requests — please slow down.' },
});

const rateLimitAuth = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_AUTH || '20'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts — please slow down.' },
});

module.exports = { rateLimitGlobal, rateLimitWrites, rateLimitAuth };

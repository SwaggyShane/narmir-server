const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'narmir-dev-secret-change-in-prod';

function requireAuth(req, res, next) {
  const token = req.cookies?.token
    || req.headers.authorization?.replace('Bearer ', '')
    || req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    req.player = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  const token = req.cookies?.token
    || req.headers.authorization?.replace('Bearer ', '')
    || req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    req.player = jwt.verify(token, JWT_SECRET);
    if (!req.player.isAdmin) return res.status(403).json({ error: 'Admin access required' });
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { requireAuth, requireAdmin };

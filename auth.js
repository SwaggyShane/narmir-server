// src/routes/auth.js
const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'narmir-dev-secret-change-in-prod';

module.exports = function(db) {

  router.post('/register', async (req, res) => {
    const { username, password, kingdomName, race } = req.body;
    if (!username || !password || !kingdomName)
      return res.status(400).json({ error: 'username, password and kingdomName are required' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const validRaces = ['human','high_elf','dwarf','dire_wolf','dark_elf','orc'];
    const chosenRace = validRaces.includes(race) ? race : 'human';

    try {
      const hash = bcrypt.hashSync(password, 10);
      const playerResult = await db.run(
        'INSERT INTO players (username, password) VALUES (?, ?)', [username, hash]
      );
      await db.run(
        'INSERT INTO kingdoms (player_id, name, race, gold, land, population, researchers, turns_stored) VALUES (?, ?, ?, 10000, 500, 50000, 500, 200)',
        [playerResult.lastID, kingdomName, chosenRace]
      );
      const token = jwt.sign({ playerId: playerResult.lastID, username }, JWT_SECRET, { expiresIn: '30d' });
      res.cookie('token', token, { httpOnly: true, maxAge: 30*24*60*60*1000 });
      res.json({ ok: true, username, kingdomName });
    } catch (err) {
      if (err.message.includes('UNIQUE'))
        return res.status(409).json({ error: 'Username already taken' });
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'username and password required' });
    const player = await db.get('SELECT * FROM players WHERE username = ?', [username]);
    if (!player || !bcrypt.compareSync(password, player.password))
      return res.status(401).json({ error: 'Invalid username or password' });
    const token = jwt.sign({ playerId: player.id, username }, JWT_SECRET, { expiresIn: '30d' });
    res.cookie('token', token, { httpOnly: true, maxAge: 30*24*60*60*1000 });
    res.json({ ok: true, username });
  });

  router.post('/logout', (_req, res) => {
    res.clearCookie('token');
    res.json({ ok: true });
  });

  router.get('/me', (req, res) => {
    const token = req.cookies?.token || req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      res.json({ playerId: decoded.playerId, username: decoded.username });
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  });

  return router;
};

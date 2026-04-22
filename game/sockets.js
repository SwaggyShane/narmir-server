// src/game/sockets.js
const jwt    = require('jsonwebtoken');
const engine = require('./engine');

const JWT_SECRET = process.env.JWT_SECRET || 'narmir-dev-secret-change-in-prod';
const playerSockets = new Map(); // playerId → socketId

module.exports = function(io, db) {

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token
               || socket.handshake.headers?.cookie?.match(/token=([^;]+)/)?.[1];
    if (!token) return next(new Error('Authentication required'));
    try {
      socket.player = jwt.verify(token, JWT_SECRET);
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', async (socket) => {
    const { playerId, username } = socket.player;
    playerSockets.set(playerId, socket.id);

    const kingdom = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [playerId]);
    if (!kingdom) return socket.disconnect();

    socket.join(`kingdom:${kingdom.id}`);
    socket.join('global');

    const membership = await db.get(
      'SELECT alliance_id FROM alliance_members WHERE kingdom_id = ?', [kingdom.id]
    );
    if (membership) socket.join(`alliance:${membership.alliance_id}`);

    const unread = await db.get(
      'SELECT COUNT(*) as c FROM news WHERE kingdom_id = ? AND is_read = 0', [kingdom.id]
    );
    socket.emit('unread_news', { count: unread.c });

    console.log(`[socket] ${username} (${kingdom.name}) connected`);

    // ── ATTACK ──────────────────────────────────────────────────────────────
    socket.on('action:attack', async (data, ack) => {
      const { targetId, fighters, mages } = data;
      if (!targetId || !fighters) return ack?.({ error: 'targetId and fighters required' });

      const attacker = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [playerId]);
      if (attacker.turns_stored < 1) return ack?.({ error: 'No turns available' });
      const defender = await db.get('SELECT * FROM kingdoms WHERE id = ?', [targetId]);
      if (!defender) return ack?.({ error: 'Target not found' });
      if (attacker.id === defender.id) return ack?.({ error: 'Cannot attack yourself' });

      const result = engine.resolveMilitaryAttack(attacker, defender, Number(fighters), Number(mages) || 0);
      if (result.error) return ack?.({ error: result.error });

      result.attackerUpdates.turns_stored = attacker.turns_stored - 1;
      await applyUpdates(db, attacker.id, result.attackerUpdates);
      await applyUpdates(db, defender.id, result.defenderUpdates);

      await db.run(
        'INSERT INTO combat_log (attacker_id, defender_id, type, attacker_won, land_transferred, detail) VALUES (?, ?, ?, ?, ?, ?)',
        [attacker.id, defender.id, 'military', result.win ? 1 : 0, result.report.landTransferred, JSON.stringify(result.report)]
      );
      await insertNews(db, attacker.id, 'attack', result.atkEvent);
      await insertNews(db, defender.id, 'attack', result.defEvent);

      const defSocketId = playerSockets.get(defender.player_id);
      if (defSocketId) {
        io.to(defSocketId).emit('event:attack_received', {
          from: attacker.name, message: result.defEvent, report: result.report
        });
      }

      ack?.({ ok: true, report: result.report, turns_stored: result.attackerUpdates.turns_stored });
    });

    // ── SPELL ────────────────────────────────────────────────────────────────
    socket.on('action:spell', async (data, ack) => {
      const { targetId, spellId, power, duration, obscure } = data;
      const caster = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [playerId]);
      if (caster.turns_stored < 1) return ack?.({ error: 'No turns available' });
      const target = await db.get('SELECT * FROM kingdoms WHERE id = ?', [targetId]);
      if (!target) return ack?.({ error: 'Target not found' });

      const result = engine.castSpell(caster, target, spellId, Number(power) || 1000, Number(duration) || 1, Boolean(obscure));
      if (result.error) return ack?.({ error: result.error });

      result.casterUpdates.turns_stored = caster.turns_stored - 1;
      await applyUpdates(db, caster.id, result.casterUpdates);
      if (result.targetUpdates && Object.keys(result.targetUpdates).length > 0)
        await applyUpdates(db, target.id, result.targetUpdates);

      if (result.casterEvent) await insertNews(db, caster.id, 'spell', result.casterEvent);
      if (result.targetEvent) await insertNews(db, target.id, 'spell', result.targetEvent);

      const tgtSocketId = playerSockets.get(target.player_id);
      if (tgtSocketId && result.targetEvent)
        io.to(tgtSocketId).emit('event:spell_received', { from: obscure ? null : caster.name, spellId, message: result.targetEvent });

      ack?.({ ok: true, report: result.report, turns_stored: result.casterUpdates.turns_stored });
    });

    // ── COVERT: SPY ──────────────────────────────────────────────────────────
    socket.on('action:spy', async (data, ack) => {
      const spy    = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [playerId]);
      const target = await db.get('SELECT * FROM kingdoms WHERE id = ?', [data.targetId]);
      if (!target) return ack?.({ error: 'Target not found' });
      const result = engine.covertSpy(spy, target, Number(data.units) || 100);
      if (Object.keys(result.spyUpdates || {}).length) await applyUpdates(db, spy.id, result.spyUpdates);
      await insertNews(db, spy.id, 'covert', result.spyEvent);
      if (result.targetEvent) {
        await insertNews(db, target.id, 'covert', result.targetEvent);
        const s = playerSockets.get(target.player_id);
        if (s) io.to(s).emit('event:covert', { message: result.targetEvent });
      }
      ack?.({ ok: true, success: result.success, report: result.report || null });
    });

    // ── COVERT: LOOT ─────────────────────────────────────────────────────────
    socket.on('action:loot', async (data, ack) => {
      const thief  = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [playerId]);
      const target = await db.get('SELECT * FROM kingdoms WHERE id = ?', [data.targetId]);
      if (!target) return ack?.({ error: 'Target not found' });
      const result = engine.covertLoot(thief, target, data.lootType, Number(data.thieves) || 100);
      if (result.error) return ack?.({ error: result.error });
      if (Object.keys(result.thiefUpdates || {}).length) await applyUpdates(db, thief.id, result.thiefUpdates);
      if (result.success && Object.keys(result.targetUpdates || {}).length) await applyUpdates(db, target.id, result.targetUpdates);
      await insertNews(db, thief.id, 'covert', result.thiefEvent || result.event);
      if (result.targetEvent) {
        await insertNews(db, target.id, 'covert', result.targetEvent);
        const s = playerSockets.get(target.player_id);
        if (s) io.to(s).emit('event:covert', { message: result.targetEvent });
      }
      ack?.({ ok: true, success: result.success, stolen: result.stolen });
    });

    // ── COVERT: ASSASSINATE ──────────────────────────────────────────────────
    socket.on('action:assassinate', async (data, ack) => {
      const assassin = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [playerId]);
      const target   = await db.get('SELECT * FROM kingdoms WHERE id = ?', [data.targetId]);
      if (!target) return ack?.({ error: 'Target not found' });
      const result = engine.covertAssassinate(assassin, target, Number(data.ninjas) || 50, data.unitType);
      if (result.error) return ack?.({ error: result.error });
      if (Object.keys(result.assassinUpdates || {}).length) await applyUpdates(db, assassin.id, result.assassinUpdates);
      if (result.success && Object.keys(result.targetUpdates || {}).length) await applyUpdates(db, target.id, result.targetUpdates);
      await insertNews(db, assassin.id, 'covert', result.assassinEvent || result.event);
      if (result.targetEvent) {
        await insertNews(db, target.id, 'covert', result.targetEvent);
        const s = playerSockets.get(target.player_id);
        if (s) io.to(s).emit('event:covert', { message: result.targetEvent });
      }
      ack?.({ ok: true, success: result.success, killed: result.killed });
    });

    // ── GLOBAL CHAT ──────────────────────────────────────────────────────────
    socket.on('chat:global', async (data, ack) => {
      const msg = (data.message || '').trim().slice(0, 300);
      if (!msg) return;
      const k = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [playerId]);
      await db.run('INSERT INTO chat_messages (kingdom_id, room, message) VALUES (?, ?, ?)', [k.id, 'global', msg]);
      io.to('global').emit('chat:message', { room: 'global', from: k.name, race: k.race, message: msg, ts: Date.now() });
      ack?.({ ok: true });
    });

    // ── ALLIANCE CHAT ────────────────────────────────────────────────────────
    socket.on('chat:alliance', async (data, ack) => {
      const msg = (data.message || '').trim().slice(0, 300);
      if (!msg) return;
      const k = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [playerId]);
      const m = await db.get('SELECT alliance_id FROM alliance_members WHERE kingdom_id = ?', [k.id]);
      if (!m) return ack?.({ error: 'Not in an alliance' });
      await db.run('INSERT INTO chat_messages (kingdom_id, room, message) VALUES (?, ?, ?)', [k.id, String(m.alliance_id), msg]);
      io.to(`alliance:${m.alliance_id}`).emit('chat:message', { room: 'alliance', from: k.name, race: k.race, message: msg, ts: Date.now() });
      ack?.({ ok: true });
    });

    socket.on('disconnect', () => {
      playerSockets.delete(playerId);
      console.log(`[socket] ${username} disconnected`);
    });
  });
};

async function applyUpdates(db, kingdomId, updates) {
  if (!updates || Object.keys(updates).length === 0) return;
  const cols = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  await db.run(`UPDATE kingdoms SET ${cols} WHERE id = ?`, [...Object.values(updates), kingdomId]);
}

async function insertNews(db, kingdomId, type, message, turnNum) {
  await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?, ?, ?, ?)', [kingdomId, type, message, turnNum || 0]);
}

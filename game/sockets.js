const jwt    = require('jsonwebtoken');
const engine = require('./engine');

const JWT_SECRET = process.env.JWT_SECRET || 'narmir-dev-secret-change-in-prod';
const onlinePlayers = new Map(); // playerId → { socketId, username, race, isMod, isAdmin, kingdomName }

module.exports = function(io, db) {

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token
               || socket.handshake.headers?.cookie?.match(/token=([^;]+)/)?.[1];
    if (!token) return next(new Error('Authentication required'));
    try { socket.player = jwt.verify(token, JWT_SECRET); next(); }
    catch { next(new Error('Invalid token')); }
  });

  io.on('connection', async (socket) => {
    const { playerId, username } = socket.player;

    const player  = await db.get('SELECT id, username, is_admin, is_chat_mod, chat_banned FROM players WHERE id = ?', [playerId]);
    const kingdom = await db.get('SELECT id, name, race FROM kingdoms WHERE player_id = ?', [playerId]);
    if (!kingdom || !player) return socket.disconnect();

    if (player.chat_banned) socket.emit('chat:banned', { reason: 'You are banned from chat.' });

    const isMod = !!(player.is_chat_mod || player.is_admin);
    onlinePlayers.set(playerId, { socketId: socket.id, username: player.username, race: kingdom.race, isMod, isAdmin: !!player.is_admin, kingdomName: kingdom.name });

    socket.join(`kingdom:${kingdom.id}`);
    socket.join('global');
    broadcastOnlineList(io);

    const membership = await db.get('SELECT alliance_id FROM alliance_members WHERE kingdom_id = ?', [kingdom.id]);
    if (membership) socket.join(`alliance:${membership.alliance_id}`);

    const unread = await db.get('SELECT COUNT(*) as c FROM news WHERE kingdom_id = ? AND is_read = 0', [kingdom.id]);
    socket.emit('unread_news', { count: unread.c });
    console.log(`[socket] ${username} (${kingdom.name}) connected`);

    // ── ATTACK ───────────────────────────────────────────────────────────────
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
      await db.run('INSERT INTO combat_log (attacker_id, defender_id, type, attacker_won, land_transferred, detail) VALUES (?,?,?,?,?,?)',
        [attacker.id, defender.id, 'military', result.win?1:0, result.report.landTransferred, JSON.stringify(result.report)]);
      await insertNews(db, attacker.id, 'attack', result.atkEvent);
      await insertNews(db, defender.id, 'attack', result.defEvent);
      const defInfo = onlinePlayers.get(defender.player_id);
      if (defInfo) io.to(defInfo.socketId).emit('event:attack_received', { from: attacker.name, message: result.defEvent, report: result.report });
      ack?.({ ok: true, report: result.report, turns_stored: result.attackerUpdates.turns_stored });
    });

    // ── SPELL ────────────────────────────────────────────────────────────────
    socket.on('action:spell', async (data, ack) => {
      const caster = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [playerId]);
      if (caster.turns_stored < 1) return ack?.({ error: 'No turns available' });
      const target = await db.get('SELECT * FROM kingdoms WHERE id = ?', [data.targetId]);
      if (!target) return ack?.({ error: 'Target not found' });
      const result = engine.castSpell(caster, target, data.spellId, Boolean(data.obscure));
      if (result.error) return ack?.({ error: result.error });
      result.casterUpdates.turns_stored = caster.turns_stored - 1;
      await applyUpdates(db, caster.id, result.casterUpdates);
      if (result.targetUpdates && Object.keys(result.targetUpdates).length)
        await applyUpdates(db, target.id, result.targetUpdates);
      if (result.casterEvent) await insertNews(db, caster.id, 'spell', result.casterEvent);
      if (result.targetEvent) await insertNews(db, target.id, 'spell', result.targetEvent);
      const tgtInfo = onlinePlayers.get(target.player_id);
      if (tgtInfo && result.targetEvent) io.to(tgtInfo.socketId).emit('event:spell_received', { from: data.obscure?null:caster.name, spellId: data.spellId, message: result.targetEvent });
      ack?.({ ok: true, report: result.report, turns_stored: result.casterUpdates.turns_stored });
    });

    // ── COVERT ───────────────────────────────────────────────────────────────
    socket.on('action:spy', async (data, ack) => {
      const spy = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [playerId]);
      const target = await db.get('SELECT * FROM kingdoms WHERE id = ?', [data.targetId]);
      if (!target) return ack?.({ error: 'Target not found' });
      const result = engine.covertSpy(spy, target, Number(data.units)||100);
      const upd = result.spyUpdates||{}; const xp = engine.awardXp(spy,'covert',1);
      upd.xp = xp.xp; upd.level = xp.level;
      if (Object.keys(upd).length) await applyUpdates(db, spy.id, upd);
      await insertNews(db, spy.id, 'covert', result.spyEvent);
      if (result.targetEvent) { await insertNews(db, target.id, 'covert', result.targetEvent); const ti = onlinePlayers.get(target.player_id); if(ti) io.to(ti.socketId).emit('event:covert',{message:result.targetEvent}); }
      ack?.({ ok:true, success:result.success, report:result.report||null });
    });

    socket.on('action:loot', async (data, ack) => {
      const thief = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [playerId]);
      const target = await db.get('SELECT * FROM kingdoms WHERE id = ?', [data.targetId]);
      if (!target) return ack?.({ error: 'Target not found' });
      const result = engine.covertLoot(thief, target, data.lootType, Number(data.thieves)||100);
      if (result.error) return ack?.({ error: result.error });
      const upd = result.thiefUpdates||{}; const xp = engine.awardXp(thief,'covert',1);
      upd.xp = xp.xp; upd.level = xp.level;
      if (Object.keys(upd).length) await applyUpdates(db, thief.id, upd);
      if (result.success && result.targetUpdates) await applyUpdates(db, target.id, result.targetUpdates);
      await insertNews(db, thief.id, 'covert', result.thiefEvent||result.event);
      if (result.targetEvent) { await insertNews(db, target.id, 'covert', result.targetEvent); const ti = onlinePlayers.get(target.player_id); if(ti) io.to(ti.socketId).emit('event:covert',{message:result.targetEvent}); }
      ack?.({ ok:true, success:result.success, stolen:result.stolen });
    });

    socket.on('action:assassinate', async (data, ack) => {
      const assassin = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [playerId]);
      const target   = await db.get('SELECT * FROM kingdoms WHERE id = ?', [data.targetId]);
      if (!target) return ack?.({ error: 'Target not found' });
      const result = engine.covertAssassinate(assassin, target, Number(data.ninjas)||50, data.unitType);
      if (result.error) return ack?.({ error: result.error });
      const upd = result.assassinUpdates||{}; const xp = engine.awardXp(assassin,'covert',1);
      upd.xp = xp.xp; upd.level = xp.level;
      if (Object.keys(upd).length) await applyUpdates(db, assassin.id, upd);
      if (result.success && result.targetUpdates) await applyUpdates(db, target.id, result.targetUpdates);
      await insertNews(db, assassin.id, 'covert', result.assassinEvent||result.event);
      if (result.targetEvent) { await insertNews(db, target.id, 'covert', result.targetEvent); const ti = onlinePlayers.get(target.player_id); if(ti) io.to(ti.socketId).emit('event:covert',{message:result.targetEvent}); }
      ack?.({ ok:true, success:result.success, killed:result.killed });
    });

    // ── GLOBAL CHAT ──────────────────────────────────────────────────────────
    socket.on('chat:global', async (data, ack) => {
      const p = await db.get('SELECT chat_banned, is_chat_mod, is_admin FROM players WHERE id = ?', [playerId]);
      if (p?.chat_banned) return ack?.({ error: 'You are banned from chat.' });

      const raw = (data.message || '').trim().slice(0, 300);
      if (!raw) return;

      const modPriv = !!(p?.is_chat_mod || p?.is_admin);

      // IRC commands
      if (raw.startsWith('/')) {
        const parts = raw.slice(1).split(' ');
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1);

        if (cmd === 'me') {
          const action = args.join(' ').trim();
          if (!action) return ack?.({ error: 'Usage: /me <action>' });
          await db.run('INSERT INTO chat_messages (kingdom_id,player_id,username,room,message) VALUES (?,?,?,?,?)',
            [kingdom.id, playerId, username, 'global', `/me ${action}`]);
          io.to('global').emit('chat:message', { room:'global', type:'me', from:username, race:kingdom.race, isMod:modPriv, message:action, ts:Date.now() });
          return ack?.({ ok:true });
        }

        if (cmd === 'msg' || cmd === 'pm' || cmd === 'whisper') {
          const targetName = args[0]; const pmMsg = args.slice(1).join(' ').trim();
          if (!targetName || !pmMsg) return ack?.({ error: 'Usage: /msg <username> <message>' });
          const tInfo = [...onlinePlayers.values()].find(p => p.username === targetName);
          if (!tInfo) return ack?.({ error: `${targetName} is not online` });
          io.to(tInfo.socketId).emit('chat:whisper', { from:username, message:pmMsg, ts:Date.now() });
          socket.emit('chat:whisper_sent', { to:targetName, message:pmMsg, ts:Date.now() });
          return ack?.({ ok:true });
        }

        if (!modPriv) return ack?.({ error: `Unknown command /${cmd}. Try /me or /msg <user> <text>` });

        if (cmd === 'kick') {
          const targetName = args[0]; const reason = args.slice(1).join(' ') || 'No reason given';
          const tInfo = [...onlinePlayers.values()].find(p => p.username === targetName);
          if (!tInfo) return ack?.({ error: `${targetName} is not online` });
          io.to(tInfo.socketId).emit('chat:kicked', { reason });
          io.to('global').emit('chat:system', { message:`🔨 ${targetName} was kicked. (${reason})`, ts:Date.now() });
          return ack?.({ ok:true });
        }

        if (cmd === 'ban') {
          const targetName = args[0]; const reason = args.slice(1).join(' ') || 'No reason given';
          const tp = await db.get('SELECT id, is_admin FROM players WHERE username = ?', [targetName]);
          if (!tp) return ack?.({ error: `User "${targetName}" not found` });
          if (tp.is_admin) return ack?.({ error: 'Cannot ban an admin.' });
          await db.run('UPDATE players SET chat_banned=1, chat_ban_reason=? WHERE id=?', [reason, tp.id]);
          const tInfo = [...onlinePlayers.values()].find(p => p.username === targetName);
          if (tInfo) io.to(tInfo.socketId).emit('chat:banned', { reason });
          io.to('global').emit('chat:system', { message:`🔨 ${targetName} has been banned from chat. (${reason})`, ts:Date.now() });
          return ack?.({ ok:true });
        }

        if (cmd === 'unban') {
          const targetName = args[0];
          await db.run('UPDATE players SET chat_banned=0, chat_ban_reason=NULL WHERE username=?', [targetName]);
          io.to('global').emit('chat:system', { message:`✅ ${targetName} has been unbanned from chat.`, ts:Date.now() });
          return ack?.({ ok:true });
        }

        if (cmd === 'delete') {
          const msgId = parseInt(args[0]);
          if (!msgId) return ack?.({ error: 'Usage: /delete <message_id>' });
          await db.run('UPDATE chat_messages SET deleted=1 WHERE id=?', [msgId]);
          io.to('global').emit('chat:delete', { id:msgId });
          return ack?.({ ok:true });
        }

        return ack?.({ error: `Unknown mod command /${cmd}` });
      }

      // Normal message
      const res = await db.run('INSERT INTO chat_messages (kingdom_id,player_id,username,room,message) VALUES (?,?,?,?,?)',
        [kingdom.id, playerId, username, 'global', raw]);
      io.to('global').emit('chat:message', { id:res.lastID, room:'global', type:'normal', from:username, race:kingdom.race, isMod:modPriv, message:raw, ts:Date.now() });
      ack?.({ ok:true });
    });

    // ── ALLIANCE CHAT ────────────────────────────────────────────────────────
    socket.on('chat:alliance', async (data, ack) => {
      const msg = (data.message||'').trim().slice(0, 300);
      if (!msg) return;
      const m = await db.get('SELECT alliance_id FROM alliance_members WHERE kingdom_id=?', [kingdom.id]);
      if (!m) return ack?.({ error:'Not in an alliance' });
      await db.run('INSERT INTO chat_messages (kingdom_id,player_id,username,room,message) VALUES (?,?,?,?,?)',
        [kingdom.id, playerId, username, String(m.alliance_id), msg]);
      io.to(`alliance:${m.alliance_id}`).emit('chat:message', { room:'alliance', from:username, race:kingdom.race, message:msg, ts:Date.now() });
      ack?.({ ok:true });
    });

    socket.on('disconnect', () => {
      onlinePlayers.delete(playerId);
      broadcastOnlineList(io);
      console.log(`[socket] ${username} disconnected`);
    });
  });

  // REST endpoint helper
  io.onlinePlayersList = () => [...onlinePlayers.values()].map(p => ({ username:p.username, race:p.race, isMod:p.isMod }));
};

function broadcastOnlineList(io) {
  const list = [...onlinePlayers.values()].map(p => ({ username:p.username, race:p.race, isMod:p.isMod }));
  io.to('global').emit('chat:online', { users:list });
}

async function applyUpdates(db, kingdomId, updates) {
  if (!updates || !Object.keys(updates).length) return;
  const cols = Object.keys(updates).map(k=>`${k} = ?`).join(', ');
  await db.run(`UPDATE kingdoms SET ${cols} WHERE id=?`, [...Object.values(updates), kingdomId]);
}

async function insertNews(db, kingdomId, type, message, turnNum) {
  await db.run('INSERT INTO news (kingdom_id,type,message,turn_num) VALUES (?,?,?,?)', [kingdomId, type, message, turnNum||0]);
}

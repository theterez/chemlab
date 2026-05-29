// api/server.js
const crypto = require('crypto');
const admin = require('firebase-admin');

// Inicializace Firebase bez složitých autentizací – přímo přes URL databáze
if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://chemlab-33ea2-default-rtdb.europe-west1.firebasedatabase.app"
  });
}

const db = admin.database();

// Pomocné funkce pro generování ID a kódů místností
function id(bytes = 12) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function roomCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function cleanName(name) {
  return String(name || '')
    .replace(/[^\p{L}\p{N} _.-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 18) || 'Hrac';
}

// Převod dat z Firebase do formátu, který očekává tvůj frontend
function formatSnapshot(roomData, includeSessionIds = false) {
  if (!roomData) return null;
  
  const playersArray = [];
  if (roomData.players) {
    Object.entries(roomData.players).forEach(([sessionId, p]) => {
      playersArray.push({
        id: includeSessionIds ? sessionId : undefined,
        name: p.name,
        score: p.score || 0,
        completed: p.completed || 0,
        joinedAt: p.joinedAt
      });
    });
  }

  // Seřazení podle bodů (kdo má víc, je první)
  playersArray.sort((a, b) => b.score - a.score || b.completed - a.completed || a.joinedAt - b.joinedAt);

  const now = Date.now();
  const elapsed = roomData.startedAt ? Math.floor((now - roomData.startedAt) / 1000) : 0;
  const timeLeft = roomData.status === 'running' ? Math.max(0, (roomData.roundSeconds || 90) - elapsed) : (roomData.roundSeconds || 90);

  return {
    room: roomData.code,
    status: roomData.status,
    roundSeconds: roomData.roundSeconds || 90,
    timeLeft: roomData.status === 'running' ? timeLeft : roomData.status === 'finished' ? 0 : (roomData.roundSeconds || 90),
    players: playersArray
  };
}

// Pomocné funkce pro zpracování požadavků
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
  });
}

function json(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

// Hlavní tělo serverless funkce pro Vercel
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const host = req.headers.host || 'chemlabproject.vercel.app';

    // 1. Test funkčnosti serveru
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, { ok: true });
    }

    // 2. Vytvoření nové místnosti učitelem
    if (req.method === 'POST' && url.pathname === '/api/rooms') {
      const code = roomCode();
      const roomHostKey = id(18);
      
      const newRoom = {
        code,
        hostKey: roomHostKey,
        status: 'lobby',
        roundSeconds: 90,
        startedAt: null,
        finishedAt: null,
        createdAt: Date.now(),
        players: {}
      };

      // Uložení místnosti do Firebase
      await db.ref(`rooms/${code}`).set(newRoom);

      const origin = `https://${host}`;
      return json(res, 200, {
        room: code,
        hostKey: roomHostKey,
        joinUrl: `${origin}/?room=${code}`,
        hostUrl: `${origin}/?host=${roomHostKey}&room=${code}`
      });
    }

    // 3. Kontrola stavu místnosti (pro polling z frontendu)
    if (req.method === 'GET' && url.pathname === '/api/room') {
      const roomParam = (url.searchParams.get('room') || '').toUpperCase();
      const roomSnapshot = await db.ref(`rooms/${roomParam}`).once('value');
      
      if (!roomSnapshot.exists()) return json(res, 404, { error: 'Room not found' });
      
      const roomData = roomSnapshot.val();
      const isHost = url.searchParams.get('hostKey') === roomData.hostKey;
      return json(res, 200, formatSnapshot(roomData, isHost));
    }

    // 4. Připojení nového žáka do čekárny
    if (req.method === 'POST' && url.pathname === '/api/join') {
      const body = await readJson(req);
      const roomParam = String(body.room || '').toUpperCase();
      
      const roomRef = db.ref(`rooms/${roomParam}`);
      const roomSnapshot = await roomRef.once('value');
      
      if (!roomSnapshot.exists()) return json(res, 404, { error: 'Místnost neexistuje' });
      const roomData = roomSnapshot.val();
      if (roomData.status !== 'lobby') return json(res, 409, { error: 'Hra již byla spuštěna' });

      const sessionId = id();
      const newPlayer = {
        sessionId,
        name: cleanName(body.name),
        score: 0,
        completed: 0,
        joinedAt: Date.now()
      };

      await roomRef.child(`players/${sessionId}`).set(newPlayer);
      
      const updatedSnapshot = await roomRef.once('value');
      return json(res, 200, { sessionId, snapshot: formatSnapshot(updatedSnapshot.val()) });
    }

    // 5. Spuštění odpočtu učitelem
    if (req.method === 'POST' && url.pathname === '/api/start') {
      const body = await readJson(req);
      const roomParam = String(body.room || '').toUpperCase();
      
      const roomRef = db.ref(`rooms/${roomParam}`);
      const roomSnapshot = await roomRef.once('value');
      
      if (!roomSnapshot.exists() || body.hostKey !== roomSnapshot.val().hostKey) {
        return json(res, 403, { error: 'Neoprávněný přístup' });
      }

      const updates = {
        status: 'running',
        startedAt: Date.now(),
        finishedAt: null
      };

      // Vynulování bodů všem připojeným pro jistotu
      const roomData = roomSnapshot.val();
      if (roomData.players) {
        Object.keys(roomData.players).forEach(pId => {
          updates[`players/${pId}/score`] = 0;
          updates[`players/${pId}/completed`] = 0;
        });
      }

      await roomRef.update(updates);
      const updatedSnapshot = await roomRef.once('value');
      return json(res, 200, formatSnapshot(updatedSnapshot.val(), true));
    }

    // 6. Přičtení skóre, když žák složí molekulu správně
    if (req.method === 'POST' && url.pathname === '/api/score') {
      const body = await readJson(req);
      const roomParam = String(body.room || '').toUpperCase();
      
      const roomRef = db.ref(`rooms/${roomParam}`);
      const roomSnapshot = await roomRef.once('value');
      
      if (!roomSnapshot.exists() || roomSnapshot.val().status !== 'running') {
        return json(res, 409, { error: 'Hra neběží' });
      }

      const sessionId = String(body.sessionId || '');
      const playerRef = roomRef.child(`players/${sessionId}`);
      const playerSnapshot = await playerRef.once('value');
      
      if (!playerSnapshot.exists()) return json(res, 403, { error: 'Hráč neexistuje' });

      const delta = Math.max(0, Math.min(80, Number(body.delta || 0)));
      
      // Bezpečné přičtení bodů ve Firebase
      await playerRef.transaction((player) => {
        if (player) {
          player.score = (player.score || 0) + delta;
          player.completed = (player.completed || 0) + 1;
        }
        return player;
      });

      const updatedSnapshot = await roomRef.once('value');
      return json(res, 200, formatSnapshot(updatedSnapshot.val()));
    }

    // 7. Konec hry učitelem (vypršel čas nebo stopnuto ručně)
    if (req.method === 'POST' && url.pathname === '/api/finish') {
      const body = await readJson(req);
      const roomParam = String(body.room || '').toUpperCase();
      
      const roomRef = db.ref(`rooms/${roomParam}`);
      const roomSnapshot = await roomRef.once('value');
      
      if (!roomSnapshot.exists() || body.hostKey !== roomSnapshot.val().hostKey) {
        return json(res, 403, { error: 'Neoprávněný přístup' });
      }

      await roomRef.update({
        status: 'finished',
        finishedAt: Date.now()
      });

      const updatedSnapshot = await roomRef.once('value');
      return json(res, 200, formatSnapshot(updatedSnapshot.val(), true));
    }

    res.writeHead(404);
    res.end('Nenalezeno');

  } catch (err) {
    console.error(err);
    json(res, 500, { error: 'Chyba na serveru' });
  }
};

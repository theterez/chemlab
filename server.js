// server.js - Upraveno pro Vercel Serverless + Firebase Admin SDK
const crypto = require('crypto');
const QRCode = require('qrcode');
const admin = require('firebase-admin');

// 1. Inicializace Firebase na straně serveru
// Použijeme tvou Realtime Database URL. Klíče jsou bezpečně na backendu.
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(), // Vercel si to přebere automaticky, nebo použije veřejný přístup k RTDB podle pravidel
    databaseURL: "https://chemlab-33ea2-default-rtdb.europe-west1.firebasedatabase.app"
  });
}

const db = admin.database();

// Pomocné funkce pro generování ID (shodné s tvým původním kódem)
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

// Transformace struktury z Firebase pro frontend (aby se nemusel přepisovat frontend)
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

  // Seřazení podle skóre
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

// Pomocná funkce pro čtení JSON těla v Serverless prostředí
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
    'Access-Control-Allow-Origin': '*' // CORS ochrana
  });
  res.end(JSON.stringify(data));
}

// Hlavní exportovaná funkce pro Vercel (místo http.createServer)
module.exports = async (req, res) => {
  // Ošetření CORS předběžných požadavků (Preflight)
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

    // 1. API: HEALTH CHECK
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, { ok: true });
    }

    // 2. API: VYTVOŘENÍ MÍSTNOSTI
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

      // Zápis do Firebase místo lokálního pole
      await db.ref(`rooms/${code}`).set(newRoom);

      const origin = `https://${host}`;
      return json(res, 200, {
        room: code,
        hostKey: roomHostKey,
        joinUrl: `${origin}/?room=${code}`,
        hostUrl: `${origin}/?host=${roomHostKey}&room=${code}`
      });
    }

    // 3. API: GENEROVÁNÍ QR KÓDU (Bez závislosti na lokálním stavu)
    if (req.method === 'GET' && url.pathname === '/api/qr') {
      const roomParam = (url.searchParams.get('room') || '').toUpperCase();
      const roomSnapshot = await db.ref(`rooms/${roomParam}`).once('value');
      
      if (!roomSnapshot.exists()) {
        res.writeHead(404);
        return res.end('Room not found');
      }

      const target = url.searchParams.get('url') || `https://${host}/?room=${roomParam}`;
      const svg = await QRCode.toString(target, {
        type: 'svg',
        margin: 1,
        width: 320,
        color: { dark: '#0a0e1a', light: '#ffffff' }
      });

      res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(svg);
    }

    // 4. API: ZÍSKÁNÍ STAVU MÍSTNOSTI (Polling náhrada za SSE stream)
    if (req.method === 'GET' && url.pathname === '/api/room') {
      const roomParam = (url.searchParams.get('room') || '').toUpperCase();
      const roomSnapshot = await db.ref(`rooms/${roomParam}`).once('value');
      
      if (!roomSnapshot.exists()) return json(res, 404, { error: 'Room not found' });
      
      const roomData = roomSnapshot.val();
      const isHost = url.searchParams.get('hostKey') === roomData.hostKey;
      return json(res, 200, formatSnapshot(roomData, isHost));
    }

    // 5. API: PŘIPOJENÍ ŽÁKA
    if (req.method === 'POST' && url.pathname === '/api/join') {
      const body = await readJson(req);
      const roomParam = String(body.room || '').toUpperCase();
      
      const roomRef = db.ref(`rooms/${roomParam}`);
      const roomSnapshot = await roomRef.once('value');
      
      if (!roomSnapshot.exists()) return json(res, 404, { error: 'Room not found' });
      const roomData = roomSnapshot.val();
      if (roomData.status !== 'lobby') return json(res, 409, { error: 'Game already started' });

      const sessionId = id();
      const newPlayer = {
        sessionId,
        name: cleanName(body.name),
        score: 0,
        completed: 0,
        joinedAt: Date.now()
      };

      await roomRef.child(`players/${sessionId}`).set(newPlayer);
      
      // Načteme čerstvá data po zápisu
      const updatedSnapshot = await roomRef.once('value');
      return json(res, 200, { sessionId, snapshot: formatSnapshot(updatedSnapshot.val()) });
    }

    // 6. API: START HRY UČITELEM
    if (req.method === 'POST' && url.pathname === '/api/start') {
      const body = await readJson(req);
      const roomParam = String(body.room || '').toUpperCase();
      
      const roomRef = db.ref(`rooms/${roomParam}`);
      const roomSnapshot = await roomRef.once('value');
      
      if (!roomSnapshot.exists() || body.hostKey !== roomSnapshot.val().hostKey) {
        return json(res, 403, { error: 'Host key required' });
      }

      const updates = {
        status: 'running',
        startedAt: Date.now(),
        finishedAt: null
      };

      // Vynulování skóre všem hráčům při startu
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

    // 7. API: ODESLÁNÍ SKÓRE ŽÁKEM
    if (req.method === 'POST' && url.pathname === '/api/score') {
      const body = await readJson(req);
      const roomParam = String(body.room || '').toUpperCase();
      
      const roomRef = db.ref(`rooms/${roomParam}`);
      const roomSnapshot = await roomRef.once('value');
      
      if (!roomSnapshot.exists() || roomSnapshot.val().status !== 'running') {
        return json(res, 409, { error: 'Game is not running' });
      }

      const sessionId = String(body.sessionId || '');
      const playerRef = roomRef.child(`players/${sessionId}`);
      const playerSnapshot = await playerRef.once('value');
      
      if (!playerSnapshot.exists()) return json(res, 403, { error: 'Player session required' });

      const delta = Math.max(0, Math.min(80, Number(body.delta || 0)));
      
      // Bezpečné přičtení skóre pomocí Firebase transakce
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

    // 8. API: UKONČENÍ HRY UČITELEM
    if (req.method === 'POST' && url.pathname === '/api/finish') {
      const body = await readJson(req);
      const roomParam = String(body.room || '').toUpperCase();
      
      const roomRef = db.ref(`rooms/${roomParam}`);
      const roomSnapshot = await roomRef.once('value');
      
      if (!roomSnapshot.exists() || body.hostKey !== roomSnapshot.val().hostKey) {
        return json(res, 403, { error: 'Host key required' });
      }

      await roomRef.update({
        status: 'finished',
        finishedAt: Date.now()
      });

      const updatedSnapshot = await roomRef.once('value');
      return json(res, 200, formatSnapshot(updatedSnapshot.val(), true));
    }

    // Pokud požadavek nesplňuje endpointy
    res.writeHead(404);
    res.end('Not Found');

  } catch (err) {
    console.error(err);
    json(res, 500, { error: 'Server error' });
  }
};

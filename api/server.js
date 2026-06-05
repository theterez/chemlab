// api/server.js
const crypto = require('crypto');

// ── Env proměnné (stejný systém jako PhishPond) ──────────────────────────────
const REQUIRED_ENV = [
  'FIREBASE_PROJECT_ID',
  'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_PRIVATE_KEY',
  'FIREBASE_DATABASE_URL',
];

let cachedToken = null;

function getEnv() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Chybí env proměnné: ${missing.join(', ')}`);
  return {
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/^"|"$/g, ''),
    databaseUrl: process.env.FIREBASE_DATABASE_URL.replace(/\/$/, ''),
  };
}

// ── JWT / OAuth ───────────────────────────────────────────────────────────────
function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const env = getEnv();
  const now = Math.floor(Date.now() / 1000);
  const header  = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss:   env.clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  };

  const unsigned  = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(env.privateKey);
  const assertion = `${unsigned}.${b64url(signature)}`;

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error_description || d.error || `OAuth failed ${r.status}`);

  cachedToken = { value: d.access_token, expiresAt: Date.now() + d.expires_in * 1000 };
  return cachedToken.value;
}

// ── Firebase REST ─────────────────────────────────────────────────────────────
async function fbReq(path, opts = {}) {
  const env   = getEnv();
  const token = await getAccessToken();
  const url   = new URL(`${env.databaseUrl}/${path}.json`);

  for (const [k, v] of Object.entries(opts.query || {})) url.searchParams.set(k, v);

  const r = await fetch(url, {
    method:  opts.method || 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(data?.error || `Firebase ${r.status}`);
  return data;
}

// ── Pomocné funkce ────────────────────────────────────────────────────────────
function uid(bytes = 12) { return crypto.randomBytes(bytes).toString('base64url'); }
function roomCode()      { return crypto.randomBytes(3).toString('hex').toUpperCase(); }

function cleanName(name) {
  return String(name || '')
    .replace(/[^\p{L}\p{N} _.-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 18) || 'Hrac';
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; });
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
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function formatSnapshot(roomData, includeIds = false) {
  if (!roomData) return null;

  const players = [];
  for (const [sid, p] of Object.entries(roomData.players || {})) {
    players.push({
      id:        includeIds ? sid : undefined,
      name:      p.name,
      score:     p.score     || 0,
      completed: p.completed || 0,
      joinedAt:  p.joinedAt,
    });
  }
  players.sort((a, b) => b.score - a.score || b.completed - a.completed || a.joinedAt - b.joinedAt);

  const now     = Date.now();
  const elapsed = roomData.startedAt ? Math.floor((now - roomData.startedAt) / 1000) : 0;
  const round   = roomData.roundSeconds || 90;
  const timeLeft = roomData.status === 'running'
    ? Math.max(0, round - elapsed)
    : roomData.status === 'finished' ? 0 : round;

  return {
    room:         roomData.code,
    status:       roomData.status,
    roundSeconds: round,
    timeLeft,
    players,
  };
}

// ── Hlavní handler ────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  try {
    const url  = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const host = req.headers.host || 'chemlabproject.vercel.app';

    // DEBUG
    if (req.method === 'GET' && url.pathname === '/api/debug') {
      const result = {
        env: Object.fromEntries(REQUIRED_ENV.map(k => [k, !!process.env[k]])),
        nodeVersion: process.version,
      };
      try { await fbReq('__ping__'); result.firebase = 'OK'; }
      catch (e) { result.firebase = 'CHYBA: ' + e.message; }
      return json(res, 200, result);
    }

    // HEALTH
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, { ok: true });
    }

    // VYTVOŘENÍ MÍSTNOSTI
    if (req.method === 'POST' && url.pathname === '/api/rooms') {
      const code        = roomCode();
      const roomHostKey = uid(18);
      const newRoom = {
        code, hostKey: roomHostKey, status: 'lobby',
        roundSeconds: 90, startedAt: null, finishedAt: null,
        createdAt: Date.now(), players: {},
      };
      await fbReq(`rooms/${code}`, { method: 'PUT', body: newRoom });
      const origin = `https://${host}`;
      return json(res, 200, {
        room: code, hostKey: roomHostKey,
        joinUrl: `${origin}/?room=${code}`,
        hostUrl: `${origin}/?host=${roomHostKey}&room=${code}`,
      });
    }

    // STAV MÍSTNOSTI
    if (req.method === 'GET' && url.pathname === '/api/room') {
      const code     = (url.searchParams.get('room') || '').toUpperCase();
      const roomData = await fbReq(`rooms/${code}`);
      if (!roomData) return json(res, 404, { error: 'Místnost neexistuje' });
      const isHost = url.searchParams.get('hostKey') === roomData.hostKey;
      return json(res, 200, formatSnapshot(roomData, isHost));
    }

    // PŘIPOJENÍ ŽÁKA
    if (req.method === 'POST' && url.pathname === '/api/join') {
      const body     = await readJson(req);
      const code     = String(body.room || '').toUpperCase();
      const roomData = await fbReq(`rooms/${code}`);
      if (!roomData)                   return json(res, 404, { error: 'Místnost neexistuje' });
      if (roomData.status !== 'lobby') return json(res, 409, { error: 'Hra již byla spuštěna' });

      const sessionId = uid();
      await fbReq(`rooms/${code}/players/${sessionId}`, {
        method: 'PUT',
        body: { sessionId, name: cleanName(body.name), score: 0, completed: 0, joinedAt: Date.now() },
      });
      const updated = await fbReq(`rooms/${code}`);
      return json(res, 200, { sessionId, snapshot: formatSnapshot(updated) });
    }

    // START HRY
    if (req.method === 'POST' && url.pathname === '/api/start') {
      const body     = await readJson(req);
      const code     = String(body.room || '').toUpperCase();
      const roomData = await fbReq(`rooms/${code}`);
      if (!roomData || body.hostKey !== roomData.hostKey)
        return json(res, 403, { error: 'Neoprávněný přístup' });

      await fbReq(`rooms/${code}`, { method: 'PATCH', body: { status: 'running', startedAt: Date.now(), finishedAt: null } });
      for (const pId of Object.keys(roomData.players || {})) {
        await fbReq(`rooms/${code}/players/${pId}`, { method: 'PATCH', body: { score: 0, completed: 0 } });
      }
      const updated = await fbReq(`rooms/${code}`);
      return json(res, 200, formatSnapshot(updated, true));
    }

    // PŘIČTENÍ SKÓRE
    if (req.method === 'POST' && url.pathname === '/api/score') {
      const body       = await readJson(req);
      const code       = String(body.room || '').toUpperCase();
      const roomData   = await fbReq(`rooms/${code}`);
      if (!roomData || roomData.status !== 'running')
        return json(res, 409, { error: 'Hra neběží' });

      const sessionId  = String(body.sessionId || '');
      const playerData = await fbReq(`rooms/${code}/players/${sessionId}`);
      if (!playerData) return json(res, 403, { error: 'Hráč neexistuje' });

      const delta = Math.max(0, Math.min(80, Number(body.delta || 0)));
      await fbReq(`rooms/${code}/players/${sessionId}`, {
        method: 'PATCH',
        body: { score: (playerData.score || 0) + delta, completed: (playerData.completed || 0) + 1 },
      });
      const updated = await fbReq(`rooms/${code}`);
      return json(res, 200, formatSnapshot(updated));
    }

    // KONEC HRY
    if (req.method === 'POST' && url.pathname === '/api/finish') {
      const body     = await readJson(req);
      const code     = String(body.room || '').toUpperCase();
      const roomData = await fbReq(`rooms/${code}`);
      if (!roomData || body.hostKey !== roomData.hostKey)
        return json(res, 403, { error: 'Neoprávněný přístup' });

      await fbReq(`rooms/${code}`, { method: 'PATCH', body: { status: 'finished', finishedAt: Date.now() } });
      const updated = await fbReq(`rooms/${code}`);
      return json(res, 200, formatSnapshot(updated, true));
    }

    res.writeHead(404);
    res.end('Nenalezeno');

  } catch (err) {
    console.error(err);
    json(res, 500, { error: 'Chyba na serveru', details: err.message });
  }
};

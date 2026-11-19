// api/server.js
const crypto = require('crypto');
const QRCode = require('qrcode');

const REQUIRED_ENV = [
  'FIREBASE_PROJECT_ID',
  'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_PRIVATE_KEY',
  'FIREBASE_DATABASE_URL',
];

// --- Limity proti zneužití ---
const POINTS_PER_MOLECULE = 20;     // body určuje server, ne klient
const MIN_SCORE_INTERVAL_MS = 3000; // nejméně 3 s mezi dvěma odeslanými molekulami
const MAX_PLAYERS_PER_ROOM = 60;
const MAX_BODY_BYTES = 10 * 1024;

// --- Úklid starých místností ---
const ROOM_MAX_AGE_MS   = 90 * 24 * 60 * 60 * 1000; // místnosti starší než ~3 měsíce se mažou
const CLEANUP_EVERY_MS  = 24 * 60 * 60 * 1000;      // úklid nejvýš jednou denně

const ROOM_RE    = /^[0-9A-F]{6}$/;
const SESSION_RE = /^[A-Za-z0-9_-]{16}$/;  // uid() = 12 bajtů -> 16 znaků base64url
const HOSTKEY_RE = /^[A-Za-z0-9_-]{24}$/;  // uid(18) -> 24 znaků

// Stejné molekuly jako v index.html – server je ověřuje sám
const MOLECULES = {
  H2O: { O: [['H', 1], ['H', 1]] },
  O2:  { O: [['O', 2]] },
  CO2: { C: [['O', 2], ['O', 2]] },
  CH4: { C: [['H', 1], ['H', 1], ['H', 1], ['H', 1]] },
  NH3: { N: [['H', 1], ['H', 1], ['H', 1]] },
  HCl: { H: [['Cl', 1]] },
  N2:  { N: [['N', 3]] },
};
const ALLOWED_ATOMS = new Set(['H', 'C', 'O', 'N', 'Cl', 'S', 'Na']);

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

async function fbReq(path, opts = {}) {
  const env   = getEnv();
  const token = await getAccessToken();
  const url   = new URL(`${env.databaseUrl}/${path}.json`);

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

// Pokud běžící hře vypršel čas, přepne ji na 'finished' (i v DB).
async function expireIfNeeded(code, roomData) {
  if (!roomData || roomData.status !== 'running' || !roomData.startedAt) return roomData;
  const round = roomData.roundSeconds || 90;
  if (Date.now() - roomData.startedAt < round * 1000) return roomData;
  const finishedAt = roomData.startedAt + round * 1000;
  await fbReq(`rooms/${code}`, { method: 'PATCH', body: { status: 'finished', finishedAt } });
  return { ...roomData, status: 'finished', finishedAt };
}

// Smaže místnosti starší než ROOM_MAX_AGE_MS. Spouští se při zakládání místnosti,
// nejvýš jednou za CLEANUP_EVERY_MS (čas posledního úklidu je v DB: meta/lastCleanupAt).
async function cleanupOldRooms(now = Date.now()) {
  const last = await fbReq('meta/lastCleanupAt');
  if (typeof last === 'number' && now - last < CLEANUP_EVERY_MS) return 0;
  await fbReq('meta', { method: 'PATCH', body: { lastCleanupAt: now } });

  const rooms = (await fbReq('rooms')) || {};
  const cutoff = now - ROOM_MAX_AGE_MS;
  const toDelete = {};
  for (const [code, r] of Object.entries(rooms)) {
    if (!r || typeof r.createdAt !== 'number' || r.createdAt < cutoff) toDelete[code] = null;
  }
  const count = Object.keys(toDelete).length;
  if (count) await fbReq('rooms', { method: 'PATCH', body: toDelete }); // jeden hromadný zápis
  console.log(`Úklid: smazáno ${count} starých místností`);
  return count;
}

function uid(bytes = 12) { return crypto.randomBytes(bytes).toString('base64url'); }
function roomCode()      { return crypto.randomBytes(3).toString('hex').toUpperCase(); }

// Porovnání tajného klíče v konstantním čase
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function isHost(roomData, hostKey) {
  return !!roomData && HOSTKEY_RE.test(String(hostKey || '')) && safeEqual(hostKey, roomData.hostKey);
}

function cleanName(name) {
  return String(name || '')
    .replace(/[^\p{L}\p{N} _.-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 18);
}

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (fwd || req.socket?.remoteAddress || '').slice(0, 64);
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size <= MAX_BODY_BYTES) body += c; // nadbytek dočteme, ale neukládáme
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) return reject(new HttpError(413, 'Požadavek je příliš velký'));
      try {
        const data = body ? JSON.parse(body) : {};
        resolve(data && typeof data === 'object' && !Array.isArray(data) ? data : {});
      } catch (e) { reject(new HttpError(400, 'Neplatný JSON')); }
    });
    req.on('error', reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

// Ověří, že poslaná struktura (atomy + vazby) odpovídá zadané molekule
function isValidMolecule(key, atoms, bonds) {
  const structure = Object.prototype.hasOwnProperty.call(MOLECULES, key) ? MOLECULES[key] : null;
  if (!structure || !Array.isArray(atoms) || !Array.isArray(bonds)) return false;
  if (atoms.length > 20 || bonds.length > 40) return false;
  if (!atoms.every(a => ALLOWED_ATOMS.has(a))) return false;

  const expectedAtoms = {};
  const expectedBonds = [];
  for (const [center, neighbours] of Object.entries(structure)) {
    expectedAtoms[center] = (expectedAtoms[center] || 0) + 1;
    for (const [sym, type] of neighbours) {
      expectedAtoms[sym] = (expectedAtoms[sym] || 0) + 1;
      expectedBonds.push([center, sym].sort().join('-') + ':' + type);
    }
  }
  const counts = {};
  atoms.forEach(a => { counts[a] = (counts[a] || 0) + 1; });
  const sameCounts = Object.keys({ ...counts, ...expectedAtoms }).every(s => counts[s] === expectedAtoms[s]);
  if (!sameCounts) return false;

  const seen = new Set();
  const actualBonds = [];
  for (const b of bonds) {
    if (!Array.isArray(b) || b.length !== 3) return false;
    const [i, j, type] = b;
    if (!Number.isInteger(i) || !Number.isInteger(j) || i === j) return false;
    if (i < 0 || j < 0 || i >= atoms.length || j >= atoms.length) return false;
    if (![1, 2, 3].includes(type)) return false;
    const pair = Math.min(i, j) + '-' + Math.max(i, j);
    if (seen.has(pair)) return false;
    seen.add(pair);
    actualBonds.push([atoms[i], atoms[j]].sort().join('-') + ':' + type);
  }
  return JSON.stringify(actualBonds.sort()) === JSON.stringify(expectedBonds.sort());
}

function formatSnapshot(roomData, mySessionId = '') {
  if (!roomData) return null;

  const players = [];
  for (const [sid, p] of Object.entries(roomData.players || {})) {
    players.push({
      name:      p.name,
      score:     p.score     || 0,
      completed: p.completed || 0,
      joinedAt:  p.joinedAt,
      me:        mySessionId && sid === mySessionId ? true : undefined,
    });
  }
  players.sort((a, b) => b.score - a.score || b.completed - a.completed || a.joinedAt - b.joinedAt);
  players.forEach(p => { delete p.joinedAt; });

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

function roomFrom(value) {
  const code = String(value || '').toUpperCase();
  if (!ROOM_RE.test(code)) throw new HttpError(404, 'Místnost neexistuje');
  return code;
}

module.exports = async (req, res) => {
  try {
    const url  = new URL(req.url, 'http://localhost');
    const host = String(req.headers.host || '').replace(/[^A-Za-z0-9.:-]/g, '') || 'localhost';
    const origin = `${host.startsWith('localhost') ? 'http' : 'https'}://${host}`;
    const path = url.pathname.replace(/^\/api\/server/, '/api');

    // HEALTH (bez detailů o konfiguraci)
    if (req.method === 'GET' && (path === '/api/health' || path === '/api')) {
      return json(res, 200, { ok: true });
    }

    // QR KÓD – vždy jen na odkaz do této aplikace (žádné cizí URL)
    if (req.method === 'GET' && path === '/api/qr') {
      const code = roomFrom(url.searchParams.get('room'));
      const roomData = await fbReq(`rooms/${code}`);
      if (!roomData) throw new HttpError(404, 'Místnost neexistuje');

      const svg = await QRCode.toString(`${origin}/?room=${code}`, {
        type: 'svg',
        margin: 1,
        width: 320,
        color: { dark: '#0f172a', light: '#ffffff' },
      });
      res.writeHead(200, {
        'content-type': 'image/svg+xml; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(svg);
      return;
    }

    // VYTVOŘENÍ MÍSTNOSTI
    if (req.method === 'POST' && path === '/api/rooms') {
      // Úklid nesmí zablokovat založení místnosti
      try { await cleanupOldRooms(); } catch (e) { console.error('Úklid selhal:', e); }

      let code = roomCode();
      for (let i = 0; i < 5 && await fbReq(`rooms/${code}/code`); i++) code = roomCode();

      const roomHostKey = uid(18);
      const newRoom = {
        code, hostKey: roomHostKey, status: 'lobby',
        roundSeconds: 90, startedAt: null, finishedAt: null,
        createdAt: Date.now(), players: {},
      };
      await fbReq(`rooms/${code}`, { method: 'PUT', body: newRoom });
      return json(res, 200, {
        room: code, hostKey: roomHostKey,
        joinUrl: `${origin}/?room=${code}`,
        qrUrl: `/api/qr?room=${code}`,
      });
    }

    // STAV MÍSTNOSTI
    if (req.method === 'GET' && path === '/api/room') {
      const code     = roomFrom(url.searchParams.get('room'));
      const roomData = await expireIfNeeded(code, await fbReq(`rooms/${code}`));
      if (!roomData) throw new HttpError(404, 'Místnost neexistuje');
      const sid = String(url.searchParams.get('sessionId') || '');
      return json(res, 200, formatSnapshot(roomData, SESSION_RE.test(sid) ? sid : ''));
    }

    // PŘIPOJENÍ ŽÁKA
    if (req.method === 'POST' && path === '/api/join') {
      const body     = await readJson(req);
      const code     = roomFrom(body.room);
      const roomData = await fbReq(`rooms/${code}`);
      if (!roomData)                   throw new HttpError(404, 'Místnost neexistuje');
      if (roomData.status !== 'lobby') throw new HttpError(409, 'Hra již byla spuštěna');

      const name = cleanName(body.name);
      if (!name) throw new HttpError(400, 'Zadej platné jméno');

      const players = Object.values(roomData.players || {});
      if (players.length >= MAX_PLAYERS_PER_ROOM) throw new HttpError(409, 'Místnost je plná');
      if (players.some(p => String(p.name).toLowerCase() === name.toLowerCase()))
        throw new HttpError(409, 'Toto jméno už v místnosti někdo má');

      const sessionId = uid();
      await fbReq(`rooms/${code}/players/${sessionId}`, {
        method: 'PUT',
        body: { sessionId, name, score: 0, completed: 0, joinedAt: Date.now(), ip: clientIp(req) },
      });
      const updated = await fbReq(`rooms/${code}`);
      return json(res, 200, { sessionId, snapshot: formatSnapshot(updated, sessionId) });
    }

    // START HRY
    if (req.method === 'POST' && path === '/api/start') {
      const body     = await readJson(req);
      const code     = roomFrom(body.room);
      const roomData = await fbReq(`rooms/${code}`);
      if (!isHost(roomData, body.hostKey)) throw new HttpError(403, 'Neoprávněný přístup');
      if (roomData.status !== 'lobby')     throw new HttpError(409, 'Hra už běží nebo skončila');

      await fbReq(`rooms/${code}`, { method: 'PATCH', body: { status: 'running', startedAt: Date.now(), finishedAt: null } });
      const updated = await fbReq(`rooms/${code}`);
      return json(res, 200, formatSnapshot(updated));
    }

    // PŘIČTENÍ SKÓRE – server ověří molekulu i rychlost odesílání
    if (req.method === 'POST' && path === '/api/score') {
      const body      = await readJson(req);
      const code      = roomFrom(body.room);
      const sessionId = String(body.sessionId || '');
      if (!SESSION_RE.test(sessionId)) throw new HttpError(403, 'Hráč neexistuje');

      const roomData = await expireIfNeeded(code, await fbReq(`rooms/${code}`));
      if (!roomData || roomData.status !== 'running') throw new HttpError(409, 'Hra neběží');

      const playerData = roomData.players?.[sessionId];
      if (!playerData) throw new HttpError(403, 'Hráč neexistuje');

      const now = Date.now();
      if (playerData.lastScoreAt && now - playerData.lastScoreAt < MIN_SCORE_INTERVAL_MS)
        throw new HttpError(429, 'Moc rychle – zkus to za chvilku');

      if (!isValidMolecule(String(body.molecule || ''), body.atoms, body.bonds))
        throw new HttpError(422, 'Molekula není správně');

      await fbReq(`rooms/${code}/players/${sessionId}`, {
        method: 'PATCH',
        body: {
          score: (playerData.score || 0) + POINTS_PER_MOLECULE,
          completed: (playerData.completed || 0) + 1,
          lastScoreAt: now,
        },
      });
      const updated = await fbReq(`rooms/${code}`);
      return json(res, 200, formatSnapshot(updated, sessionId));
    }

    // KONEC HRY
    if (req.method === 'POST' && (path === '/api/finish' || path === '/api/end')) {
      const body     = await readJson(req);
      const code     = roomFrom(body.room);
      const roomData = await fbReq(`rooms/${code}`);
      if (!isHost(roomData, body.hostKey)) throw new HttpError(403, 'Neoprávněný přístup');

      if (roomData.status !== 'finished') {
        await fbReq(`rooms/${code}`, { method: 'PATCH', body: { status: 'finished', finishedAt: Date.now() } });
      }
      const updated = await fbReq(`rooms/${code}`);
      return json(res, 200, formatSnapshot(updated));
    }

    json(res, 404, { error: 'Nenalezeno' });

  } catch (err) {
    if (err instanceof HttpError) return json(res, err.status, { error: err.message });
    console.error(err);
    // Detaily chyby jen do logu, ne klientovi
    json(res, 500, { error: 'Chyba na serveru' });
  }
};

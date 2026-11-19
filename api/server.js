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

// --- Rate limit (sdílený přes Firebase, platí napříč instancemi serverless funkce) ---
const MISS_WINDOW_MS   = 10 * 60 * 1000; // okno pro neplatné kódy místností
const MAX_ROOM_MISSES  = 40;             // max. neplatných kódů z jedné IP za okno
const CREATE_WINDOW_MS = 60 * 60 * 1000; // okno pro zakládání místností
const MAX_ROOM_CREATES = 20;             // max. nových místností z jedné IP za hodinu

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
  for (const [k, v] of Object.entries(opts.query || {})) url.searchParams.set(k, v);

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (opts.withEtag) headers['X-Firebase-ETag'] = 'true';
  if (opts.ifMatch)  headers['if-match'] = opts.ifMatch;

  const r = await fetch(url, {
    method:  opts.method || 'GET',
    headers,
    body:    opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (r.status === 412) throw new ConflictError();
  if (!r.ok) throw new Error(data?.error || `Firebase ${r.status}`);
  return opts.withEtag ? { data, etag: r.headers.get('etag') } : data;
}

// Data se mezi čtením a zápisem změnila (jiný souběžný požadavek)
class ConflictError extends Error {}

// Atomická úprava uzlu: přečte s ETagem, zavolá update(data) a zapíše jen pokud se mezitím nic nezměnilo.
// update vrací novou hodnotu uzlu, nebo vyhodí HttpError.
async function fbTransaction(path, update, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    const { data, etag } = await fbReq(path, { withEtag: true });
    const next = update(data);
    try {
      await fbReq(path, { method: 'PUT', body: next, ifMatch: etag });
      return next;
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
    }
  }
  throw new HttpError(429, 'Server je vytížený – zkus to znovu');
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
  await cleanupRateLimits(now);
  return count;
}

function uid(bytes = 12) { return crypto.randomBytes(bytes).toString('base64url'); }
function roomCode()      { return crypto.randomBytes(3).toString('hex').toUpperCase(); }

// Porovnání tajného klíče v konstantním čase
// Vstup z požadavku: jen skutečný řetězec, jinak '' (pole/objekt by String() převedl na text)
function str(v) { return typeof v === 'string' ? v : ''; }

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function isHost(roomData, hostKey) {
  return !!roomData && HOSTKEY_RE.test(str(hostKey)) && safeEqual(hostKey, roomData.hostKey);
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
  constructor(status, message, headers = {}) { super(message); this.status = status; this.headers = headers; }
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

function json(res, status, data, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
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

// IP se do DB neukládá v čitelné podobě, jen jako hash (klíč čítače)
function ipKey(req) {
  return crypto.createHash('sha256').update('chemlab-rl:' + clientIp(req)).digest('base64url').slice(0, 22);
}

// Zablokované IP v paměti instance – opakované pokusy pak nezatěžují databázi
const blockedUntil = new Map();

function tooMany(message, untilMs) {
  const retry = Math.max(1, Math.ceil((untilMs - Date.now()) / 1000));
  return new HttpError(429, message, { 'retry-after': String(retry) });
}

// Načte místnost podle kódu s ochranou proti hádání kódů:
// každý neexistující kód se počítá; po MAX_ROOM_MISSES za okno dostává IP jen 429
// (i pro existující místnosti, aby se útočník nedozvěděl, že se trefil).
async function loadRoom(req, value) {
  const now = Date.now();
  const ip = ipKey(req);
  const mem = blockedUntil.get(ip);
  if (mem && mem > now) throw tooMany('Příliš mnoho neplatných kódů místnosti. Zkus to za pár minut.', mem);

  const win = Math.floor(now / MISS_WINDOW_MS);
  const windowEnd = (win + 1) * MISS_WINDOW_MS;
  const counterPath = `rateLimits/miss/${win}/${ip}`;
  const code = str(value).toUpperCase();
  const valid = ROOM_RE.test(code);

  const [misses, roomData] = await Promise.all([
    fbReq(counterPath),
    valid ? fbReq(`rooms/${code}`) : Promise.resolve(null),
  ]);

  if ((misses || 0) >= MAX_ROOM_MISSES) {
    blockedUntil.set(ip, windowEnd);
    throw tooMany('Příliš mnoho neplatných kódů místnosti. Zkus to za pár minut.', windowEnd);
  }
  if (!roomData) {
    await fbReq(counterPath, { method: 'PUT', body: { '.sv': { increment: 1 } } }); // atomické +1
    throw new HttpError(404, 'Místnost neexistuje');
  }
  return { code, roomData };
}

// Limit zakládání místností z jedné IP
async function checkCreateLimit(req) {
  const now = Date.now();
  const win = Math.floor(now / CREATE_WINDOW_MS);
  const path = `rateLimits/create/${win}/${ipKey(req)}`;
  const count = await fbReq(path);
  if ((count || 0) >= MAX_ROOM_CREATES)
    throw tooMany('Příliš mnoho nových místností. Zkus to později.', (win + 1) * CREATE_WINDOW_MS);
  await fbReq(path, { method: 'PUT', body: { '.sv': { increment: 1 } } });
}

// Smaže staré čítače rate limitu (volá se z denního úklidu)
async function cleanupRateLimits(now = Date.now()) {
  for (const [kind, size] of [['miss', MISS_WINDOW_MS], ['create', CREATE_WINDOW_MS]]) {
    const windows = (await fbReq(`rateLimits/${kind}`, { query: { shallow: 'true' } })) || {};
    const current = Math.floor(now / size);
    const old = Object.keys(windows).filter(w => Number(w) < current);
    if (old.length) await fbReq(`rateLimits/${kind}`, { method: 'PATCH', body: Object.fromEntries(old.map(w => [w, null])) });
  }
  for (const [ip, until] of blockedUntil) if (until <= now) blockedUntil.delete(ip);
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
      const { code } = await loadRoom(req, url.searchParams.get('room'));

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
      await checkCreateLimit(req);

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
      const loaded   = await loadRoom(req, url.searchParams.get('room'));
      const roomData = await expireIfNeeded(loaded.code, loaded.roomData);
      const sid = String(url.searchParams.get('sessionId') || '');
      return json(res, 200, formatSnapshot(roomData, SESSION_RE.test(sid) ? sid : ''));
    }

    // PŘIPOJENÍ ŽÁKA
    if (req.method === 'POST' && path === '/api/join') {
      const body     = await readJson(req);
      const { code, roomData } = await loadRoom(req, body.room);
      if (roomData.status !== 'lobby') throw new HttpError(409, 'Hra již byla spuštěna');

      const name = cleanName(str(body.name));
      if (!name) throw new HttpError(400, 'Zadej platné jméno');

      // Atomicky: souběžná připojení nesmí obejít limit hráčů ani unikátnost jména
      const sessionId = uid();
      await fbTransaction(`rooms/${code}/players`, (current) => {
        const players = current || {};
        const list = Object.values(players);
        if (list.length >= MAX_PLAYERS_PER_ROOM) throw new HttpError(409, 'Místnost je plná');
        if (list.some(p => String(p.name).toLowerCase() === name.toLowerCase()))
          throw new HttpError(409, 'Toto jméno už v místnosti někdo má');
        return { ...players, [sessionId]: { sessionId, name, score: 0, completed: 0, joinedAt: Date.now(), ip: clientIp(req) } };
      });
      const updated = await fbReq(`rooms/${code}`);
      return json(res, 200, { sessionId, snapshot: formatSnapshot(updated, sessionId) });
    }

    // START HRY
    if (req.method === 'POST' && path === '/api/start') {
      const body     = await readJson(req);
      const { code, roomData } = await loadRoom(req, body.room);
      if (!isHost(roomData, body.hostKey)) throw new HttpError(403, 'Neoprávněný přístup');
      if (roomData.status !== 'lobby')     throw new HttpError(409, 'Hra už běží nebo skončila');

      await fbReq(`rooms/${code}`, { method: 'PATCH', body: { status: 'running', startedAt: Date.now(), finishedAt: null } });
      const updated = await fbReq(`rooms/${code}`);
      return json(res, 200, formatSnapshot(updated));
    }

    // PŘIČTENÍ SKÓRE – server ověří molekulu i rychlost odesílání
    if (req.method === 'POST' && path === '/api/score') {
      const body      = await readJson(req);
      const sessionId = str(body.sessionId);
      if (!SESSION_RE.test(sessionId)) throw new HttpError(403, 'Hráč neexistuje');

      const loaded   = await loadRoom(req, body.room);
      const code     = loaded.code;
      const roomData = await expireIfNeeded(code, loaded.roomData);
      if (roomData.status !== 'running') throw new HttpError(409, 'Hra neběží');

      if (!roomData.players?.[sessionId]) throw new HttpError(403, 'Hráč neexistuje');

      if (!isValidMolecule(str(body.molecule), body.atoms, body.bonds))
        throw new HttpError(422, 'Molekula není správně');

      // Atomicky: souběžné požadavky nesmí obejít limit rychlosti a přičíst body víckrát
      await fbTransaction(`rooms/${code}/players/${sessionId}`, (playerData) => {
        if (!playerData) throw new HttpError(403, 'Hráč neexistuje');
        const now = Date.now();
        if (playerData.lastScoreAt && now - playerData.lastScoreAt < MIN_SCORE_INTERVAL_MS)
          throw new HttpError(429, 'Moc rychle – zkus to za chvilku');
        return {
          ...playerData,
          score: (playerData.score || 0) + POINTS_PER_MOLECULE,
          completed: (playerData.completed || 0) + 1,
          lastScoreAt: now,
        };
      });
      const updated = await fbReq(`rooms/${code}`);
      return json(res, 200, formatSnapshot(updated, sessionId));
    }

    // KONEC HRY
    if (req.method === 'POST' && (path === '/api/finish' || path === '/api/end')) {
      const body     = await readJson(req);
      const { code, roomData } = await loadRoom(req, body.room);
      if (!isHost(roomData, body.hostKey)) throw new HttpError(403, 'Neoprávněný přístup');

      if (roomData.status !== 'finished') {
        await fbReq(`rooms/${code}`, { method: 'PATCH', body: { status: 'finished', finishedAt: Date.now() } });
      }
      const updated = await fbReq(`rooms/${code}`);
      return json(res, 200, formatSnapshot(updated));
    }

    json(res, 404, { error: 'Nenalezeno' });

  } catch (err) {
    if (err instanceof HttpError) return json(res, err.status, { error: err.message }, err.headers);
    console.error(err);
    // Detaily chyby jen do logu, ne klientovi
    json(res, 500, { error: 'Chyba na serveru' });
  }
};

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT || 4174);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_HOST = process.env.PUBLIC_HOST || getLanAddress() || '127.0.0.1';
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'rooms-store.json');
const rooms = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function getLanAddress() {
  const candidates = [];
  try {
    for (const [name, group] of Object.entries(os.networkInterfaces())) {
      for (const iface of group || []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          candidates.push({ name, address: iface.address });
        }
      }
    }
  } catch (e) {
    return '127.0.0.1';
  }

  const preferred = candidates.find(({ name, address }) =>
    !/virtual|vmware|vbox|vethernet|hyper-v|loopback/i.test(name) &&
    !/^169\.254\./.test(address) &&
    !/^192\.168\.56\./.test(address)
  );

  return (preferred || candidates[0] || {}).address || '127.0.0.1';
}

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

function createRoom() {
  let code = roomCode();
  while (rooms.has(code)) code = roomCode();

  const room = {
    code,
    hostKey: id(18),
    status: 'lobby',
    roundSeconds: 90,
    startedAt: null,
    finishedAt: null,
    createdAt: Date.now(),
    players: new Map(),
    clients: new Set()
  };
  rooms.set(code, room);
  saveRooms();
  return room;
}

function serializeRoom(room) {
  return {
    code: room.code,
    hostKey: room.hostKey,
    status: room.status,
    roundSeconds: room.roundSeconds,
    startedAt: room.startedAt,
    finishedAt: room.finishedAt,
    createdAt: room.createdAt,
    players: [...room.players.entries()]
  };
}

function hydrateRoom(raw) {
  return {
    code: raw.code,
    hostKey: raw.hostKey,
    status: raw.status,
    roundSeconds: raw.roundSeconds || 90,
    startedAt: raw.startedAt || null,
    finishedAt: raw.finishedAt || null,
    createdAt: raw.createdAt || Date.now(),
    players: new Map(raw.players || []),
    clients: new Set()
  };
}

let saveTimeout = null;
function saveRooms() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    const data = [...rooms.values()].map(serializeRoom);
    fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), (err) => {
      if (err) console.error('Chyba zapisu souboru:', err);
    });
  }, 500); 
}

function loadRooms() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      raw.forEach(room => rooms.set(room.code.toUpperCase(), hydrateRoom(room)));
    }
  } catch (e) {
    console.error('Nepodarilo se nacist rooms-store.json:', e);
  }
}

function snapshot(room, host = false) {
  const players = [...room.players.values()]
    .map(({ sessionId, name, score, completed, joinedAt }) => ({
      id: host ? sessionId : undefined,
      name,
      score,
      completed,
      joinedAt
    }))
    .sort((a, b) => b.score - a.score || b.completed - a.completed || a.joinedAt - b.joinedAt);

  const now = Date.now();
  const elapsed = room.startedAt ? Math.floor((now - room.startedAt) / 1000) : 0;
  let timeLeft = room.status === 'running' ? Math.max(0, room.roundSeconds - elapsed) : room.roundSeconds;

  if (room.status === 'running' && timeLeft <= 0) {
    room.status = 'finished';
    room.finishedAt = room.finishedAt || Date.now();
    timeLeft = 0;
    saveRooms();
  }

  return {
    room: room.code,
    status: room.status,
    roundSeconds: room.roundSeconds,
    timeLeft: room.status === 'running' ? timeLeft : room.status === 'finished' ? 0 : room.roundSeconds,
    players
  };
}

function broadcast(room) {
  const dataStr = JSON.stringify(snapshot(room));
  const hostDataStr = JSON.stringify(snapshot(room, true));
  
  for (const client of room.clients) {
    try {
      client.res.write(`data: ${client.host ? hostDataStr : dataStr}\n\n`);
    } catch (e) {
      room.clients.delete(client);
    }
  }
}

function json(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 10000) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

function serveFile(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let filePath = decodeURIComponent(url.pathname);
  if (filePath === '/') filePath = '/index.html';
  const resolved = path.resolve(ROOT, `.${filePath}`);

  if (!resolved.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(resolved, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    res.writeHead(200, {
      'content-type': MIME[path.extname(resolved)] || 'application/octet-stream',
      'cache-control': 'no-store'
    });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/api/health') {
      json(res, 200, { ok: true, publicHost: PUBLIC_HOST, port: PORT });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/rooms') {
      const room = createRoom();
      const origin = `http://${PUBLIC_HOST}:${PORT}`;
      json(res, 200, {
        room: room.code,
        hostKey: room.hostKey,
        joinUrl: `${origin}/?room=${room.code}`,
        hostUrl: `${origin}/?host=${room.hostKey}&room=${room.code}`
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/qr') {
      const roomParam = (url.searchParams.get('room') || '').toUpperCase();
      const room = rooms.get(roomParam);
      if (!room) {
        res.writeHead(404);
        res.end('Room not found');
        return;
      }

      const target = url.searchParams.get('url') || `http://${PUBLIC_HOST}:${PORT}/?room=${room.code}`;
      const svg = await QRCode.toString(target, {
        type: 'svg',
        margin: 1,
        width: 320,
        color: { dark: '#0a0e1a', light: '#ffffff' }
      });

      res.writeHead(200, {
        'content-type': 'image/svg+xml; charset=utf-8',
        'cache-control': 'no-store'
      });
      res.end(svg);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/room') {
      const roomParam = (url.searchParams.get('room') || '').toUpperCase();
      const room = rooms.get(roomParam);
      if (!room) return json(res, 404, { error: 'Room not found' });
      json(res, 200, snapshot(room, url.searchParams.get('hostKey') === room.hostKey));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      const roomParam = (url.searchParams.get('room') || '').toUpperCase();
      const room = rooms.get(roomParam);
      if (!room) {
        res.writeHead(404);
        res.end('Room not found');
        return;
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'connection': 'keep-alive'
      });
      const client = { res, host: url.searchParams.get('hostKey') === room.hostKey };
      room.clients.add(client);
      
      res.write(`data: ${JSON.stringify(snapshot(room, client.host))}\n\n`);
      req.on('close', () => room.clients.delete(client));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/join') {
      const body = await readJson(req);
      const roomParam = String(body.room || '').toUpperCase();
      const room = rooms.get(roomParam);
      if (!room) return json(res, 404, { error: 'Room not found' });
      if (room.status !== 'lobby') return json(res, 409, { error: 'Game already started' });

      const sessionId = id();
      room.players.set(sessionId, {
        sessionId,
        name: cleanName(body.name),
        score: 0,
        completed: 0,
        joinedAt: Date.now()
      });
      saveRooms();
      broadcast(room);
      json(res, 200, { sessionId, snapshot: snapshot(room) });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/resume') {
      const body = await readJson(req);
      const roomParam = String(body.room || '').toUpperCase();
      const room = rooms.get(roomParam);
      if (!room) return json(res, 404, { error: 'Room not found' });
      const player = room.players.get(String(body.sessionId || ''));
      if (!player) return json(res, 404, { error: 'Session not found' });
      json(res, 200, {
        sessionId: player.sessionId,
        name: player.name,
        snapshot: snapshot(room)
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/start') {
      const body = await readJson(req);
      const roomParam = String(body.room || '').toUpperCase();
      const room = rooms.get(roomParam);
      if (!room || body.hostKey !== room.hostKey) return json(res, 403, { error: 'Host key required' });
      room.status = 'running';
      room.startedAt = Date.now();
      room.finishedAt = null;
      for (const player of room.players.values()) {
        player.score = 0;
        player.completed = 0;
      }
      saveRooms();
      broadcast(room);
      json(res, 200, snapshot(room, true));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/score') {
      const body = await readJson(req);
      const roomParam = String(body.room || '').toUpperCase();
      const room = rooms.get(roomParam);
      if (!room || room.status !== 'running') return json(res, 409, { error: 'Game is not running' });
      const player = room.players.get(String(body.sessionId || ''));
      if (!player) return json(res, 403, { error: 'Player session required' });

      const delta = Math.max(0, Math.min(80, Number(body.delta || 0)));
      player.score += delta;
      player.completed += 1;
      saveRooms();
      broadcast(room);
      json(res, 200, snapshot(room));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/finish') {
      const body = await readJson(req);
      const roomParam = String(body.room || '').toUpperCase();
      const room = rooms.get(roomParam);
      if (!room || body.hostKey !== room.hostKey) return json(res, 403, { error: 'Host key required' });
      room.status = 'finished';
      room.finishedAt = Date.now();
      saveRooms();
      broadcast(room);
      json(res, 200, snapshot(room, true));
      return;
    }

    serveFile(req, res);
  } catch (err) {
    json(res, 500, { error: 'Server error' });
  }
});

// Efektivní a bezpečný cron interval
setInterval(() => {
  const now = Date.now();
  let changed = false;

  for (const room of rooms.values()) {
    if (room.status === 'running') {
      const elapsed = Math.floor((now - room.startedAt) / 1000);
      if (elapsed >= room.roundSeconds) {
        room.status = 'finished';
        room.finishedAt = now;
        changed = true;
        broadcast(room);
      }
    }

    const finishedTooOld = room.status === 'finished' && room.finishedAt && now - room.finishedAt > 2 * 60 * 60 * 1000;
    const lobbyTooOld = room.status === 'lobby' && now - room.createdAt > 6 * 60 * 60 * 1000;
    
    if (finishedTooOld || lobbyTooOld) {
      rooms.delete(room.code.toUpperCase());
      changed = true;
    }
  }

  if (changed) {
    saveRooms();
  }
}, 1000);

loadRooms();
server.listen(PORT, HOST, () => {
  console.log(`ChemLab server plně funkční na: http://${PUBLIC_HOST}:${PORT}/`);
});

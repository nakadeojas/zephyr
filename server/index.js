require('dotenv').config();
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const cookie = require('cookie');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const db = require('./db');

/* ------------------------------------------------------------------ config */
const PORT = process.env.PORT || 3000;
let SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET === 'change-me') {
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[zephyr] JWT_SECRET not set - using a random one (sessions reset on restart).');
}
const MSG_KEY = crypto.createHash('sha256').update(process.env.MESSAGE_KEY || SECRET).digest();
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const COLORS = ['#2f6fb3', '#c8452f', '#3f8a5a', '#d49a1c', '#7a4fa3', '#1f8a8a', '#b5527a'];
const EMOJI = ['👍', '❤️', '😂', '🔥', '🙏', '🎉'];

/* -------------------------------------------------- encryption at rest (AES) */
function enc(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', MSG_KEY, iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return 'enc:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function dec(s) {
  if (!s || !s.startsWith('enc:')) return s || '';
  try {
    const b = Buffer.from(s.slice(4), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', MSG_KEY, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { return '[unreadable]'; }
}

/* ----------------------------------------------------------------- helpers */
const publicUser = (u) => ({ id: u.id, username: u.username, displayName: u.display_name, branch: u.branch, color: u.avatar_color, bio: u.bio || '', createdAt: u.created_at });
const userById = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);
const isMember = (cid, uid) => !!db.prepare('SELECT 1 FROM members WHERE conversation_id=? AND user_id=?').get(cid, uid);

function userFromToken(t) {
  try { return userById(jwt.verify(t, SECRET).id); } catch { return null; }
}
function setSession(res, user) {
  const token = jwt.sign({ id: user.id }, SECRET, { expiresIn: '7d' });
  res.cookie('token', token, {
    httpOnly: true, sameSite: 'lax', maxAge: 7 * 864e5,
    secure: process.env.COOKIE_SECURE === 'true',
  });
}

const MSG_SQL = `SELECT m.*, u.display_name AS sender_name, u.avatar_color AS sender_color
                 FROM messages m LEFT JOIN users u ON u.id = m.sender_id`;
const qReact = db.prepare('SELECT user_id, emoji FROM reactions WHERE message_id=?');
function ser(r) {
  const reactions = {};
  for (const x of qReact.all(r.id)) (reactions[x.emoji] ||= []).push(x.user_id);
  return {
    id: r.id, conversationId: r.conversation_id, senderId: r.sender_id,
    senderName: r.kind === 'ai' ? 'Sumit' : r.sender_name,
    senderColor: r.kind === 'ai' ? '#12241d' : r.sender_color,
    kind: r.kind, body: r.deleted ? '' : dec(r.body),
    meta: r.deleted ? null : (r.meta ? JSON.parse(r.meta) : null),
    deleted: !!r.deleted, createdAt: r.created_at, reactions,
  };
}
const getMsg = (id) => { const r = db.prepare(MSG_SQL + ' WHERE m.id=?').get(id); return r && ser(r); };

function createMessage({ conversationId, senderId = null, kind = 'text', body = '', meta = null }) {
  const info = db.prepare('INSERT INTO messages (conversation_id,sender_id,kind,body,meta,created_at) VALUES (?,?,?,?,?,?)')
    .run(conversationId, senderId, kind, enc(body), meta ? JSON.stringify(meta) : null, Date.now());
  const m = getMsg(info.lastInsertRowid);
  io.to('c:' + conversationId).emit('message:new', m);
  return m;
}

function conversationView(c, uid) {
  const me = db.prepare('SELECT last_read_id FROM members WHERE conversation_id=? AND user_id=?').get(c.id, uid);
  const out = { id: c.id, type: c.type, name: c.name, description: c.description };
  if (c.type !== 'room') {
    out.members = db.prepare(`SELECT u.*, m.last_read_id FROM members m JOIN users u ON u.id=m.user_id WHERE m.conversation_id=?`)
      .all(c.id).map((u) => ({ ...publicUser(u), lastReadId: u.last_read_id }));
  } else {
    out.memberCount = db.prepare('SELECT COUNT(*) n FROM members WHERE conversation_id=?').get(c.id).n;
  }
  out.unread = db.prepare('SELECT COUNT(*) n FROM messages WHERE conversation_id=? AND id>? AND COALESCE(sender_id,0)!=? AND deleted=0')
    .get(c.id, me.last_read_id, uid).n;
  const last = db.prepare(MSG_SQL + ' WHERE m.conversation_id=? ORDER BY m.id DESC LIMIT 1').get(c.id);
  out.lastMessage = last ? ser(last) : null;
  out.sortKey = last ? last.created_at : c.created_at;
  return out;
}
const conversationsFor = (uid) =>
  db.prepare('SELECT c.* FROM conversations c JOIN members m ON m.conversation_id=c.id WHERE m.user_id=?').all(uid)
    .map((c) => conversationView(c, uid)).sort((a, b) => b.sortKey - a.sortKey);

function markRead(cid, uid) {
  const max = db.prepare('SELECT COALESCE(MAX(id),0) n FROM messages WHERE conversation_id=?').get(cid).n;
  db.prepare('UPDATE members SET last_read_id=MAX(last_read_id,?) WHERE conversation_id=? AND user_id=?').run(max, cid, uid);
  io.to('c:' + cid).emit('read', { conversationId: cid, userId: uid, lastReadId: max });
}

/* --------------------------------------------------------------- web server */
const app = express();
app.set('trust proxy', 1); // hosts such as Render sit behind a proxy
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public')));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false });
const requireAuth = (req, res, next) => {
  const u = userFromToken(req.cookies.token);
  if (!u) return res.status(401).json({ error: 'Please sign in.' });
  req.user = u; next();
};

/* ---- auth */
app.post('/api/register', authLimiter, (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const displayName = String(req.body.displayName || '').trim().slice(0, 40);
  const branch = String(req.body.branch || '').trim().slice(0, 30);
  if (!/^[a-z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'Username: 3-20 letters, numbers or underscores.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (!displayName) return res.status(400).json({ error: 'Add a display name.' });
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) return res.status(409).json({ error: 'That username is taken.' });

  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  const info = db.prepare('INSERT INTO users (username,display_name,password_hash,branch,avatar_color,created_at) VALUES (?,?,?,?,?,?)')
    .run(username, displayName, bcrypt.hashSync(password, 10), branch, color, Date.now());
  const uid = info.lastInsertRowid;
  for (const r of db.prepare("SELECT id FROM conversations WHERE type='room'").all()) {
    db.prepare('INSERT OR IGNORE INTO members (conversation_id,user_id,last_read_id) VALUES (?,?,?)')
      .run(r.id, uid, db.prepare('SELECT COALESCE(MAX(id),0) n FROM messages WHERE conversation_id=?').get(r.id).n);
  }
  const user = userById(uid);
  setSession(res, user);
  res.json({ user: publicUser(user) });
});

app.post('/api/login', authLimiter, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(String(req.body.username || '').trim().toLowerCase());
  if (!user || !bcrypt.compareSync(String(req.body.password || ''), user.password_hash))
    return res.status(401).json({ error: 'Wrong username or password.' });
  setSession(res, user);
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', (req, res) => { res.clearCookie('token'); res.json({ ok: true }); });
app.get('/api/me', (req, res) => {
  const u = userFromToken(req.cookies.token);
  if (!u) return res.status(401).json({ error: 'Not signed in.' });
  res.json({ user: publicUser(u) });
});

/* ---- profile */
app.get('/api/profile', requireAuth, (req, res) => {
  const id = req.user.id;
  const n = (sql) => db.prepare(sql).get(id).n;
  const byType = (t) => n(`SELECT COUNT(*) n FROM members m JOIN conversations c ON c.id=m.conversation_id WHERE m.user_id=? AND c.type='${t}'`);
  res.json({
    user: publicUser(userById(id)),
    stats: {
      messages: n("SELECT COUNT(*) n FROM messages WHERE sender_id=? AND deleted=0 AND kind IN ('text','file')"),
      files: n("SELECT COUNT(*) n FROM messages WHERE sender_id=? AND deleted=0 AND kind='file'"),
      focus: n("SELECT COUNT(*) n FROM messages WHERE sender_id=? AND deleted=0 AND kind='focus'"),
      reactions: n('SELECT COUNT(*) n FROM reactions WHERE user_id=?'),
      rooms: byType('room'), groups: byType('group'), dms: byType('dm'),
    },
  });
});

app.patch('/api/profile', requireAuth, (req, res) => {
  const displayName = String(req.body.displayName || '').trim().slice(0, 40);
  const branch = String(req.body.branch || '').trim().slice(0, 30);
  const bio = String(req.body.bio || '').trim().slice(0, 160);
  const color = COLORS.includes(req.body.color) ? req.body.color : req.user.avatar_color;
  if (!displayName) return res.status(400).json({ error: 'Display name cannot be empty.' });
  db.prepare('UPDATE users SET display_name=?, branch=?, bio=?, avatar_color=? WHERE id=?').run(displayName, branch, bio, color, req.user.id);
  res.json({ user: publicUser(userById(req.user.id)) });
});

/* ---- users & conversations */
app.get('/api/users', requireAuth, (req, res) => {
  const q = '%' + String(req.query.q || '').trim().toLowerCase() + '%';
  const rows = db.prepare('SELECT * FROM users WHERE id!=? AND (lower(username) LIKE ? OR lower(display_name) LIKE ?) ORDER BY display_name LIMIT 30')
    .all(req.user.id, q, q);
  res.json({ users: rows.map(publicUser) });
});

app.get('/api/conversations', requireAuth, (req, res) => res.json({ conversations: conversationsFor(req.user.id) }));

function joinSockets(cid, uids) {
  for (const uid of uids) io.in('u:' + uid).socketsJoin('c:' + cid);
  for (const uid of uids) io.to('u:' + uid).emit('conversation:new', { id: cid });
}

app.post('/api/conversations/dm', requireAuth, (req, res) => {
  const other = userById(+req.body.userId);
  if (!other || other.id === req.user.id) return res.status(400).json({ error: 'Pick another person.' });
  const key = [req.user.id, other.id].sort((a, b) => a - b).join('-');
  let c = db.prepare('SELECT * FROM conversations WHERE dm_key=?').get(key);
  if (!c) {
    const id = db.prepare("INSERT INTO conversations (type,dm_key,created_by,created_at) VALUES ('dm',?,?,?)").run(key, req.user.id, Date.now()).lastInsertRowid;
    for (const uid of [req.user.id, other.id]) db.prepare('INSERT INTO members (conversation_id,user_id) VALUES (?,?)').run(id, uid);
    c = db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
    joinSockets(id, [req.user.id, other.id]);
  }
  res.json({ conversation: conversationView(c, req.user.id) });
});

app.post('/api/conversations/group', requireAuth, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 50);
  const ids = [...new Set((req.body.memberIds || []).map(Number))].filter((id) => id !== req.user.id && userById(id));
  if (!name) return res.status(400).json({ error: 'Name the group.' });
  if (!ids.length) return res.status(400).json({ error: 'Add at least one member.' });
  const id = db.prepare("INSERT INTO conversations (type,name,created_by,created_at) VALUES ('group',?,?,?)").run(name, req.user.id, Date.now()).lastInsertRowid;
  const all = [req.user.id, ...ids];
  for (const uid of all) db.prepare('INSERT INTO members (conversation_id,user_id) VALUES (?,?)').run(id, uid);
  joinSockets(id, all);
  createMessage({ conversationId: id, kind: 'system', body: `${req.user.display_name} created the group "${name}"` });
  res.json({ conversation: conversationView(db.prepare('SELECT * FROM conversations WHERE id=?').get(id), req.user.id) });
});

app.get('/api/conversations/:id/messages', requireAuth, (req, res) => {
  const cid = +req.params.id;
  if (!isMember(cid, req.user.id)) return res.status(403).json({ error: 'Not a member.' });
  const q = String(req.query.q || '').trim().toLowerCase();
  if (q) { // bodies are encrypted at rest, so search happens after decrypting
    const rows = db.prepare(MSG_SQL + " WHERE m.conversation_id=? AND m.deleted=0 AND m.kind!='system' ORDER BY m.id DESC LIMIT 1500").all(cid);
    return res.json({ messages: rows.map(ser).filter((m) => m.body.toLowerCase().includes(q)).slice(0, 60) });
  }
  const before = +req.query.before || 9e15;
  const rows = db.prepare(MSG_SQL + ' WHERE m.conversation_id=? AND m.id<? ORDER BY m.id DESC LIMIT 50').all(cid, before);
  res.json({ messages: rows.reverse().map(ser), hasMore: rows.length === 50 });
});

/* ---- file upload with safety checks */
const startsWith = (b, ...bytes) => bytes.every((v, i) => b[i] === v);
const FILE_TYPES = {
  png: ['image/png', (b) => startsWith(b, 0x89, 0x50, 0x4e, 0x47)],
  jpg: ['image/jpeg', (b) => startsWith(b, 0xff, 0xd8, 0xff)],
  jpeg: ['image/jpeg', (b) => startsWith(b, 0xff, 0xd8, 0xff)],
  gif: ['image/gif', (b) => b.subarray(0, 3).toString() === 'GIF'],
  webp: ['image/webp', (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP'],
  pdf: ['application/pdf', (b) => b.subarray(0, 4).toString() === '%PDF'],
  webm: ['audio/webm', (b) => startsWith(b, 0x1a, 0x45, 0xdf, 0xa3)],
  ogg: ['audio/ogg', (b) => b.subarray(0, 4).toString() === 'OggS'],
  mp3: ['audio/mpeg', (b) => b.subarray(0, 3).toString() === 'ID3' || startsWith(b, 0xff, 0xfb) || startsWith(b, 0xff, 0xf3)],
  wav: ['audio/wav', (b) => b.subarray(0, 4).toString() === 'RIFF'],
  mp4: ['video/mp4', (b) => b.subarray(4, 8).toString() === 'ftyp'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', (b) => startsWith(b, 0x50, 0x4b)],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', (b) => startsWith(b, 0x50, 0x4b)],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', (b) => startsWith(b, 0x50, 0x4b)],
  txt: ['text/plain', (b) => !b.includes(0)],
  csv: ['text/csv', (b) => !b.includes(0)],
  md: ['text/plain', (b) => !b.includes(0)],
};
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

app.post('/api/conversations/:id/upload', requireAuth, upload.single('file'), (req, res) => {
  const cid = +req.params.id;
  if (!isMember(cid, req.user.id)) return res.status(403).json({ error: 'Not a member.' });
  if (!req.file) return res.status(400).json({ error: 'No file received.' });
  const ext = path.extname(req.file.originalname).slice(1).toLowerCase();
  const type = FILE_TYPES[ext];
  if (!type) return res.status(400).json({ error: `".${ext}" files are not allowed. Images, audio, PDF, Office docs and text only.` });
  if (!type[1](req.file.buffer)) return res.status(400).json({ error: 'Blocked: file contents do not match its extension.' });
  // Extra guard: text-like files must not smuggle scripts that a browser might render.
  if (['txt', 'csv', 'md'].includes(ext) && /<script|<iframe|javascript:/i.test(req.file.buffer.toString('utf8', 0, 200000)))
    return res.status(400).json({ error: 'Blocked: file contains potentially unsafe markup.' });

  const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), req.file.buffer);
  const voice = req.body.voice === '1' && type[0].startsWith('audio/');
  const m = createMessage({
    conversationId: cid, senderId: req.user.id, kind: 'file', body: String(req.body.caption || '').slice(0, 500),
    meta: { url: '/files/' + name, name: req.file.originalname.slice(0, 120), mime: type[0], size: req.file.size, voice },
  });
  res.json({ message: m });
});

app.get('/files/:name', requireAuth, (req, res) => {
  const name = req.params.name;
  if (!/^[a-f0-9]{32}\.[a-z0-9]{2,4}$/.test(name)) return res.status(404).end();
  const row = db.prepare('SELECT conversation_id FROM messages WHERE meta LIKE ? AND deleted=0 LIMIT 1').get('%/files/' + name + '"%');
  if (!row || !isMember(row.conversation_id, req.user.id)) return res.status(404).end();
  const type = FILE_TYPES[name.split('.').pop()];
  const inline = type[0].startsWith('image/') || type[0].startsWith('audio/') || type[0] === 'application/pdf';
  res.set({ 'Content-Type': type[0], 'Content-Disposition': inline ? 'inline' : 'attachment', 'Content-Security-Policy': "default-src 'none'; sandbox" });
  res.sendFile(path.join(UPLOAD_DIR, name));
});

/* ---------------------------------------------------------- Sumit AI (LLM) */
const aiLast = new Map();
const AI_SYSTEM = `You are Sumit, the friendly assistant inside Zephyr, a chat app for the IIT Mandi community in the Kamand Valley, Himachal Pradesh. Be warm, concise and practical (under 150 words unless asked for more). Use the chat transcript for context. Never invent campus facts you are not sure of; say so instead. Plain text only; use "- " for bullet points.`;

async function askAI(cid, user, text, summarize) {
  const now = Date.now();
  if (now - (aiLast.get(user.id) || 0) < 3000) return;
  aiLast.set(user.id, now);
  io.to('c:' + cid).emit('typing', { conversationId: cid, userId: 0, name: 'Sumit', isTyping: true });
  let reply;
  try {
    const free = process.env.AI_BASE_URL && process.env.AI_API_KEY; // any OpenAI-compatible provider (Gemini, Groq, OpenRouter, Ollama)
    if (!free && !process.env.ANTHROPIC_API_KEY) {
      reply = 'I am not switched on yet - an admin needs to add an AI key to the server .env file.';
    } else {
      const rows = db.prepare(MSG_SQL + " WHERE m.conversation_id=? AND m.deleted=0 AND m.kind IN ('text','ai') ORDER BY m.id DESC LIMIT ?")
        .all(cid, summarize ? 60 : 25).reverse().map(ser);
      const transcript = rows.map((m) => `${m.senderName}: ${m.body}`).join('\n');
      const task = summarize
        ? 'Summarise this conversation in a few bullet points: decisions, open questions, and who is doing what.'
        : `${user.display_name} asked you: ${text}`;
      const prompt = `Recent chat:\n${transcript}\n\n${task}`;
      let out;
      if (free) {
        const r = await fetch(process.env.AI_BASE_URL.replace(/\/$/, '') + '/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.AI_API_KEY },
          body: JSON.stringify({ model: process.env.AI_MODEL, max_tokens: 700, messages: [{ role: 'system', content: AI_SYSTEM }, { role: 'user', content: prompt }] }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { const err = new Error(j.error?.message || j[0]?.error?.message || 'HTTP ' + r.status); err.status = r.status; throw err; }
        out = j.choices?.[0]?.message?.content?.trim();
      } else {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: process.env.AI_MODEL || 'claude-sonnet-5-5', max_tokens: 700, system: AI_SYSTEM, messages: [{ role: 'user', content: prompt }] }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { const err = new Error(j.error?.message || 'HTTP ' + r.status); err.status = r.status; throw err; }
        out = (j.content || []).map((c) => c.text || '').join('').trim();
      }
      reply = out || 'I could not come up with a reply. Try again?';
    }
  } catch (e) {
    console.error('[ai]', e.message);
    reply = e.status === 429 ? 'I have hit the free usage limit for now. Try again in a minute.' : 'Something went wrong reaching my brain. Check the server window for details.';
  }
  io.to('c:' + cid).emit('typing', { conversationId: cid, userId: 0, name: 'Sumit', isTyping: false });
  createMessage({ conversationId: cid, kind: 'ai', body: reply });
}

/* ------------------------------------------------------------ real-time (WS) */
const online = new Map(); // userId -> open socket count

io.use((socket, next) => {
  const t = cookie.parse(socket.handshake.headers.cookie || '').token;
  const u = t && userFromToken(t);
  if (!u) return next(new Error('unauthorized'));
  socket.user = u; next();
});

io.on('connection', (socket) => {
  const u = socket.user;
  socket.join('u:' + u.id);
  for (const r of db.prepare('SELECT conversation_id FROM members WHERE user_id=?').all(u.id)) socket.join('c:' + r.conversation_id);

  online.set(u.id, (online.get(u.id) || 0) + 1);
  if (online.get(u.id) === 1) socket.broadcast.emit('presence', { userId: u.id, online: true });
  socket.emit('presence:init', [...online.keys()]);

  socket.on('message:send', (p, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const cid = +p?.conversationId;
    const body = String(p?.body || '').trim().slice(0, 4000);
    if (!body || !isMember(cid, u.id)) return ack({ error: 'Cannot send.' });

    if (/^\/focus\s+stop$/i.test(body)) {
      const row = db.prepare("SELECT id, meta FROM messages WHERE conversation_id=? AND kind='focus' AND deleted=0 ORDER BY id DESC LIMIT 1").get(cid);
      const meta = row && JSON.parse(row.meta);
      if (!meta || meta.endsAt <= Date.now()) return ack({ error: 'No focus session is running.' });
      meta.endsAt = Date.now();
      db.prepare('UPDATE messages SET meta=? WHERE id=?').run(JSON.stringify(meta), row.id);
      io.to('c:' + cid).emit('message:update', getMsg(row.id));
      return ack({ ok: true });
    }

    const focus = body.match(/^\/focus(?:\s+(\d{1,3}))?$/i);
    if (focus) {
      const minutes = Math.min(120, Math.max(5, +focus[1] || 25));
      createMessage({ conversationId: cid, senderId: u.id, kind: 'focus', body: `${u.display_name} started a ${minutes} minute focus session`,
        meta: { minutes, endsAt: Date.now() + minutes * 60000 } });
      return ack({ ok: true });
    }
    createMessage({ conversationId: cid, senderId: u.id, body });
    ack({ ok: true });

    if (/^\/(summarize|tldr)\b/i.test(body)) askAI(cid, u, '', true);
    else if (/^\/ask\s+\S/i.test(body)) askAI(cid, u, body.replace(/^\/ask\s+/i, ''), false);
    else if (/(^|\s)@sumit\b/i.test(body)) askAI(cid, u, body.replace(/@sumit/gi, '').trim() || 'say hello', false);
  });

  socket.on('typing', ({ conversationId, isTyping }) => {
    if (isMember(+conversationId, u.id))
      socket.to('c:' + conversationId).emit('typing', { conversationId: +conversationId, userId: u.id, name: u.display_name, isTyping: !!isTyping });
  });

  socket.on('read', ({ conversationId }) => { if (isMember(+conversationId, u.id)) markRead(+conversationId, u.id); });

  socket.on('reaction', ({ messageId, emoji }) => {
    const m = getMsg(+messageId);
    if (!m || !EMOJI.includes(emoji) || !isMember(m.conversationId, u.id)) return;
    const has = db.prepare('SELECT 1 FROM reactions WHERE message_id=? AND user_id=? AND emoji=?').get(m.id, u.id, emoji);
    if (has) db.prepare('DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?').run(m.id, u.id, emoji);
    else db.prepare('INSERT INTO reactions (message_id,user_id,emoji) VALUES (?,?,?)').run(m.id, u.id, emoji);
    io.to('c:' + m.conversationId).emit('message:update', getMsg(m.id));
  });

  socket.on('message:delete', ({ messageId }) => {
    const m = getMsg(+messageId);
    if (!m || m.senderId !== u.id) return;
    db.prepare('UPDATE messages SET deleted=1 WHERE id=?').run(m.id);
    io.to('c:' + m.conversationId).emit('message:update', getMsg(m.id));
  });

  socket.on('disconnect', () => {
    const n = (online.get(u.id) || 1) - 1;
    if (n <= 0) {
      online.delete(u.id);
      db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(Date.now(), u.id);
      io.emit('presence', { userId: u.id, online: false });
    } else online.set(u.id, n);
  });
});

/* ------------------------------------------------ demo accounts (optional) */
// Free hosts wipe the disk when they restart. With DEMO_SEED=true the app recreates three
// demo accounts and a few messages whenever the database is empty, so judges can always sign in.
function seedDemo() {
  if (process.env.DEMO_SEED !== 'true' || db.prepare('SELECT 1 FROM users LIMIT 1').get()) return;
  const people = [['asha', 'Asha Verma', 'CSE'], ['rohan', 'Rohan Mehta', 'EE'], ['meera', 'Meera Nair', 'DSAI']];
  const ids = people.map(([u, n, b], i) => db.prepare('INSERT INTO users (username,display_name,password_hash,branch,avatar_color,created_at) VALUES (?,?,?,?,?,?)')
    .run(u, n, bcrypt.hashSync('demo1234', 10), b, COLORS[i], Date.now()).lastInsertRowid);
  const rooms = db.prepare("SELECT id,name FROM conversations WHERE type='room'").all();
  for (const r of rooms) for (const id of ids) db.prepare('INSERT OR IGNORE INTO members (conversation_id,user_id,last_read_id) VALUES (?,?,0)').run(r.id, id);
  const room = (n) => rooms.find((r) => r.name === n).id;
  const say = (cid, uid, body) => db.prepare("INSERT INTO messages (conversation_id,sender_id,kind,body,created_at) VALUES (?,?,'text',?,?)").run(cid, uid, enc(body), Date.now());
  say(room('Commons'), ids[0], 'Welcome to Zephyr! This is the Commons, open to everyone in the valley.');
  say(room('Commons'), ids[1], 'Try the other rooms, and type /focus 25 in Study Hall for a shared timer.');
  say(room('Study Hall'), ids[2], 'Quiz prep tonight? Start a timer and let us begin.');
  say(room('Lost & Found'), ids[1], 'Found a blue water bottle near the library. Message me to claim it.');
  console.log('[zephyr] demo accounts created: asha, rohan, meera (password: demo1234)');
}
seedDemo();

server.listen(PORT, () => console.log(`Zephyr is up on http://localhost:${PORT}`));

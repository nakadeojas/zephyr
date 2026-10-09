const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(dir, { recursive: true });

const db = new DatabaseSync(path.join(dir, 'zephyr.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  branch TEXT DEFAULT '',
  avatar_color TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('dm','group','room')),
  name TEXT,
  description TEXT DEFAULT '',
  dm_key TEXT UNIQUE,
  created_by INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'text',   -- text | file | focus | ai | system
  body TEXT NOT NULL DEFAULT '',       -- AES-256-GCM encrypted at rest
  meta TEXT,                           -- JSON (file info, focus session)
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);
CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
`);

// Migration for databases created before profiles existed.
try { db.exec("ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT ''"); } catch { /* column already there */ }

// Campus rooms every new user is auto-joined to.
const ROOMS = [
  ['Commons', 'The valley square. Anything and everything.'],
  ['Hostel Hub', 'Mess menus, laundry, noisy neighbours.'],
  ['Clubs & Societies', 'Recruitments, events, and who has the keys.'],
  ['Lost & Found', 'Lost an ID card? Found a water bottle? Post it here.'],
  ['Placements & Internships', 'Prep, referrals and offer-day screaming.'],
  ['Study Hall', 'Quiet-ish. Start a shared timer with /focus 25.'],
];
if (!db.prepare("SELECT 1 FROM conversations WHERE type='room' LIMIT 1").get()) {
  const ins = db.prepare("INSERT INTO conversations (type,name,description,created_at) VALUES ('room',?,?,?)");
  for (const [n, d] of ROOMS) ins.run(n, d, Date.now());
}

module.exports = db;

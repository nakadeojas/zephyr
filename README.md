# Zephyr - real-time campus chat (Aurora theme)

Built for the **First Commit** hackathon (Kamand Prompt, IIT Mandi). Zephyr is a campus-first chat app: every student lands in six campus rooms, can DM anyone, build groups, and study together with shared focus timers.

## Features

**Mandatory core**
- Register, sign in, sign out; session kept in an httpOnly JWT cookie (7 days)
- One-to-one chat delivered in real time over WebSockets (Socket.IO); every message is tied to its sender and conversation

**Beyond the core**
- Campus rooms: Commons, Hostel Hub, Clubs & Societies, Lost & Found, Placements & Internships, Study Hall (auto-joined)
- Focus sessions: `/focus 25` starts a shared countdown (5-120 min); `/focus stop` ends it early
- **Sumit AI assistant**: `@sumit <question>`, `/ask <question>` or `/summarize` (also the Summarize button in the chat header). Sumit reads the recent chat for context. The API key stays on the server.
- Light and dark themes (saved per browser), profile page with editable name, branch, bio and avatar colour, plus activity stats
- Landing screen with rotating quotes; room icons, emoji picker, Ctrl/Cmd+K chat filter
- Group chats
- Persistent SQLite database; message text encrypted at rest (AES-256-GCM)
- Images, files and browser-recorded voice notes
- File safety: extension allow-list, magic-byte check, 10 MB limit, random file names, script-markup scan for text files, sandboxed downloads, member-only access
- Reactions, typing indicators, read receipts, online/offline presence, message search, message deletion, unread badges, desktop notifications, clickable links

## Architecture

```
Browser (vanilla JS SPA)  <-- HTTP (auth, history, upload) -->  Express
        |                                                         |
        +------------- WebSocket (Socket.IO) -----------------+  |
                                                              v  v
                                                    SQLite (built-in node:sqlite)
                                                    uploads/ (private files)
                                                    LLM API (server-side only)
```

- `server/index.js` - REST API, WebSocket events, auth, uploads
- `server/db.js` - schema and room seeding
- `public/` - frontend (no build step)

Sockets authenticate with the same cookie as HTTP, and every event checks conversation membership.

## Run locally

Requires Node 22.5+ (uses built-in `node:sqlite`, so nothing native to compile).

```bash
npm install
cp .env.example .env      # set JWT_SECRET and MESSAGE_KEY
npm start                 # http://localhost:3000
```

| Variable | Purpose |
|---|---|
| `PORT` | Server port (default 3000) |
| `JWT_SECRET` | Signs session tokens |
| `MESSAGE_KEY` | Derives the AES key for messages at rest |
| `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` | Optional: free AI via Gemini, Groq, OpenRouter or local Ollama (see `.env.example`) |
| `ANTHROPIC_API_KEY` | Optional alternative: paid Anthropic API |
| `COOKIE_SECURE` | `true` when served over HTTPS |

Generate secrets: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## Test in a clean environment

1. `npm install && npm start`
2. Open `http://localhost:3000` in two browsers (or one normal + one private window).
3. Register `alice` and `bob`; start a DM; messages arrive instantly and ticks turn blue when read.
4. In Study Hall run `/focus 5` in both windows, then `/focus stop`.
5. With `ANTHROPIC_API_KEY` set, type `@sumit what can I do this weekend in Mandi?` or click Summarize.
6. Send an image, record a voice note, react, search, delete. Upload a `.exe` or a text file renamed `.png`: both are rejected.

## Deploying (free)

The app needs a host that supports WebSockets. On Render's free plan:

1. Push the repo to GitHub (keep it private until the hackathon ends).
2. Render > New > Web Service > pick the repo. Build command `npm install`, start command `npm start`, instance type Free.
3. Add environment variables: `NODE_VERSION=22`, `JWT_SECRET`, `MESSAGE_KEY` (random strings), `COOKIE_SECURE=true`, `DEMO_SEED=true`, plus `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` for the AI assistant.
4. Free services sleep after about 15 minutes idle and use a temporary disk, so data resets on restart. `DEMO_SEED=true` recreates the demo accounts (asha, rohan, meera; password `demo1234`) automatically. For permanent data use a host with a persistent disk.

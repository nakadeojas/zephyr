const $ = (s) => document.querySelector(s);
const EMOJI = ['👍', '❤️', '😂', '🔥', '🙏', '🎉'];
const state = { me: null, convs: [], active: null, msgs: {}, online: new Set(), typing: {}, socket: null, searching: false, mode: 'login' };

/* ---------- theme, quotes, icons */
const QUOTES = [
  ['The mountains are calling and I must go.', 'John Muir'],
  ['Not all those who wander are lost.', 'J.R.R. Tolkien'],
  ['A zephyr is a soft wind. One message can travel the whole valley.', ''],
  ['Up here, even the clouds stop to listen.', ''],
  ['Great projects start with one small first commit.', ''],
  ['Study hard, laugh louder, never skip the mess dessert.', ''],
];
const ico = (d) => '<svg viewBox="0 0 24 24">' + d.split('|').map((p) => `<path d="${p}"/>`).join('') + '</svg>';
const ROOMS = {
  'Commons': [ico('M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2|M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z|M23 21v-2a4 4 0 0 0-3-3.87|M16 3.13a4 4 0 0 1 0 7.75'), '#2f6fb3'],
  'Hostel Hub': [ico('M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z|M9 22V12h6v10'), '#3f8a5a'],
  'Clubs & Societies': [ico('M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z|M4 22v-7'), '#7a4fa3'],
  'Lost & Found': [ico('M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z|M21 21l-4.35-4.35'), '#c8452f'],
  'Placements & Internships': [ico('M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z|M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16'), '#1f8a8a'],
  'Study Hall': [ico('M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z|M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z'), '#d49a1c'],
};
const AVATAR_COLORS = ['#2f6fb3', '#c8452f', '#3f8a5a', '#d49a1c', '#7a4fa3', '#1f8a8a', '#b5527a'];
const roomAvatar = (name, cls = '') => {
  const [svg, color] = ROOMS[name] || ['#', '#27403a'];
  return `<div class="avatar ${cls}" style="background:${color};color:#fff">${svg}</div>`;
};

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('zy-theme', t); } catch {}
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', t === 'dark' ? '#080f0c' : '#0e1915');
  $('#p-light')?.classList.toggle('on', t === 'light');
  $('#p-dark')?.classList.toggle('on', t === 'dark');
}
const curTheme = () => document.documentElement.dataset.theme || 'light';
document.querySelectorAll('.theme-btn').forEach((b) => b.onclick = (e) => { e.stopPropagation(); applyTheme(curTheme() === 'dark' ? 'light' : 'dark'); });

let qi = Math.floor(Math.random() * QUOTES.length);
function setQuote() { const [t, by] = QUOTES[qi]; $('#q-text').textContent = '\u201C' + t + '\u201D'; $('#q-by').textContent = by ? '\u2014 ' + by : ''; }
setInterval(() => {
  if ($('#auth').classList.contains('hidden')) return;
  const f = document.querySelector('.quote'); f.classList.add('swap');
  setTimeout(() => { qi = (qi + 1) % QUOTES.length; setQuote(); f.classList.remove('swap'); }, 420);
}, 7000);

/* ---------- utilities */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const linkify = (s) => esc(s).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
const mdLite = (s) => {
  const lines = esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').split('\n');
  let out = '', inList = false;
  for (const l of lines) {
    const m = l.match(/^\s*[-*]\s+(.*)/);
    if (m) { if (!inList) { out += '<ul>'; inList = true; } out += '<li>' + m[1] + '</li>'; }
    else { if (inList) { out += '</ul>'; inList = false; } out += (l ? l + '<br>' : ''); }
  }
  return out + (inList ? '</ul>' : '');
};
const SPARK = '<svg viewBox="0 0 24 24"><path d="M12 2l2.2 6.3L20 10l-5.8 1.7L12 18l-2.2-6.3L4 10l5.8-1.7z"/></svg>';
const initials = (n) => (n || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const time = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const day = (t) => new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const avatar = (name, color, dotUserId) =>
  `<div class="avatar" style="background:${color}">${esc(initials(name))}${dotUserId ? `<span class="dot ${state.online.has(dotUserId) ? 'on' : ''}"></span>` : ''}</div>`;

let toastT;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3200);
}

async function api(path, opt = {}) {
  const isForm = opt.body instanceof FormData;
  const r = await fetch('/api' + path, {
    method: opt.method || (opt.body ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: opt.body && !isForm ? { 'Content-Type': 'application/json' } : {},
    body: opt.body ? (isForm ? opt.body : JSON.stringify(opt.body)) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}

function showView(v) {
  ['empty', 'chat', 'profile'].forEach((x) => $('#' + x).classList.toggle('hidden', x !== v));
  $('#app').classList.toggle('in-chat', v !== 'empty');
}
const peer = (c) => c.type === 'dm' ? c.members.find((m) => m.id !== state.me.id) : null;
const title = (c) => c.type === 'dm' ? (peer(c)?.displayName || 'Chat') : c.name;
const conv = (id) => state.convs.find((c) => c.id === id);
function preview(m) {
  if (!m) return 'No messages yet';
  if (m.deleted) return 'Message deleted';
  if (m.kind === 'file') return m.meta?.voice ? 'Voice note' : 'File: ' + m.meta?.name;
  if (m.kind === 'focus') return 'Focus session';
  const who = m.senderId === state.me.id ? 'You: ' : '';
  return who + m.body;
}

/* ---------- auth screen */
function setMode(mode) {
  state.mode = mode;
  $('#tab-login').classList.toggle('on', mode === 'login');
  $('#tab-register').classList.toggle('on', mode === 'register');
  document.querySelectorAll('.reg').forEach((e) => e.classList.toggle('hidden', mode === 'login'));
  $('#auth-btn').textContent = mode === 'login' ? 'Sign in' : 'Create account';
  $('#f-pass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#auth-err').textContent = '';
}
$('#tab-login').onclick = () => setMode('login');
$('#tab-register').onclick = () => setMode('register');
$('#auth-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const body = { username: $('#f-user').value, password: $('#f-pass').value };
    if (state.mode === 'register') Object.assign(body, { displayName: $('#f-name').value, branch: $('#f-branch').value });
    const { user } = await api(state.mode === 'login' ? '/login' : '/register', { body });
    startApp(user);
  } catch (err) { $('#auth-err').textContent = err.message; }
};
$('#logout').onclick = async () => { await api('/logout', { body: {} }); location.reload(); };

/* ---------- boot */
async function boot() {
  setMode('login'); setQuote(); applyTheme(curTheme());
  try { startApp((await api('/me')).user); }
  catch { $('#auth').classList.remove('hidden'); }
}
async function startApp(user) {
  state.me = user;
  $('#auth').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#me-avatar').style.background = user.color; $('#me-avatar').textContent = initials(user.displayName);
  $('#me-name').textContent = user.displayName; $('#me-branch').textContent = user.branch ? user.branch + ' - @' + user.username : '@' + user.username;
  setGreeting();
  connect();
  await loadConvs();
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
}
async function loadConvs() {
  state.convs = (await api('/conversations')).conversations;
  renderList();
}

function setGreeting() {
  const h = new Date().getHours();
  $('#greet').textContent = `Good ${h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'}, ${state.me.displayName.split(' ')[0]}`;
  const [t, by] = QUOTES[Math.floor(Math.random() * QUOTES.length)];
  $('#eq').textContent = '\u201C' + t + '\u201D' + (by ? ' \u2014 ' + by : '');
}

/* ---------- profile page */
let pColor = null;
function paintProfile(u) {
  $('#p-avatar').style.background = u.color; $('#p-avatar').textContent = initials(u.displayName);
  $('#p-name').textContent = u.displayName; $('#p-handle').textContent = '@' + u.username + (u.branch ? ' \u00B7 ' + u.branch : '');
  $('#p-bio').textContent = u.bio || 'No bio yet. Add one below.';
  $('#p-joined').textContent = 'Member since ' + new Date(u.createdAt).toLocaleDateString([], { month: 'long', year: 'numeric' });
}
async function openProfile() {
  showView('profile');
  $('#p-err').textContent = '';
  const { user, stats } = await api('/profile');
  state.me = user; pColor = user.color;
  paintProfile(user);
  $('#p-dn').value = user.displayName; $('#p-br').value = user.branch || 'Other'; $('#p-bio-in').value = user.bio || '';
  $('#p-colors').innerHTML = AVATAR_COLORS.map((c) => `<button type="button" data-c="${c}" class="${c === pColor ? 'on' : ''}" style="background:${c}" aria-label="Colour ${c}"></button>`).join('');
  const cards = [['messages', 'Messages sent'], ['files', 'Files shared'], ['focus', 'Focus sessions'], ['reactions', 'Reactions given'], ['rooms', 'Rooms joined'], ['groups', 'Groups']];
  $('#p-stats').innerHTML = cards.map(([k, l]) => `<div class="stat"><b>${stats[k] ?? 0}</b><span>${l}</span></div>`).join('') ;
  applyTheme(curTheme());
}
$('#me-btn').onclick = () => openProfile().catch((e) => toast(e.message));
$('#p-back').onclick = () => showView(state.active ? 'chat' : 'empty');
$('#p-light').onclick = () => applyTheme('light');
$('#p-dark').onclick = () => applyTheme('dark');
$('#p-colors').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  pColor = b.dataset.c;
  document.querySelectorAll('#p-colors button').forEach((x) => x.classList.toggle('on', x === b));
  $('#p-avatar').style.background = pColor;
};
$('#p-dn').oninput = (e) => { $('#p-avatar').textContent = initials(e.target.value || '?'); };
$('#p-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const { user } = await api('/profile', { method: 'PATCH', body: { displayName: $('#p-dn').value, branch: $('#p-br').value, bio: $('#p-bio-in').value, color: pColor } });
    state.me = user; paintProfile(user);
    $('#me-avatar').style.background = user.color; $('#me-avatar').textContent = initials(user.displayName);
    $('#me-name').textContent = user.displayName; $('#me-branch').textContent = (user.branch ? user.branch + ' - ' : '') + '@' + user.username;
    setGreeting(); loadConvs(); toast('Profile saved');
  } catch (err) { $('#p-err').textContent = err.message; }
};

/* ---------- emoji picker */
const EMOJIS = '😀 😂 😅 😊 😍 🥳 😎 🤔 😭 😴 🤯 🙌 👍 👏 🙏 🔥 ❤️ 💯 🎉 ✨ 📚 ☕ 🍜 🍕 🏔️ 🌲 ❄️ 🌄'.split(' ');
$('#emoji').innerHTML = EMOJIS.map((e) => `<button type="button">${e}</button>`).join('');
$('#emo').onclick = (e) => { e.stopPropagation(); $('#emoji').classList.toggle('hidden'); };
$('#emoji').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const t = $('#text'), s = t.selectionStart ?? t.value.length;
  t.value = t.value.slice(0, s) + b.textContent + t.value.slice(t.selectionEnd ?? s);
  t.focus(); t.selectionStart = t.selectionEnd = s + b.textContent.length;
};
document.addEventListener('click', (e) => { if (!e.target.closest('#emoji')) $('#emoji').classList.add('hidden'); });
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !$('#app').classList.contains('hidden')) { e.preventDefault(); $('#filter').focus(); }
  if (e.key === 'Escape') $('#emoji').classList.add('hidden');
});

/* ---------- sidebar */
function renderList() {
  const groups = [['Campus rooms', 'room'], ['Groups', 'group'], ['Direct messages', 'dm']];
  let html = '';
  for (const [label, type] of groups) {
    const f = $('#filter').value.trim().toLowerCase();
    const items = state.convs.filter((c) => c.type === type && (!f || title(c).toLowerCase().includes(f)));
    if (!items.length) continue;
    html += `<div class="group-title">${label}</div>`;
    for (const c of items) {
      const p = peer(c);
      const av = p ? avatar(p.displayName, p.color, p.id) : type === 'room' ? roomAvatar(c.name) : `<div class="avatar" style="background:#7a4fa3">${esc(initials(c.name))}</div>`;
      html += `<div class="item ${c.id === state.active ? 'on' : ''}" data-id="${c.id}" tabindex="0">${av}
        <div class="grow"><div class="t">${esc(title(c))}</div><div class="p">${esc(preview(c.lastMessage))}</div></div>
        ${c.unread ? `<span class="badge">${c.unread}</span>` : ''}</div>`;
    }
  }
  $('#list').innerHTML = html;
  const total = state.convs.reduce((n, c) => n + c.unread, 0);
  document.title = (total ? `(${total}) ` : '') + 'Zephyr';
}
$('#filter').oninput = renderList;
$('#list').onclick = (e) => { const it = e.target.closest('.item'); if (it) openConv(+it.dataset.id); };
$('#list').onkeydown = (e) => { if (e.key === 'Enter') e.target.click?.(); };

/* ---------- conversation view */
async function openConv(id) {
  state.active = id; state.searching = false; $('#search').value = '';
  const c = conv(id);
  showView('chat');
  $('#c-title').textContent = title(c);
  renderHeaderSub();
  if (!state.msgs[id]) state.msgs[id] = (await api(`/conversations/${id}/messages`)).messages;
  c.unread = 0; renderList(); renderMsgs(true); renderTyping();
  state.socket.emit('read', { conversationId: id });
  $('#text').focus();
}
function renderHeaderSub() {
  const c = conv(state.active); if (!c) return;
  let sub = c.description || '';
  if (c.type === 'room') sub += ` (${c.memberCount} members)`;
  if (c.type === 'group') sub = c.members.map((m) => m.displayName).join(', ');
  if (c.type === 'dm') { const p = peer(c); sub = (state.online.has(p.id) ? 'Online now' : 'Offline') + (p.branch ? ' - ' + p.branch : ''); }
  $('#c-sub').textContent = sub;
}
$('#back').onclick = () => { showView('empty'); state.active = null; renderList(); };

function ticks(m, c) {
  if (m.senderId !== state.me.id || c.type === 'room') return '';
  const others = c.members.filter((x) => x.id !== state.me.id);
  const read = others.length && others.every((x) => x.lastReadId >= m.id);
  return `<span class="tick ${read ? 'read' : ''}" title="${read ? 'Read' : 'Delivered'}">${read ? '✓✓' : '✓'}</span>`;
}

function msgHtml(m, prev, c, next) {
  let out = '';
  if (!prev || day(prev.createdAt) !== day(m.createdAt)) out += `<div class="day">${day(m.createdAt)}</div>`;
  if (m.kind === 'system') return out + `<div class="sys">${esc(m.body)}</div>`;
  if (m.kind === 'focus' && !m.deleted) {
    return out + `<div class="focus" data-end="${m.meta.endsAt}" data-total="${m.meta.minutes * 60000}"><div>${esc(m.body)}</div><div class="clock">--:--</div><div class="bar"><i></i></div><small>Study together, phones down.</small></div>`;
  }
  const mine = m.senderId === state.me.id;
  const ai = m.kind === 'ai';
  const grouped = (x, y) => x && y && ['text', 'file', 'ai'].includes(x.kind) && x.kind === y.kind && x.senderId === y.senderId
    && day(x.createdAt) === day(y.createdAt) && y.createdAt - x.createdAt < 300000;
  const cont = grouped(prev, m), nextCont = grouped(m, next);
  let inner;
  if (m.deleted) inner = 'This message was deleted';
  else {
    inner = '';
    if (m.kind === 'file') {
      const f = m.meta, url = esc(f.url);
      if (f.mime.startsWith('image/')) inner += `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${esc(f.name)}" loading="lazy"></a>`;
      else if (f.mime.startsWith('audio/')) inner += `<audio controls src="${url}"></audio>`;
      else inner += `<a href="${url}" target="_blank" rel="noopener">${esc(f.name)}</a> <small>(${Math.ceil(f.size / 1024)} KB)</small>`;
    }
    if (m.body) inner += (inner ? '<br>' : '') + (ai ? mdLite(m.body) : linkify(m.body));
  }
  const reacts = Object.entries(m.reactions || {}).map(([e, users]) =>
    `<button data-react="${e}" data-id="${m.id}" class="${users.includes(state.me.id) ? 'mine' : ''}">${e} ${users.length}</button>`).join('');
  const tools = m.deleted ? '' : `<div class="tools">${EMOJI.map((e) => `<button data-react="${e}" data-id="${m.id}" aria-label="React ${e}">${e}</button>`).join('')}${mine ? `<button data-del="${m.id}" aria-label="Delete">🗑</button>` : ''}</div>`;
  const who = ai ? (cont ? '' : `<div class="ai-name">${SPARK}Sumit</div>`)
    : (!mine && !cont && c.type !== 'dm' ? `<div class="who" style="color:${m.senderColor || '#555'}">${esc(m.senderName)}</div>` : '');
  return out + `<div class="row-m ${mine ? 'me' : ''} ${ai ? 'ai' : ''} ${cont ? 'cont' : ''} ${m.deleted ? 'deleted' : ''}" data-mid="${m.id}">${who}${tools}
    <div class="bubble">${inner}</div>${reacts ? `<div class="reacts">${reacts}</div>` : ''}
    ${nextCont ? '' : `<div class="meta">${time(m.createdAt)} ${ticks(m, c)}</div>`}</div>`;
}

function renderMsgs(scroll, list) {
  const c = conv(state.active); if (!c) return;
  const msgs = list || state.msgs[state.active] || [];
  const box = $('#msgs');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const head = !list && msgs.length < 50 && c.type !== 'dm'
    ? `<div class="welcome">${c.type === 'room' ? roomAvatar(c.name) : `<div class="avatar" style="background:#7a4fa3;color:#fff">${esc(initials(c.name))}</div>`}<strong>${esc(c.name)}</strong><span>${esc(c.description || 'A private group. Say hello.')}</span></div>` : '';
  box.innerHTML = head + (msgs.length ? msgs.map((m, i) => msgHtml(m, msgs[i - 1], c, msgs[i + 1])).join('') : '<div class="sys">Nothing here yet. Say hello.</div>');
  if (scroll || atBottom) box.scrollTop = box.scrollHeight;
  tickFocus();
}

$('#msgs').onclick = (e) => {
  const r = e.target.closest('[data-react]');
  if (r) state.socket.emit('reaction', { messageId: +r.dataset.id, emoji: r.dataset.react });
  const d = e.target.closest('[data-del]');
  if (d && confirm('Delete this message for everyone?')) state.socket.emit('message:delete', { messageId: +d.dataset.del });
};

function tickFocus() {
  document.querySelectorAll('.focus').forEach((el) => {
    const left = Math.max(0, Math.round((+el.dataset.end - Date.now()) / 1000));
    el.querySelector('.clock').textContent = left ? `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}` : 'Done';
    el.classList.toggle('done', !left);
    const total = +el.dataset.total || 1;
    el.querySelector('.bar i').style.width = (left ? Math.min(100, 100 - (left * 1000 / total) * 100) : 100) + '%';
  });
}
setInterval(tickFocus, 1000);

/* ---------- typing */
function renderTyping() {
  const t = state.typing[state.active] || {};
  const names = Object.entries(t).filter(([id]) => id !== '0').map(([, n]) => n);
  const ai = '0' in t;
  $('#typing').textContent = ai ? 'Sumit is thinking...' : names.length ? `${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} typing...` : '';
}
let typingOn = false, typingT;
$('#text').addEventListener('input', () => {
  if (!state.active) return;
  if (!typingOn) { typingOn = true; state.socket.emit('typing', { conversationId: state.active, isTyping: true }); }
  clearTimeout(typingT);
  typingT = setTimeout(() => { typingOn = false; state.socket.emit('typing', { conversationId: state.active, isTyping: false }); }, 1800);
});

/* ---------- sending */
$('#composer').onsubmit = (e) => {
  e.preventDefault();
  const body = $('#text').value.trim();
  if (!body || !state.active) return;
  state.socket.emit('message:send', { conversationId: state.active, body }, (res) => { if (res?.error) toast(res.error); });
  $('#text').value = '';
  typingOn = false; state.socket.emit('typing', { conversationId: state.active, isTyping: false });
};

async function sendFile(file, voice) {
  if (!file || !state.active) return;
  const fd = new FormData(); fd.append('file', file); if (voice) fd.append('voice', '1');
  try { await api(`/conversations/${state.active}/upload`, { body: fd }); }
  catch (err) { toast(err.message); }
}
$('#file').onchange = (e) => { sendFile(e.target.files[0]); e.target.value = ''; };

let rec, chunks = [];
$('#rec').onclick = async () => {
  const btn = $('#rec');
  if (rec && rec.state === 'recording') { rec.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    rec = new MediaRecorder(stream); chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      btn.classList.remove('rec'); btn.title = 'Record a voice note';
      const blob = new Blob(chunks, { type: 'audio/webm' });
      if (blob.size > 800) sendFile(new File([blob], 'voice-note.webm', { type: 'audio/webm' }), true);
    };
    rec.start(); btn.classList.add('rec'); btn.title = 'Stop recording';
  } catch { toast('Microphone access was blocked.'); }
};

/* ---------- Sumit AI shortcuts */
$('#ask').onclick = () => { const t = $('#text'); if (!t.value.startsWith('@sumit')) t.value = '@sumit ' + t.value; t.focus(); };
$('#sum').onclick = () => { if (state.active) state.socket.emit('message:send', { conversationId: state.active, body: '/summarize' }, (r) => r?.error && toast(r.error)); };

/* ---------- search */
let searchT;
$('#search').oninput = (e) => {
  clearTimeout(searchT);
  const q = e.target.value.trim();
  searchT = setTimeout(async () => {
    if (!state.active) return;
    if (!q) { state.searching = false; return renderMsgs(true); }
    state.searching = true;
    const { messages } = await api(`/conversations/${state.active}/messages?q=${encodeURIComponent(q)}`);
    renderMsgs(true, messages.reverse());
  }, 300);
};

/* ---------- sockets */
function connect() {
  const s = state.socket = io();
  s.on('connect_error', () => toast('Connection lost. Retrying...'));
  s.on('presence:init', (ids) => { state.online = new Set(ids); renderList(); renderHeaderSub(); });
  s.on('presence', ({ userId, online }) => { online ? state.online.add(userId) : state.online.delete(userId); renderList(); renderHeaderSub(); });
  s.on('conversation:new', loadConvs);

  s.on('message:new', (m) => {
    const c = conv(m.conversationId);
    if (!c) return loadConvs();
    if (state.msgs[m.conversationId]) state.msgs[m.conversationId].push(m);
    c.lastMessage = m; c.sortKey = m.createdAt;
    state.convs.sort((a, b) => b.sortKey - a.sortKey);
    const viewing = state.active === m.conversationId && !document.hidden && !$('#chat').classList.contains('hidden');
    if (state.active === m.conversationId && !state.searching) renderMsgs(false);
    if (viewing) s.emit('read', { conversationId: m.conversationId });
    else if (m.senderId !== state.me.id) {
      c.unread++;
      if (document.hidden && Notification.permission === 'granted')
        new Notification(`${m.senderName} in ${title(c)}`, { body: preview(m).replace(/^You: /, '') });
    }
    renderList();
  });
  s.on('message:update', (m) => {
    const list = state.msgs[m.conversationId];
    const i = list?.findIndex((x) => x.id === m.id);
    if (i >= 0) list[i] = m;
    const c = conv(m.conversationId);
    if (c?.lastMessage?.id === m.id) c.lastMessage = m;
    if (state.active === m.conversationId && !state.searching) renderMsgs(false);
    renderList();
  });
  s.on('read', ({ conversationId, userId, lastReadId }) => {
    const c = conv(conversationId);
    const mem = c?.members?.find((x) => x.id === userId);
    if (mem) mem.lastReadId = Math.max(mem.lastReadId, lastReadId);
    if (state.active === conversationId && !state.searching) renderMsgs(false);
  });
  s.on('typing', ({ conversationId, userId, name, isTyping }) => {
    if (userId === state.me.id) return;
    const t = (state.typing[conversationId] ||= {});
    if (isTyping) t[userId] = name; else delete t[userId];
    if (isTyping) setTimeout(() => { delete t[userId]; renderTyping(); }, userId === 0 ? 45000 : 6000);
    if (conversationId === state.active) renderTyping();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.active) { const c = conv(state.active); c.unread = 0; renderList(); s.emit('read', { conversationId: state.active }); }
  });
}

/* ---------- new chat dialog */
const dlg = $('#dlg');
let dlgMode = 'dm', picked = new Set(), userCache = [];
function dlgSet(mode) {
  dlgMode = mode; picked.clear();
  $('#d-dm').classList.toggle('on', mode === 'dm'); $('#d-group').classList.toggle('on', mode === 'group');
  $('#d-name').classList.toggle('hidden', mode === 'dm'); $('#d-create').classList.toggle('hidden', mode === 'dm');
  $('#d-err').textContent = ''; renderUsers();
}
async function searchUsers() { userCache = (await api('/users?q=' + encodeURIComponent($('#d-q').value))).users; renderUsers(); }
function renderUsers() {
  $('#d-users').innerHTML = userCache.map((u) => `<div class="u" data-id="${u.id}">${avatar(u.displayName, u.color, u.id)}
    <div class="grow"><strong>${esc(u.displayName)}</strong><br><small>@${esc(u.username)} ${esc(u.branch)}</small></div>
    ${dlgMode === 'group' ? `<input type="checkbox" style="width:auto" ${picked.has(u.id) ? 'checked' : ''} tabindex="-1">` : ''}</div>`).join('')
    || '<p class="sys">No one found yet. Ask a friend to sign up.</p>';
}
$('#new-chat').onclick = () => { dlgSet('dm'); $('#d-q').value = ''; searchUsers(); dlg.showModal(); };
$('#d-dm').onclick = () => dlgSet('dm');
$('#d-group').onclick = () => dlgSet('group');
$('#d-cancel').onclick = () => dlg.close();
let dq; $('#d-q').oninput = () => { clearTimeout(dq); dq = setTimeout(searchUsers, 250); };
$('#d-users').onclick = async (e) => {
  const row = e.target.closest('.u'); if (!row) return;
  const id = +row.dataset.id;
  if (dlgMode === 'group') { picked.has(id) ? picked.delete(id) : picked.add(id); return renderUsers(); }
  try {
    const { conversation } = await api('/conversations/dm', { body: { userId: id } });
    dlg.close(); await loadConvs(); openConv(conversation.id);
  } catch (err) { $('#d-err').textContent = err.message; }
};
$('#d-create').onclick = async () => {
  try {
    const { conversation } = await api('/conversations/group', { body: { name: $('#d-name').value, memberIds: [...picked] } });
    dlg.close(); await loadConvs(); openConv(conversation.id);
  } catch (err) { $('#d-err').textContent = err.message; }
};

function drawFlags() {
  const line = document.getElementById('flag-line'), g = document.getElementById('flag-group');
  if (!line || !g) return;
  const L = line.getTotalLength(), colors = ['#3b7cc4', '#f1eee3', '#c4432d', '#3d8758', '#e2a52e'], n = 22;
  for (let i = 1; i < n; i++) {
    const p = line.getPointAtLength((L * i) / n), q = line.getPointAtLength((L * i) / n + 1);
    const ang = Math.atan2(q.y - p.y, q.x - p.x) * 180 / Math.PI;
    const f = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    f.setAttribute('points', '-13,0 13,0 0,34');
    f.setAttribute('fill', colors[i % 5]); f.setAttribute('opacity', '.95');
    f.setAttribute('transform', `translate(${p.x} ${p.y}) rotate(${ang})`);
    g.appendChild(f);
  }
}
/* ---------- landing + rail wiring */
function goAuth(mode) { setMode(mode); $('#signin').scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => $(mode === 'login' ? '#f-user' : '#f-name').focus({ preventScroll: true }), 450); }
$('#nav-signin').onclick = () => goAuth('login');
$('#nav-join').onclick = () => goAuth('register');
$('#panel-head').onclick = () => openProfile().catch((e) => toast(e.message));
$('#rail-chats').onclick = () => { if (innerWidth <= 760) { showView('empty'); state.active = null; renderList(); } };
boot();

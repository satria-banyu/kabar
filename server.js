const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');

const app = express();
app.use(express.json({ limit: '20kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const SESSION_COOKIE = 'sid';
const PAGE_SIZE = 20;

// --- helpers ---

function clean(str, max) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, max);
}

function publicUser(u) {
  return u && { id: u.id, username: u.username, display_name: u.display_name, bio: u.bio, created_at: u.created_at };
}

app.use((req, res, next) => {
  const token = req.cookies[SESSION_COOKIE];
  if (token) {
    req.user = db.prepare(
      'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'
    ).get(token);
  }
  next();
});

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in first.' });
  next();
}

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 30,
  });
}

// Posts with author, like count, comment count and whether the viewer liked it.
function postQuery(where, viewerId) {
  return `
    SELECT p.id, p.body, p.created_at,
           u.username, u.display_name,
           (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
           (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
           EXISTS (SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = ${Number(viewerId) || 0}) AS liked
    FROM posts p JOIN users u ON u.id = p.user_id
    WHERE ${where}
    ORDER BY p.id DESC
    LIMIT ${PAGE_SIZE}`;
}

function beforeId(req) {
  const n = parseInt(req.query.before, 10);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

// --- auth ---

app.post('/api/register', (req, res) => {
  const username = clean(req.body.username, 30).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const display_name = clean(req.body.display_name, 50) || username;
  if (!/^[a-z0-9_]{3,30}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-30 characters: letters, numbers or _.' });
  }
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: 'That username is taken.' });
  }
  const hash = bcrypt.hashSync(password, 10);
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, ?)'
  ).run(username, display_name, hash);
  startSession(res, lastInsertRowid);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid)) });
});

app.post('/api/login', (req, res) => {
  const username = clean(req.body.username, 30);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  startSession(res, user.id);
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies[SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ user: null, unread: 0 });
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE recipient_id = ? AND read_at IS NULL').get(req.user.id);
  res.json({ user: publicUser(req.user), unread: n });
});

app.put('/api/me', requireAuth, (req, res) => {
  const display_name = clean(req.body.display_name, 50) || req.user.display_name;
  const bio = clean(req.body.bio, 300);
  db.prepare('UPDATE users SET display_name = ?, bio = ? WHERE id = ?').run(display_name, bio, req.user.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});

// --- users / profiles ---

app.get('/api/users', (req, res) => {
  const q = clean(req.query.q, 30).replace(/[%_\\]/g, '\\$&');
  const users = db.prepare(
    `SELECT * FROM users WHERE username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\'
     ORDER BY username LIMIT 20`
  ).all(`%${q}%`, `%${q}%`);
  res.json({ users: users.map(publicUser) });
});

app.get('/api/users/:username', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const stats = db.prepare(
    `SELECT (SELECT COUNT(*) FROM posts WHERE user_id = ?) AS posts,
            (SELECT COUNT(*) FROM likes l JOIN posts p ON p.id = l.post_id WHERE p.user_id = ?) AS likes_received`
  ).get(user.id, user.id);
  const posts = db.prepare(postQuery('p.user_id = ? AND p.id < ?', req.user?.id)).all(user.id, beforeId(req));
  res.json({ user: publicUser(user), stats, posts });
});

// --- posts ---

app.get('/api/posts', (req, res) => {
  res.json({ posts: db.prepare(postQuery('p.id < ?', req.user?.id)).all(beforeId(req)) });
});

app.get('/api/posts/:id', (req, res) => {
  const post = db.prepare(postQuery('p.id = ?', req.user?.id)).get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  res.json({ post });
});

app.post('/api/posts', requireAuth, (req, res) => {
  const body = clean(req.body.body, 1000);
  if (!body) return res.status(400).json({ error: 'Post cannot be empty.' });
  const { lastInsertRowid } = db.prepare('INSERT INTO posts (user_id, body) VALUES (?, ?)').run(req.user.id, body);
  res.json({ post: db.prepare(postQuery('p.id = ?', req.user.id)).get(lastInsertRowid) });
});

app.delete('/api/posts/:id', requireAuth, (req, res) => {
  const r = db.prepare('DELETE FROM posts WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!r.changes) return res.status(404).json({ error: 'Post not found.' });
  res.json({ ok: true });
});

app.post('/api/posts/:id/like', requireAuth, (req, res) => {
  const postId = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM posts WHERE id = ?').get(postId)) {
    return res.status(404).json({ error: 'Post not found.' });
  }
  const removed = db.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').run(req.user.id, postId);
  if (!removed.changes) db.prepare('INSERT INTO likes (user_id, post_id) VALUES (?, ?)').run(req.user.id, postId);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM likes WHERE post_id = ?').get(postId);
  res.json({ liked: !removed.changes, like_count: n });
});

// --- comments ---

app.get('/api/posts/:id/comments', (req, res) => {
  const comments = db.prepare(
    `SELECT c.id, c.body, c.created_at, u.username, u.display_name
     FROM comments c JOIN users u ON u.id = c.user_id
     WHERE c.post_id = ? ORDER BY c.id`
  ).all(req.params.id);
  res.json({ comments });
});

app.post('/api/posts/:id/comments', requireAuth, (req, res) => {
  const body = clean(req.body.body, 500);
  if (!body) return res.status(400).json({ error: 'Comment cannot be empty.' });
  if (!db.prepare('SELECT 1 FROM posts WHERE id = ?').get(req.params.id)) {
    return res.status(404).json({ error: 'Post not found.' });
  }
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO comments (post_id, user_id, body) VALUES (?, ?, ?)'
  ).run(req.params.id, req.user.id, body);
  const comment = db.prepare(
    `SELECT c.id, c.body, c.created_at, u.username, u.display_name
     FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?`
  ).get(lastInsertRowid);
  res.json({ comment });
});

app.delete('/api/comments/:id', requireAuth, (req, res) => {
  const r = db.prepare('DELETE FROM comments WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!r.changes) return res.status(404).json({ error: 'Comment not found.' });
  res.json({ ok: true });
});

// --- messaging ---

app.get('/api/conversations', requireAuth, (req, res) => {
  const me = req.user.id;
  const conversations = db.prepare(
    `WITH pairs AS (
       SELECT CASE WHEN sender_id = @me THEN recipient_id ELSE sender_id END AS other_id, MAX(id) AS last_id
       FROM messages WHERE sender_id = @me OR recipient_id = @me
       GROUP BY other_id
     )
     SELECT u.username, u.display_name, m.body AS last_body, m.created_at AS last_at,
            m.sender_id = @me AS last_from_me,
            (SELECT COUNT(*) FROM messages x WHERE x.sender_id = u.id AND x.recipient_id = @me AND x.read_at IS NULL) AS unread
     FROM pairs JOIN users u ON u.id = pairs.other_id JOIN messages m ON m.id = pairs.last_id
     ORDER BY pairs.last_id DESC`
  ).all({ me });
  res.json({ conversations });
});

app.get('/api/messages/:username', requireAuth, (req, res) => {
  const other = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!other) return res.status(404).json({ error: 'User not found.' });
  const after = parseInt(req.query.after, 10) || 0;
  const messages = db.prepare(
    `SELECT id, body, created_at, sender_id = @me AS mine FROM messages
     WHERE id > @after AND ((sender_id = @me AND recipient_id = @other) OR (sender_id = @other AND recipient_id = @me))
     ORDER BY id DESC LIMIT 200`
  ).all({ me: req.user.id, other: other.id, after }).reverse();
  db.prepare(
    "UPDATE messages SET read_at = datetime('now') WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL"
  ).run(other.id, req.user.id);
  res.json({ user: publicUser(other), messages });
});

app.post('/api/messages/:username', requireAuth, (req, res) => {
  const other = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!other) return res.status(404).json({ error: 'User not found.' });
  if (other.id === req.user.id) return res.status(400).json({ error: 'You cannot message yourself.' });
  const body = clean(req.body.body, 2000);
  if (!body) return res.status(400).json({ error: 'Message cannot be empty.' });
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO messages (sender_id, recipient_id, body) VALUES (?, ?, ?)'
  ).run(req.user.id, other.id, body);
  res.json({ message: { id: lastInsertRowid, body, created_at: new Date().toISOString(), mine: 1 } });
});

// Single-page app fallback
app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
}
module.exports = app;

const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const app = express();
app.use(express.json({ limit: '20kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR, {
  maxAge: '30d',
  immutable: true,
  setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
}));

const SESSION_COOKIE = 'sid';
const PAGE_SIZE = 18;
const STORY_HOURS = 24;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });

// --- helpers ---

function clean(str, max) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, max);
}

function publicUser(u) {
  return u && {
    id: u.id, username: u.username, display_name: u.display_name,
    bio: u.bio, avatar: u.avatar, created_at: u.created_at,
  };
}

// Identify the image by its first bytes, not by what the browser claims.
function imageExt(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.subarray(0, 4).toString() === 'GIF8') return 'gif';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}

function saveImage(file) {
  const ext = file && imageExt(file.buffer);
  if (!ext) return null;
  const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), file.buffer);
  return `/uploads/${name}`;
}

function removeImage(url) {
  if (!url || !url.startsWith('/uploads/')) return;
  fs.unlink(path.join(UPLOAD_DIR, path.basename(url)), () => {});
}

// Run multer and turn its errors into JSON responses.
function single(field) {
  return (req, res, next) => upload.single(field)(req, res, (err) => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Image must be under 8 MB.' : 'Upload failed.';
    res.status(400).json({ error: msg });
  });
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
    SELECT p.id, p.body, p.image, p.created_at,
           u.username, u.display_name, u.avatar,
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

function findUser(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

// --- auth ---

app.post('/api/register', (req, res) => {
  const username = clean(req.body.username, 30).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const display_name = clean(req.body.display_name, 50) || username;
  if (!/^[a-z0-9_.]{3,30}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-30 characters: letters, numbers, . or _' });
  }
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (findUser(username)) return res.status(409).json({ error: 'That username is taken.' });
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
  const user = findUser(username);
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

app.post('/api/me/avatar', requireAuth, single('image'), (req, res) => {
  const url = saveImage(req.file);
  if (!url) return res.status(400).json({ error: 'Please choose a JPG, PNG, WebP or GIF image.' });
  removeImage(req.user.avatar);
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(url, req.user.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});

// --- users / profiles / follows ---

app.get('/api/users', (req, res) => {
  const q = clean(req.query.q, 30).replace(/[%_\\]/g, '\\$&');
  const users = db.prepare(
    `SELECT * FROM users WHERE username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\'
     ORDER BY username LIMIT 20`
  ).all(`%${q}%`, `%${q}%`);
  res.json({ users: users.map(publicUser) });
});

// People the viewer does not follow yet, most followed first.
app.get('/api/suggestions', (req, res) => {
  const me = req.user?.id || 0;
  const users = db.prepare(
    `SELECT u.* FROM users u
     WHERE u.id != @me AND u.id NOT IN (SELECT followee_id FROM follows WHERE follower_id = @me)
     ORDER BY (SELECT COUNT(*) FROM follows f WHERE f.followee_id = u.id) DESC, u.id DESC
     LIMIT 10`
  ).all({ me });
  res.json({ users: users.map(publicUser) });
});

app.get('/api/users/:username', (req, res) => {
  const user = findUser(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const stats = db.prepare(
    `SELECT (SELECT COUNT(*) FROM posts WHERE user_id = @id) AS posts,
            (SELECT COUNT(*) FROM follows WHERE followee_id = @id) AS followers,
            (SELECT COUNT(*) FROM follows WHERE follower_id = @id) AS following`
  ).get({ id: user.id });
  const is_following = !!(req.user && db.prepare(
    'SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?'
  ).get(req.user.id, user.id));
  const has_story = !!db.prepare(
    `SELECT 1 FROM stories WHERE user_id = ? AND created_at > datetime('now', '-${STORY_HOURS} hours')`
  ).get(user.id);
  const posts = db.prepare(postQuery('p.user_id = ? AND p.id < ?', req.user?.id)).all(user.id, beforeId(req));
  res.json({ user: publicUser(user), stats, is_following, has_story, posts });
});

app.post('/api/users/:username/follow', requireAuth, (req, res) => {
  const user = findUser(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (user.id === req.user.id) return res.status(400).json({ error: 'You cannot follow yourself.' });
  const removed = db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(req.user.id, user.id);
  if (!removed.changes) db.prepare('INSERT INTO follows (follower_id, followee_id) VALUES (?, ?)').run(req.user.id, user.id);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?').get(user.id);
  res.json({ following: !removed.changes, followers: n });
});

app.get(['/api/users/:username/followers', '/api/users/:username/following'], (req, res) => {
  const user = findUser(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const [mine, theirs] = req.path.endsWith('/followers') ? ['followee_id', 'follower_id'] : ['follower_id', 'followee_id'];
  const users = db.prepare(
    `SELECT u.* FROM follows f JOIN users u ON u.id = f.${theirs}
     WHERE f.${mine} = ? ORDER BY f.created_at DESC LIMIT 200`
  ).all(user.id);
  res.json({ users: users.map(publicUser) });
});

// --- posts ---

// Home feed: you and the people you follow.
app.get('/api/feed', requireAuth, (req, res) => {
  const posts = db.prepare(postQuery(
    'p.id < @before AND (p.user_id = @me OR p.user_id IN (SELECT followee_id FROM follows WHERE follower_id = @me))',
    req.user.id,
  )).all({ me: req.user.id, before: beforeId(req) });
  res.json({ posts });
});

// Explore: everyone's posts.
app.get('/api/posts', (req, res) => {
  res.json({ posts: db.prepare(postQuery('p.id < ?', req.user?.id)).all(beforeId(req)) });
});

app.get('/api/posts/:id', (req, res) => {
  const post = db.prepare(postQuery('p.id = ?', req.user?.id)).get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  res.json({ post });
});

app.post('/api/posts', requireAuth, single('image'), (req, res) => {
  const body = clean(req.body.body, 2200);
  const image = saveImage(req.file);
  if (req.file && !image) return res.status(400).json({ error: 'Please choose a JPG, PNG, WebP or GIF image.' });
  if (!image && !body) return res.status(400).json({ error: 'Add a photo or write something.' });
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO posts (user_id, body, image) VALUES (?, ?, ?)'
  ).run(req.user.id, body, image);
  res.json({ post: db.prepare(postQuery('p.id = ?', req.user.id)).get(lastInsertRowid) });
});

app.delete('/api/posts/:id', requireAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  db.prepare('DELETE FROM posts WHERE id = ?').run(post.id);
  removeImage(post.image);
  res.json({ ok: true });
});

app.post('/api/posts/:id/like', requireAuth, (req, res) => {
  const postId = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM posts WHERE id = ?').get(postId)) {
    return res.status(404).json({ error: 'Post not found.' });
  }
  // like=true/false sets the state (double-tap only likes); no body toggles.
  const want = typeof req.body?.like === 'boolean' ? req.body.like : null;
  const has = !!db.prepare('SELECT 1 FROM likes WHERE user_id = ? AND post_id = ?').get(req.user.id, postId);
  const liked = want === null ? !has : want;
  if (liked && !has) db.prepare('INSERT INTO likes (user_id, post_id) VALUES (?, ?)').run(req.user.id, postId);
  if (!liked && has) db.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').run(req.user.id, postId);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM likes WHERE post_id = ?').get(postId);
  res.json({ liked, like_count: n });
});

// --- comments ---

const commentSelect = `
  SELECT c.id, c.body, c.created_at, u.username, u.display_name, u.avatar
  FROM comments c JOIN users u ON u.id = c.user_id`;

app.get('/api/posts/:id/comments', (req, res) => {
  res.json({ comments: db.prepare(`${commentSelect} WHERE c.post_id = ? ORDER BY c.id`).all(req.params.id) });
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
  res.json({ comment: db.prepare(`${commentSelect} WHERE c.id = ?`).get(lastInsertRowid) });
});

app.delete('/api/comments/:id', requireAuth, (req, res) => {
  const r = db.prepare('DELETE FROM comments WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!r.changes) return res.status(404).json({ error: 'Comment not found.' });
  res.json({ ok: true });
});

// --- stories ---

// Active stories from you and the people you follow, grouped by person; unseen first.
app.get('/api/stories', requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT s.id, s.image, s.created_at, u.id AS user_id, u.username, u.display_name, u.avatar,
            EXISTS (SELECT 1 FROM story_views v WHERE v.story_id = s.id AND v.user_id = @me) AS seen
     FROM stories s JOIN users u ON u.id = s.user_id
     WHERE s.created_at > datetime('now', '-${STORY_HOURS} hours')
       AND (s.user_id = @me OR s.user_id IN (SELECT followee_id FROM follows WHERE follower_id = @me))
     ORDER BY s.id`
  ).all({ me: req.user.id });
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.user_id)) {
      groups.set(r.user_id, { username: r.username, display_name: r.display_name, avatar: r.avatar, stories: [] });
    }
    groups.get(r.user_id).stories.push({ id: r.id, image: r.image, created_at: r.created_at, seen: !!r.seen });
  }
  const list = [...groups.values()].map((g) => ({ ...g, all_seen: g.stories.every((s) => s.seen) }));
  list.sort((a, b) => (a.username === req.user.username ? -1 : b.username === req.user.username ? 1 : a.all_seen - b.all_seen));
  res.json({ stories: list });
});

app.get('/api/users/:username/stories', (req, res) => {
  const user = findUser(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const stories = db.prepare(
    `SELECT id, image, created_at FROM stories
     WHERE user_id = ? AND created_at > datetime('now', '-${STORY_HOURS} hours') ORDER BY id`
  ).all(user.id);
  res.json({ user: publicUser(user), stories });
});

app.post('/api/stories', requireAuth, single('image'), (req, res) => {
  const image = saveImage(req.file);
  if (!image) return res.status(400).json({ error: 'Please choose a JPG, PNG, WebP or GIF image.' });
  const { lastInsertRowid } = db.prepare('INSERT INTO stories (user_id, image) VALUES (?, ?)').run(req.user.id, image);
  res.json({ story: { id: lastInsertRowid, image } });
});

app.post('/api/stories/:id/view', requireAuth, (req, res) => {
  db.prepare('INSERT OR IGNORE INTO story_views (user_id, story_id) SELECT ?, id FROM stories WHERE id = ?')
    .run(req.user.id, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/stories/:id', requireAuth, (req, res) => {
  const story = db.prepare('SELECT * FROM stories WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!story) return res.status(404).json({ error: 'Story not found.' });
  db.prepare('DELETE FROM stories WHERE id = ?').run(story.id);
  removeImage(story.image);
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
     SELECT u.username, u.display_name, u.avatar, m.body AS last_body, m.created_at AS last_at,
            m.sender_id = @me AS last_from_me,
            (SELECT COUNT(*) FROM messages x WHERE x.sender_id = u.id AND x.recipient_id = @me AND x.read_at IS NULL) AS unread
     FROM pairs JOIN users u ON u.id = pairs.other_id JOIN messages m ON m.id = pairs.last_id
     ORDER BY pairs.last_id DESC`
  ).all({ me });
  res.json({ conversations });
});

app.get('/api/messages/:username', requireAuth, (req, res) => {
  const other = findUser(req.params.username);
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
  const other = findUser(req.params.username);
  if (!other) return res.status(404).json({ error: 'User not found.' });
  if (other.id === req.user.id) return res.status(400).json({ error: 'You cannot message yourself.' });
  const body = clean(req.body.body, 2000);
  if (!body) return res.status(400).json({ error: 'Message cannot be empty.' });
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO messages (sender_id, recipient_id, body) VALUES (?, ?, ?)'
  ).run(req.user.id, other.id, body);
  res.json({ message: { id: lastInsertRowid, body, created_at: new Date().toISOString(), mine: 1 } });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// Single-page app fallback
app.get(/^(?!\/(api|uploads)\/).*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
}
module.exports = app;

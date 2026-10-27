// Kabar: single-page frontend. All user text goes through textContent, never innerHTML.

const state = { me: null, unread: 0 };
const app = document.getElementById('app');
let cleanup = null; // stops polling when leaving a page

// --- helpers ---

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2500);
}

function parseDate(s) {
  // SQLite gives "YYYY-MM-DD HH:MM:SS" in UTC
  return new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
}

function ago(s) {
  const sec = Math.max(0, (Date.now() - parseDate(s)) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return Math.floor(sec / 60) + 'm';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h';
  if (sec < 86400 * 7) return Math.floor(sec / 86400) + 'd';
  return parseDate(s).toLocaleDateString();
}

function avatar(user, cls = '') {
  let hash = 0;
  for (const ch of user.username) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return h('a', {
    href: `#/u/${user.username}`,
    class: `avatar ${cls}`,
    style: `background: hsl(${hash} 55% 45%)`,
    'aria-label': user.display_name,
  }, (user.display_name || user.username)[0]);
}

function needLogin() {
  if (state.me) return false;
  location.hash = '#/login';
  toast('Log in to do that.');
  return true;
}

// --- nav ---

function renderNav() {
  const nav = document.getElementById('nav');
  nav.replaceChildren();
  if (state.me) {
    nav.append(
      h('a', { href: '#/' }, 'Home'),
      h('a', { href: '#/messages' }, 'Messages', state.unread ? h('span', { class: 'badge' }, state.unread) : null),
      h('a', { href: `#/u/${state.me.username}` }, 'Profile'),
      h('button', { onclick: logout }, 'Log out'),
    );
  } else {
    nav.append(h('a', { href: '#/login' }, 'Log in'), h('a', { href: '#/register', class: 'btn' }, 'Sign up'));
  }
}

async function refreshMe() {
  const data = await api('/me');
  state.me = data.user;
  state.unread = data.unread;
  renderNav();
}

async function logout() {
  await api('/logout', { method: 'POST' });
  state.me = null;
  renderNav();
  location.hash = '#/';
}

// --- posts ---

function postCard(post, { showComments = false, onDelete } = {}) {
  const likeBtn = h('button', { class: post.liked ? 'liked' : '' });
  const setLike = () => { likeBtn.textContent = `${post.liked ? '♥' : '♡'} ${post.like_count}`; };
  setLike();
  likeBtn.addEventListener('click', async () => {
    if (needLogin()) return;
    const r = await api(`/posts/${post.id}/like`, { method: 'POST' });
    post.liked = r.liked;
    post.like_count = r.like_count;
    likeBtn.classList.toggle('liked', r.liked);
    setLike();
  });

  const commentCount = h('span', {}, post.comment_count);
  const commentsBox = h('div', { class: 'comments', hidden: !showComments });
  let commentsLoaded = false;
  const toggleComments = async () => {
    commentsBox.hidden = !commentsBox.hidden;
    if (!commentsBox.hidden && !commentsLoaded) {
      commentsLoaded = true;
      await loadComments(post, commentsBox, commentCount);
    }
  };

  const mine = state.me && state.me.username === post.username;
  const card = h('article', { class: 'card post' },
    avatar(post),
    h('div', { class: 'post-main' },
      h('div', { class: 'post-head' },
        h('a', { href: `#/u/${post.username}`, class: 'name' }, post.display_name),
        h('a', { href: `#/u/${post.username}`, class: 'muted' }, '@' + post.username),
        h('a', { href: `#/p/${post.id}`, class: 'muted' }, '· ' + ago(post.created_at)),
      ),
      h('div', { class: 'post-body' }, post.body),
      h('div', { class: 'actions' },
        likeBtn,
        h('button', { onclick: toggleComments }, '💬 ', commentCount),
        mine ? h('button', {
          onclick: async () => {
            if (!confirm('Delete this post?')) return;
            await api(`/posts/${post.id}`, { method: 'DELETE' });
            card.remove();
            onDelete && onDelete();
            toast('Post deleted.');
          },
        }, 'Delete') : null,
      ),
      commentsBox,
    ),
  );
  card.dataset.id = post.id;
  if (showComments) { commentsLoaded = true; loadComments(post, commentsBox, commentCount); }
  return card;
}

async function loadComments(post, box, countEl) {
  box.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  const { comments } = await api(`/posts/${post.id}/comments`);
  const list = h('div');
  const add = (c) => {
    const mine = state.me && state.me.username === c.username;
    const el = h('div', { class: 'comment' },
      avatar(c),
      h('div', {},
        h('div', { class: 'post-head' },
          h('a', { href: `#/u/${c.username}`, class: 'name' }, c.display_name),
          h('span', { class: 'muted' }, ago(c.created_at)),
          mine ? h('button', {
            class: 'muted', style: 'border:0;background:none;cursor:pointer',
            onclick: async () => {
              await api(`/comments/${c.id}`, { method: 'DELETE' });
              el.remove();
              countEl.textContent = Number(countEl.textContent) - 1;
            },
          }, 'Delete') : null,
        ),
        h('div', { class: 'comment-body' }, c.body),
      ),
    );
    list.append(el);
  };
  comments.forEach(add);

  let form = null;
  if (state.me) {
    const input = h('input', { placeholder: 'Write a comment…', maxlength: 500, 'aria-label': 'Comment' });
    form = h('form', {
      class: 'comment-form',
      onsubmit: async (e) => {
        e.preventDefault();
        const body = input.value.trim();
        if (!body) return;
        try {
          const { comment } = await api(`/posts/${post.id}/comments`, { method: 'POST', body: { body } });
          add(comment);
          input.value = '';
          countEl.textContent = Number(countEl.textContent) + 1;
        } catch (err) { toast(err.message); }
      },
    }, input, h('button', { class: 'btn' }, 'Reply'));
  } else {
    form = h('p', { class: 'muted' }, h('a', { href: '#/login' }, 'Log in'), ' to comment.');
  }
  box.replaceChildren(list, form);
}

function composer(onPosted) {
  const ta = h('textarea', { rows: 3, maxlength: 1000, placeholder: "What's happening?", 'aria-label': 'New post' });
  const count = h('span', { class: 'muted' }, '0/1000');
  const btn = h('button', { class: 'btn', disabled: true }, 'Post');
  ta.addEventListener('input', () => {
    count.textContent = `${ta.value.length}/1000`;
    btn.disabled = !ta.value.trim();
  });
  return h('form', {
    class: 'card',
    onsubmit: async (e) => {
      e.preventDefault();
      btn.disabled = true;
      try {
        const { post } = await api('/posts', { method: 'POST', body: { body: ta.value } });
        ta.value = '';
        count.textContent = '0/1000';
        onPosted(post);
      } catch (err) { toast(err.message); btn.disabled = false; }
    },
  }, ta, h('div', { class: 'row', style: 'margin-top:8px' }, count, btn));
}

// A list of posts with a "Load more" button.
function postList(initial, fetchMore) {
  const list = h('div');
  const more = h('button', { class: 'btn ghost more' }, 'Load more');
  const addAll = (posts) => {
    posts.forEach((p) => list.append(postCard(p)));
    more.hidden = posts.length < 20;
  };
  more.addEventListener('click', async () => {
    const last = list.lastElementChild;
    if (!last) return;
    addAll(await fetchMore(last.dataset.id));
  });
  addAll(initial);
  if (!initial.length) list.append(h('p', { class: 'muted center' }, 'No posts yet.'));
  return { el: h('div', {}, list, more), list };
}

// --- pages ---

async function feedPage() {
  const { posts } = await api('/posts');
  const { el, list } = postList(posts, async (before) => (await api(`/posts?before=${before}`)).posts);
  app.replaceChildren(
    state.me ? composer((p) => list.prepend(postCard(p))) :
      h('div', { class: 'card center' },
        h('p', {}, 'Welcome to Kabar. Share what you are up to.'),
        h('a', { href: '#/register', class: 'btn' }, 'Create an account')),
    el,
  );
}

async function postPage(id) {
  const { post } = await api(`/posts/${id}`);
  app.replaceChildren(
    h('p', {}, h('a', { href: '#/', class: 'muted' }, '← Back')),
    postCard(post, { showComments: true, onDelete: () => { location.hash = '#/'; } }),
  );
}

async function profilePage(username) {
  const data = await api(`/users/${encodeURIComponent(username)}`);
  const u = data.user;
  const mine = state.me && state.me.username === u.username;
  const { el, list } = postList(data.posts, async (before) =>
    (await api(`/users/${encodeURIComponent(username)}?before=${before}`)).posts);

  const head = h('section', { class: 'card' },
    h('div', { class: 'profile-head' },
      avatar(u, 'big'),
      h('div', { style: 'flex:1;min-width:0' },
        h('h1', {}, u.display_name),
        h('div', { class: 'muted' }, '@' + u.username),
      ),
      mine ? h('a', { href: '#/settings', class: 'btn ghost' }, 'Edit profile')
        : h('a', { href: `#/messages/${u.username}`, class: 'btn', onclick: (e) => { if (needLogin()) e.preventDefault(); } }, 'Message'),
    ),
    u.bio ? h('p', { class: 'bio' }, u.bio) : null,
    h('div', { class: 'muted' },
      `${data.stats.posts} posts · ${data.stats.likes_received} likes received · joined ${parseDate(u.created_at).toLocaleDateString()}`),
  );
  app.replaceChildren(head, mine ? composer((p) => list.prepend(postCard(p))) : '', el);
}

function settingsPage() {
  if (needLogin()) return;
  const name = h('input', { id: 'dn', value: state.me.display_name, maxlength: 50 });
  const bio = h('textarea', { id: 'bio', rows: 4, maxlength: 300 });
  bio.value = state.me.bio;
  const err = h('div', { class: 'error' });
  app.replaceChildren(h('form', {
    class: 'card',
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        const { user } = await api('/me', { method: 'PUT', body: { display_name: name.value, bio: bio.value } });
        state.me = user;
        toast('Profile saved.');
        location.hash = `#/u/${user.username}`;
      } catch (ex) { err.textContent = ex.message; }
    },
  },
  h('h2', {}, 'Edit profile'),
  h('div', { class: 'field' }, h('label', { for: 'dn' }, 'Display name'), name),
  h('div', { class: 'field' }, h('label', { for: 'bio' }, 'Bio'), bio),
  err,
  h('button', { class: 'btn' }, 'Save')));
}

function authPage(mode) {
  if (state.me) { location.hash = '#/'; return; }
  const isReg = mode === 'register';
  const username = h('input', { id: 'un', autocomplete: 'username', required: true });
  const display = h('input', { id: 'dn', maxlength: 50 });
  const password = h('input', { id: 'pw', type: 'password', autocomplete: isReg ? 'new-password' : 'current-password', required: true });
  const err = h('div', { class: 'error' });
  app.replaceChildren(h('form', {
    class: 'card',
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        await api(isReg ? '/register' : '/login', {
          method: 'POST',
          body: { username: username.value, password: password.value, display_name: display.value },
        });
        await refreshMe();
        location.hash = '#/';
      } catch (ex) { err.textContent = ex.message; }
    },
  },
  h('h2', {}, isReg ? 'Create your account' : 'Log in'),
  h('div', { class: 'field' }, h('label', { for: 'un' }, 'Username'), username),
  isReg ? h('div', { class: 'field' }, h('label', { for: 'dn' }, 'Display name'), display) : null,
  h('div', { class: 'field' }, h('label', { for: 'pw' }, 'Password'), password),
  err,
  h('div', { class: 'row' },
    h('button', { class: 'btn' }, isReg ? 'Sign up' : 'Log in'),
    isReg ? h('a', { href: '#/login', class: 'muted' }, 'Have an account? Log in')
      : h('a', { href: '#/register', class: 'muted' }, 'New here? Sign up'))));
  username.focus();
}

async function searchPage(q) {
  const { users } = await api(`/users?q=${encodeURIComponent(q)}`);
  app.replaceChildren(
    h('h2', {}, `People matching “${q}”`),
    users.length ? h('div', {}, users.map((u) => h('div', { class: 'card convo' },
      avatar(u),
      h('a', { href: `#/u/${u.username}`, style: 'text-decoration:none;min-width:0' },
        h('div', { style: 'font-weight:700' }, u.display_name),
        h('div', { class: 'muted' }, '@' + u.username))))) : h('p', { class: 'muted' }, 'Nobody found.'),
  );
}

async function inboxPage() {
  if (needLogin()) return;
  const render = async () => {
    const { conversations } = await api('/conversations');
    app.replaceChildren(
      h('h2', {}, 'Messages'),
      conversations.length ? h('div', {}, conversations.map((c) =>
        h('a', { href: `#/messages/${c.username}`, class: `card convo ${c.unread ? 'unread' : ''}` },
          avatar(c),
          h('div', { style: 'flex:1;min-width:0' },
            h('div', { class: 'row' },
              h('strong', {}, c.display_name),
              h('span', { class: 'muted' }, ago(c.last_at), c.unread ? h('span', { class: 'badge' }, c.unread) : null)),
            h('div', { class: 'preview' }, (c.last_from_me ? 'You: ' : '') + c.last_body)))))
        : h('p', { class: 'muted' }, 'No conversations yet. Open someone’s profile and tap Message.'),
    );
  };
  await render();
  const timer = setInterval(() => render().catch(() => {}), 5000);
  cleanup = () => clearInterval(timer);
}

async function chatPage(username) {
  if (needLogin()) return;
  const data = await api(`/messages/${encodeURIComponent(username)}`);
  const other = data.user;
  let lastId = 0;
  const log = h('div', { class: 'chat-log' });
  const addMsg = (m) => {
    if (m.id <= lastId) return;
    lastId = m.id;
    log.querySelector('.empty')?.remove();
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    log.append(h('div', { class: `bubble ${m.mine ? 'mine' : ''}` }, m.body, h('time', {}, ago(m.created_at))));
    if (atBottom || m.mine) log.scrollTop = log.scrollHeight;
  };

  const input = h('input', { placeholder: `Message ${other.display_name}`, maxlength: 2000, 'aria-label': 'Message' });
  const isSelf = state.me.username === other.username;
  app.replaceChildren(h('section', { class: 'chat' },
    h('div', { class: 'row card', style: 'margin-bottom:0' },
      h('a', { href: '#/messages', class: 'muted' }, '←'),
      avatar(other),
      h('a', { href: `#/u/${other.username}`, style: 'flex:1;text-decoration:none' },
        h('strong', {}, other.display_name), ' ', h('span', { class: 'muted' }, '@' + other.username))),
    log,
    isSelf ? h('p', { class: 'muted' }, 'You cannot message yourself.') :
      h('form', {
        class: 'chat-form',
        onsubmit: async (e) => {
          e.preventDefault();
          const body = input.value.trim();
          if (!body) return;
          input.value = '';
          try {
            const { message } = await api(`/messages/${encodeURIComponent(username)}`, { method: 'POST', body: { body } });
            addMsg(message);
          } catch (err) { toast(err.message); input.value = body; }
        },
      }, input, h('button', { class: 'btn' }, 'Send'))));

  data.messages.forEach(addMsg);
  if (!data.messages.length) log.append(h('p', { class: 'muted center empty' }, 'Say hello 👋'));
  log.scrollTop = log.scrollHeight;
  input.focus();

  const timer = setInterval(async () => {
    try {
      const r = await api(`/messages/${encodeURIComponent(username)}?after=${lastId}`);
      r.messages.forEach(addMsg);
    } catch { /* keep polling */ }
  }, 2500);
  cleanup = () => clearInterval(timer);
}

// --- router ---

async function route() {
  if (cleanup) { cleanup(); cleanup = null; }
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  window.scrollTo(0, 0);
  try {
    switch (parts[0]) {
      case '': await feedPage(); break;
      case 'login': authPage('login'); break;
      case 'register': authPage('register'); break;
      case 'settings': settingsPage(); break;
      case 'u': await profilePage(parts[1]); break;
      case 'p': await postPage(parts[1]); break;
      case 'search': await searchPage(parts[1] || ''); break;
      case 'messages': parts[1] ? await chatPage(parts[1]) : await inboxPage(); break;
      default: app.replaceChildren(h('p', { class: 'muted center' }, 'Page not found.'));
    }
  } catch (err) {
    app.replaceChildren(h('p', { class: 'muted center' }, err.message));
  }
  refreshMe().catch(() => {});
}

document.getElementById('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = document.getElementById('search-input').value.trim();
  if (q) location.hash = `#/search/${encodeURIComponent(q)}`;
});
window.addEventListener('hashchange', route);
setInterval(() => { if (state.me) refreshMe().catch(() => {}); }, 15000);
refreshMe().finally(route);

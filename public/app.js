// Kabar: single-page frontend. All user text goes through textContent, never innerHTML.

const state = { me: null, unread: 0 };
const app = document.getElementById('app');
const layer = document.getElementById('layer');
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

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  plus: '<rect x="3" y="3" width="18" height="18" rx="6"/><path d="M12 8v8M8 12h8"/>',
  add: '<path d="M12 5v14M5 12h14"/>',
  heart: '<path d="M12 20.3s-7.6-4.6-9.6-9.3C1 7.6 3.1 4 6.8 4c2.2 0 3.7 1.3 5.2 3.2C13.5 5.3 15 4 17.2 4c3.7 0 5.8 3.6 4.4 7-2 4.7-9.6 9.3-9.6 9.3z"/>',
  comment: '<path d="M20.5 11.5a8.5 8.5 0 0 1-12.4 7.6L3 20.5l1.5-4.7A8.5 8.5 0 1 1 20.5 11.5z"/>',
  send: '<path d="M21.5 3 10.5 13.5M21.5 3l-7 18-4-7.5-7.5-4z"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  logout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H3"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
};

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'i');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name]; // trusted constants only
  return svg;
}

async function api(path, { method = 'GET', body, form } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: form || (body ? JSON.stringify(body) : undefined),
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
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

function parseDate(s) {
  // SQLite gives "YYYY-MM-DD HH:MM:SS" in UTC
  return new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
}

function ago(s, long = false) {
  const sec = Math.max(0, (Date.now() - parseDate(s)) / 1000);
  const units = [[604800, 'w', ' weeks'], [86400, 'd', ' days'], [3600, 'h', ' hours'], [60, 'm', ' minutes']];
  if (sec < 60) return long ? 'Just now' : 'now';
  for (const [n, short, word] of units) {
    if (sec >= n) {
      const v = Math.floor(sec / n);
      return long ? `${v}${v === 1 ? word.replace(/s$/, '') : word} ago` : v + short;
    }
  }
}

function plural(n, word) { return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`; }

function hue(name) {
  let x = 0;
  for (const ch of name) x = (x * 31 + ch.charCodeAt(0)) % 360;
  return x;
}

// Circle avatar: photo if set, otherwise a gradient with the first letter.
function avatar(user, size = 36, { ring = null } = {}) {
  const k = hue(user.username);
  const el = h('span', {
    class: 'av',
    style: `--s:${size}px; background: linear-gradient(135deg, hsl(${k} 75% 62%), hsl(${(k + 50) % 360} 70% 48%))`,
  });
  if (user.avatar) el.append(h('img', { src: user.avatar, alt: '', loading: 'lazy' }));
  else el.textContent = (user.display_name || user.username)[0];
  if (ring === null) return el;
  return h('span', { class: `ring ${ring === 'seen' ? 'seen' : ''}` }, el);
}

function img(src, alt = '') {
  const el = h('img', { src, alt, loading: 'lazy', decoding: 'async' });
  const ready = () => el.classList.add('ready');
  el.addEventListener('load', ready);
  el.addEventListener('error', ready);
  if (el.complete && el.naturalWidth) ready();
  return el;
}

function needLogin() {
  if (state.me) return false;
  location.hash = '#/login';
  toast('Log in to continue');
  return true;
}

// Stagger the entrance of a page's sections.
function show(...children) {
  const page = h('div', { class: 'page' }, ...children);
  [...page.children].forEach((c, i) => c.style.setProperty('--i', i));
  app.replaceChildren(page);
  return page;
}

// Shrink big photos in the browser before upload (keeps GIFs as they are).
async function prepareImage(file, max = 1440) {
  if (file.type === 'image/gif' || !file.type.startsWith('image/')) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1.5e6) return file;
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((res) => c.toBlob((b) => res(b || file), 'image/jpeg', 0.88));
  } catch {
    return file;
  }
}

function pickFile(accept = 'image/*') {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept });
    input.addEventListener('change', () => resolve(input.files[0] || null));
    input.click();
  });
}

// --- sheets (bottom sheet on phones, centered panel on desktop) ---

function openSheet(title, body, { onClose } = {}) {
  const scrim = h('div', { class: 'scrim' });
  const sheet = h('section', { class: 'sheet glass', role: 'dialog', 'aria-label': title },
    h('div', { class: 'grabber' }),
    title ? h('div', { class: 'sheet-title' }, title) : null,
    body);
  const close = () => {
    if (!scrim.isConnected) return;
    scrim.classList.add('out');
    sheet.classList.add('out');
    setTimeout(() => { scrim.remove(); sheet.remove(); }, 300);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('hashchange', close);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    onClose && onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  scrim.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', close);

  // drag the grabber down to dismiss
  let startY = null;
  sheet.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.sheet-body, input, textarea, button')) return;
    startY = e.clientY;
    sheet.style.transition = 'none';
  });
  function onMove(e) {
    if (startY === null) return;
    const dy = Math.max(0, e.clientY - startY);
    sheet.style.transform = `translate(-50%, ${dy}px)`;
  }
  function onUp(e) {
    if (startY === null) return;
    const dy = e.clientY - startY;
    startY = null;
    sheet.style.transition = 'transform .4s var(--spring)';
    sheet.style.transform = '';
    if (dy > 90) { sheet.style.transition = ''; close(); }
  }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);

  layer.append(scrim, sheet);
  return close;
}

// --- chrome: top actions + floating tab bar ---

function renderChrome() {
  const top = document.getElementById('top-actions');
  top.replaceChildren();
  if (state.me) {
    top.append(
      h('a', { href: '#/messages', class: 'icon-btn', 'aria-label': 'Messages' },
        icon('send'), state.unread ? h('span', { class: 'dot' }, state.unread) : null),
    );
  } else {
    top.append(
      h('a', { href: '#/login', class: 'btn soft sm' }, 'Log in'),
      h('a', { href: '#/register', class: 'btn sm' }, 'Sign up'),
    );
  }

  const bar = document.getElementById('tabbar');
  const tabs = [
    ['#/', 'home', 'Home'],
    ['#/explore', 'search', 'Explore'],
    ['#/create', 'plus', 'Create'],
    ['#/messages', 'chat', 'Messages'],
  ];
  bar.replaceChildren(h('span', { class: 'lens' }));
  for (const [href, ic, label] of tabs) {
    bar.append(h('a', {
      href, 'aria-label': label, 'data-tab': href,
      onclick: href === '#/create' ? (e) => { e.preventDefault(); if (!needLogin()) openCreate(); } : null,
    }, icon(ic)));
  }
  const meHref = state.me ? `#/u/${state.me.username}` : '#/login';
  bar.append(h('a', { href: meHref, 'aria-label': 'Profile', 'data-tab': 'me' },
    state.me ? h('span', { class: 'me-pic' }, avatar(state.me, 28)) : icon('user')));
  markTab();
}

function markTab() {
  const hash = location.hash || '#/';
  let key = '#/';
  if (hash.startsWith('#/explore') || hash.startsWith('#/p/')) key = '#/explore';
  else if (hash.startsWith('#/messages')) key = '#/messages';
  else if ((state.me && hash === `#/u/${state.me.username}`) || hash.startsWith('#/settings')) key = 'me';
  else if (hash.startsWith('#/u/')) key = '#/explore';
  const bar = document.getElementById('tabbar');
  const lens = bar.querySelector('.lens');
  let active = null;
  bar.querySelectorAll('a').forEach((a) => {
    const on = a.dataset.tab === key;
    a.classList.toggle('on', on);
    if (on) active = a;
  });
  if (active && lens) {
    lens.style.opacity = 1;
    lens.style.transform = `translateX(${active.offsetLeft}px)`;
  }
}

async function refreshMe() {
  const data = await api('/me');
  const changed = JSON.stringify([state.me, state.unread]) !== JSON.stringify([data.user, data.unread]);
  state.me = data.user;
  state.unread = data.unread;
  if (changed) renderChrome();
}

async function logout() {
  await api('/logout', { method: 'POST' });
  state.me = null;
  renderChrome();
  location.hash = '#/';
}

// --- posts ---

function likeButton(post, countEl) {
  const btn = h('button', { class: `icon-btn like-btn ${post.liked ? 'on' : ''}`, 'aria-label': 'Like' }, icon('heart'));
  btn.setLike = async (want) => {
    if (needLogin()) return;
    const next = want ?? !post.liked;
    // optimistic update, then confirm with the server
    post.like_count += next === !!post.liked ? 0 : next ? 1 : -1;
    post.liked = next;
    paint();
    try {
      const r = await api(`/posts/${post.id}/like`, { method: 'POST', body: { like: next } });
      post.liked = r.liked;
      post.like_count = r.like_count;
      paint(false);
    } catch (err) { toast(err.message); }
  };
  function paint(bump = true) {
    btn.classList.toggle('on', !!post.liked);
    if (bump && post.liked) { btn.classList.remove('bump'); void btn.offsetWidth; btn.classList.add('bump'); }
    countEl.textContent = plural(post.like_count, 'like');
  }
  btn.addEventListener('click', () => btn.setLike());
  return btn;
}

function media(post) {
  if (!post.image) return h('div', { class: 'media' }, h('div', { class: 'textpost' }, post.body));
  return h('div', { class: 'media' }, img(post.image, post.body ? post.body.slice(0, 120) : 'Photo'));
}

function postCard(post, { onDelete } = {}) {
  const likesEl = h('div', { class: 'bold' });
  const likeBtn = likeButton(post, likesEl);
  likesEl.textContent = plural(post.like_count, 'like');
  const commentsLink = h('button', { class: 'linkish' });
  const paintComments = () => {
    commentsLink.textContent = post.comment_count ? `View ${post.comment_count === 1 ? '1 comment' : `all ${post.comment_count} comments`}` : 'Add a comment';
  };
  paintComments();
  const showComments = () => openComments(post, () => paintComments());
  commentsLink.addEventListener('click', showComments);

  const m = media(post);
  // double tap / double click to like, with a heart burst
  let lastTap = 0;
  m.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'mouse') return;
    const now = Date.now();
    if (now - lastTap < 300) burst();
    lastTap = now;
  });
  m.addEventListener('dblclick', burst);
  function burst() {
    if (needLogin()) return;
    const b = h('span', { class: 'burst' }, icon('heart'));
    m.append(b);
    setTimeout(() => b.remove(), 950);
    if (!post.liked) likeBtn.setLike(true);
  }

  const mine = state.me && state.me.username === post.username;
  const card = h('article', { class: 'post glass', 'data-id': post.id },
    h('div', { class: 'post-head row' },
      h('a', { href: `#/u/${post.username}` }, avatar(post, 34)),
      h('div', { class: 'grow' },
        h('a', { href: `#/u/${post.username}`, class: 'name' }, post.username),
        h('div', { class: 'muted small' }, post.display_name)),
      mine ? h('button', {
        class: 'icon-btn', 'aria-label': 'Delete post',
        onclick: async () => {
          if (!confirm('Delete this post?')) return;
          await api(`/posts/${post.id}`, { method: 'DELETE' });
          card.style.transition = 'opacity .35s, transform .35s';
          card.style.opacity = 0;
          card.style.transform = 'scale(.96)';
          setTimeout(() => card.remove(), 350);
          onDelete && onDelete();
          toast('Post deleted');
        },
      }, icon('trash')) : null),
    m,
    h('div', { class: 'post-actions row' },
      likeBtn,
      h('button', { class: 'icon-btn', 'aria-label': 'Comment', onclick: showComments }, icon('comment')),
      h('button', {
        class: 'icon-btn', 'aria-label': 'Share',
        onclick: async () => {
          const url = `${location.origin}/#/p/${post.id}`;
          try {
            if (navigator.share) await navigator.share({ url });
            else { await navigator.clipboard.writeText(url); toast('Link copied'); }
          } catch { /* share cancelled */ }
        },
      }, icon('send'))),
    h('div', { class: 'post-body' },
      likesEl,
      post.image && post.body ? h('div', { class: 'caption' },
        h('a', { href: `#/u/${post.username}`, class: 'bold' }, post.username), ' ', post.body) : null,
      commentsLink,
      h('div', { class: 'muted small', style: 'margin-top:4px' }, ago(post.created_at, true))),
  );
  return card;
}

async function openComments(post, onChange) {
  const list = h('div');
  const body = h('div', { class: 'sheet-body' }, list);
  const add = (c, i = 0) => {
    const mine = state.me && state.me.username === c.username;
    const el = h('div', { class: 'comment', style: `animation-delay:${i * 35}ms` },
      h('a', { href: `#/u/${c.username}` }, avatar(c, 32)),
      h('div', { class: 'grow' },
        h('div', {}, h('a', { href: `#/u/${c.username}`, class: 'bold' }, c.username), ' ',
          h('span', { class: 'muted small' }, ago(c.created_at))),
        h('div', { class: 'body' }, c.body)),
      mine ? h('button', {
        class: 'icon-btn', 'aria-label': 'Delete comment',
        onclick: async () => {
          await api(`/comments/${c.id}`, { method: 'DELETE' });
          el.remove();
          post.comment_count--;
          onChange();
        },
      }, icon('trash')) : null);
    list.append(el);
    return el;
  };

  let foot;
  if (state.me) {
    const input = h('input', { class: 'field', placeholder: 'Add a comment…', maxlength: 500, 'aria-label': 'Comment' });
    const send = h('button', { class: 'btn sm', disabled: true }, 'Post');
    input.addEventListener('input', () => { send.disabled = !input.value.trim(); });
    foot = h('form', {
      class: 'composer-row',
      onsubmit: async (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        send.disabled = true;
        try {
          const { comment } = await api(`/posts/${post.id}/comments`, { method: 'POST', body: { body: text } });
          list.querySelector('.empty')?.remove();
          add(comment).scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          input.value = '';
          post.comment_count++;
          onChange();
        } catch (err) { toast(err.message); send.disabled = false; }
      },
    }, avatar(state.me, 32), input, send);
  } else {
    foot = h('p', { class: 'center muted' }, h('a', { href: '#/login', class: 'bold' }, 'Log in'), ' to comment');
  }
  openSheet('Comments', h('div', { style: 'display:flex;flex-direction:column;min-height:0;flex:1' }, body, foot));
  foot.querySelector?.('input')?.focus();

  const { comments } = await api(`/posts/${post.id}/comments`);
  comments.forEach(add);
  if (!comments.length) list.append(h('p', { class: 'empty muted' }, 'No comments yet. Start the conversation.'));
}

// --- stories ---

function storiesTray(groups) {
  const tray = h('div', { class: 'stories glass' });
  const mineGroup = groups.find((g) => g.username === state.me.username);
  tray.append(h('button', {
    class: 'story',
    onclick: () => (mineGroup ? openStories(groups, groups.indexOf(mineGroup)) : openCreate('story')),
  },
  h('span', { style: 'position:relative' },
    avatar(state.me, 62, { ring: mineGroup ? (mineGroup.all_seen ? 'seen' : 'new') : 'seen' }),
    mineGroup ? null : h('span', { class: 'plus' }, icon('add'))),
  h('span', {}, 'Your story')));
  groups.forEach((g, i) => {
    if (g === mineGroup) return;
    tray.append(h('button', { class: 'story', onclick: () => openStories(groups, i) },
      avatar(g, 62, { ring: g.all_seen ? 'seen' : 'new' }),
      h('span', {}, g.username)));
  });
  return tray;
}

// Full-screen story player: tap right/left to move, hold to pause.
function openStories(groups, gi) {
  let si = groups[gi].stories.findIndex((s) => !s.seen);
  if (si < 0) si = 0;
  let timer = null;
  let start = 0;
  let elapsed = 0;
  const DURATION = 5000;

  const bgblur = h('div', { class: 'bgblur' });
  const frame = h('div', { class: 'frame' });
  const viewer = h('div', { class: 'viewer', role: 'dialog', 'aria-label': 'Stories' }, bgblur, frame);
  layer.append(viewer);

  const close = () => {
    cancelAnimationFrame(timer);
    viewer.classList.add('out');
    setTimeout(() => viewer.remove(), 280);
    document.removeEventListener('keydown', onKey);
    if ((location.hash || '#/') === '#/') route();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowRight') next();
    if (e.key === 'ArrowLeft') prev();
  };
  document.addEventListener('keydown', onKey);

  function next() {
    if (si < groups[gi].stories.length - 1) si++;
    else if (gi < groups.length - 1) { gi++; si = 0; }
    else return close();
    render();
  }
  function prev() {
    if (si > 0) si--;
    else if (gi > 0) { gi--; si = groups[gi].stories.length - 1; }
    render();
  }

  function render() {
    cancelAnimationFrame(timer);
    const g = groups[gi];
    const s = g.stories[si];
    s.seen = true;
    g.all_seen = g.stories.every((x) => x.seen);
    if (state.me) api(`/stories/${s.id}/view`, { method: 'POST' }).catch(() => {});
    bgblur.style.backgroundImage = `url("${encodeURI(s.image)}")`;
    const bars = g.stories.map((_, i) => h('div', { class: 'bar' }, h('i', { style: `width:${i < si ? 100 : 0}%` })));
    const mine = state.me && state.me.username === g.username;
    let paused = false;
    const tapL = h('div', { class: 'tap l', onclick: prev });
    const tapR = h('div', { class: 'tap r', onclick: next });
    for (const t of [tapL, tapR]) {
      t.addEventListener('pointerdown', () => { paused = true; });
      t.addEventListener('pointerup', () => { paused = false; });
      t.addEventListener('pointerleave', () => { paused = false; });
    }
    frame.replaceChildren(
      h('img', { src: s.image, alt: `Story by ${g.username}` }),
      h('div', { class: 'shade' }),
      h('div', { class: 'bars' }, bars),
      h('div', { class: 'vhead' },
        h('a', { href: `#/u/${g.username}`, onclick: close }, avatar(g, 34)),
        h('a', { href: `#/u/${g.username}`, onclick: close, class: 'bold' }, g.username),
        h('span', { style: 'opacity:.75' }, ago(s.created_at)),
        h('span', { class: 'grow' }),
        mine ? h('button', {
          class: 'icon-btn', 'aria-label': 'Delete story',
          onclick: async () => {
            if (!confirm('Delete this story?')) return;
            await api(`/stories/${s.id}`, { method: 'DELETE' });
            g.stories.splice(si, 1);
            if (!g.stories.length) { groups.splice(gi, 1); return close(); }
            si = Math.min(si, g.stories.length - 1);
            render();
          },
        }, icon('trash')) : null,
        h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, icon('close'))),
      tapL, tapR,
    );
    const fill = bars[si].firstChild;
    elapsed = 0;
    start = performance.now();
    const tick = (now) => {
      if (paused) start = now - elapsed;
      elapsed = now - start;
      fill.style.width = `${Math.min(100, (elapsed / DURATION) * 100)}%`;
      if (elapsed >= DURATION) return next();
      timer = requestAnimationFrame(tick);
    };
    timer = requestAnimationFrame(tick);
  }
  render();
}

async function openUserStory(username) {
  const { user, stories } = await api(`/users/${encodeURIComponent(username)}/stories`);
  if (stories.length) openStories([{ ...user, stories }], 0);
}

// --- create: post or story ---

function openCreate(mode = 'post') {
  let file = null;
  const seg = h('div', { class: 'segmented' }, h('span', { class: 'thumb' }));
  const tabPost = h('button', { type: 'button' }, 'Post');
  const tabStory = h('button', { type: 'button' }, 'Story');
  seg.append(tabPost, tabStory);

  const drop = h('button', { type: 'button', class: 'drop' });
  const caption = h('textarea', { class: 'field', rows: 3, maxlength: 2200, placeholder: 'Write a caption…', 'aria-label': 'Caption' });
  const share = h('button', { class: 'btn block', disabled: true }, 'Share');
  const err = h('div', { class: 'error' });

  const emptyDrop = () => drop.replaceChildren(h('div', {}, icon('image'),
    h('div', { class: 'bold', style: 'color:var(--ink)' }, 'Choose a photo'),
    h('div', { class: 'small' }, 'or drag it here')));
  const setMode = (m) => {
    mode = m;
    seg.classList.toggle('right', m === 'story');
    tabPost.classList.toggle('on', m === 'post');
    tabStory.classList.toggle('on', m === 'story');
    drop.classList.toggle('story-shape', m === 'story');
    caption.hidden = m === 'story';
    share.textContent = m === 'story' ? 'Share to story' : 'Share';
    validate();
  };
  const validate = () => { share.disabled = mode === 'story' ? !file : !file && !caption.value.trim(); };
  const useFile = async (f) => {
    if (!f || !f.type.startsWith('image/')) return;
    file = await prepareImage(f);
    const url = URL.createObjectURL(file);
    drop.replaceChildren(h('img', { src: url, alt: 'Preview' }));
    validate();
  };
  tabPost.addEventListener('click', () => setMode('post'));
  tabStory.addEventListener('click', () => setMode('story'));
  drop.addEventListener('click', async () => useFile(await pickFile()));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); useFile(e.dataTransfer.files[0]); });
  caption.addEventListener('input', validate);

  const form = h('form', {
    class: 'sheet-body stack',
    onsubmit: async (e) => {
      e.preventDefault();
      share.disabled = true;
      share.textContent = 'Sharing…';
      try {
        const fd = new FormData();
        if (file) fd.append('image', file, 'photo.jpg');
        if (mode === 'post') {
          fd.append('body', caption.value);
          const { post } = await api('/posts', { method: 'POST', form: fd });
          close();
          toast('Posted');
          if ((location.hash || '#/') === '#/') {
            const feed = document.querySelector('.feed');
            feed ? feed.prepend(postCard(post)) : route();
          } else location.hash = '#/';
        } else {
          await api('/stories', { method: 'POST', form: fd });
          close();
          toast('Added to your story');
          if ((location.hash || '#/') === '#/') route(); else location.hash = '#/';
        }
      } catch (ex) {
        err.textContent = ex.message;
        setMode(mode);
      }
    },
  }, seg, drop, caption, err, share);

  emptyDrop();
  const close = openSheet('New', form);
  setMode(mode);
}

// --- pages ---

function skeletons(n = 2) {
  show(...Array.from({ length: n }, () => h('div', { class: 'skeleton glass' })));
}

async function homePage() {
  if (!state.me) return welcomePage();
  skeletons();
  const [{ posts }, { stories }] = await Promise.all([api('/feed'), api('/stories')]);
  const feed = h('div', { class: 'feed' });
  posts.forEach((p) => feed.append(postCard(p)));
  const parts = [storiesTray(stories), feed];
  if (posts.length < 3) parts.push(await suggestionsCard());
  if (posts.length >= 18) parts.push(loadMore(feed, (b) => api(`/feed?before=${b}`)));
  show(...parts);
}

function loadMore(container, fetcher, render = postCard) {
  const btn = h('button', { class: 'btn soft', style: 'display:flex;margin:6px auto 20px' }, 'Load more');
  btn.addEventListener('click', async () => {
    const last = [...container.querySelectorAll('[data-id]')].pop();
    btn.disabled = true;
    const { posts } = await fetcher(last.dataset.id);
    posts.forEach((p) => container.append(render(p)));
    btn.disabled = false;
    if (posts.length < 18) btn.remove();
  });
  return btn;
}

async function suggestionsCard() {
  const { users } = await api('/suggestions');
  if (!users.length) {
    return h('div', { class: 'card glass empty' }, icon('camera'),
      h('h3', {}, 'Share your first photo'),
      h('p', { class: 'muted' }, 'Tap the + button below to post a photo or add to your story.'));
  }
  return h('section', { class: 'card glass' },
    h('div', { class: 'row between', style: 'margin-bottom:6px' },
      h('h3', {}, 'Suggested for you'), h('a', { href: '#/explore', class: 'small bold', style: 'color:var(--accent)' }, 'See all')),
    users.map((u) => personRow(u, true)));
}

function followButton(username, following, { onChange, small = true } = {}) {
  const btn = h('button', { class: `btn ${small ? 'sm' : ''}` });
  const paint = () => {
    btn.textContent = following ? 'Following' : 'Follow';
    btn.classList.toggle('soft', following);
  };
  paint();
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (needLogin()) return;
    following = !following;
    paint();
    try {
      const r = await api(`/users/${encodeURIComponent(username)}/follow`, { method: 'POST' });
      following = r.following;
      paint();
      onChange && onChange(r);
    } catch (err) { following = !following; paint(); toast(err.message); }
  });
  return btn;
}

function personRow(u, withFollow = false) {
  const mine = state.me && state.me.username === u.username;
  return h('a', { href: `#/u/${u.username}`, class: 'person' },
    avatar(u, 44),
    h('div', { class: 'grow' }, h('div', { class: 'bold ellipsis' }, u.username), h('div', { class: 'muted small ellipsis' }, u.display_name)),
    withFollow && !mine ? followButton(u.username, false) : null);
}

async function welcomePage() {
  const { posts } = await api('/posts');
  show(
    h('section', { class: 'card glass center', style: 'padding:30px 22px' },
      h('div', { class: 'logo', style: 'font-size:3rem;display:inline-block' }, 'Kabar'),
      h('p', { class: 'muted', style: 'margin:4px 0 18px' }, 'Share photos and moments with friends.'),
      h('div', { class: 'row', style: 'justify-content:center' },
        h('a', { href: '#/register', class: 'btn' }, 'Create account'),
        h('a', { href: '#/login', class: 'btn soft' }, 'Log in'))),
    posts.length ? grid(posts) : null,
  );
}

function grid(posts) {
  const g = h('div', { class: 'grid' });
  posts.forEach((p, i) => g.append(tile(p, i)));
  return g;
}

function tile(p, i = 0) {
  const heart = icon('heart');
  const bubble = icon('comment');
  return h('a', { href: `#/p/${p.id}`, class: 'tile', style: `--i:${i % 18}`, 'data-id': p.id },
    p.image ? img(p.image, p.body ? p.body.slice(0, 80) : 'Photo') : h('div', { class: 'textpost' }, p.body.slice(0, 120)),
    h('div', { class: 'stats' },
      h('span', { class: 'row', style: 'gap:4px' }, heart, p.like_count),
      h('span', { class: 'row', style: 'gap:4px' }, bubble, p.comment_count)));
}

async function explorePage() {
  const input = h('input', { class: 'field', type: 'search', placeholder: 'Search', 'aria-label': 'Search people', style: 'padding-left:44px' });
  const results = h('div', { class: 'card glass', hidden: true, style: 'padding:6px' });
  const searchBox = h('div', { style: 'position:relative;margin-bottom:14px' },
    h('span', { style: 'position:absolute;left:14px;top:12px;color:var(--muted)' }, icon('search')), input);
  let t;
  input.addEventListener('input', () => {
    clearTimeout(t);
    const q = input.value.trim();
    if (!q) { results.hidden = true; return; }
    t = setTimeout(async () => {
      const { users } = await api(`/users?q=${encodeURIComponent(q)}`);
      results.replaceChildren(...(users.length ? users.map((u) => personRow(u)) : [h('p', { class: 'muted center' }, 'No one found')]));
      results.hidden = false;
    }, 200);
  });

  const { posts } = await api('/posts');
  const g = grid(posts);
  show(
    searchBox,
    results,
    posts.length ? g : h('div', { class: 'card glass empty' }, icon('grid'), h('p', { class: 'muted' }, 'Nothing here yet.')),
    posts.length >= 18 ? loadMore(g, (b) => api(`/posts?before=${b}`), (p) => tile(p)) : null,
  );
}

async function postPage(id) {
  const { post } = await api(`/posts/${id}`);
  show(
    h('button', { class: 'btn soft sm', style: 'margin-bottom:12px', onclick: () => history.back() }, icon('back'), 'Back'),
    postCard(post, { onDelete: () => { location.hash = '#/'; } }),
  );
}

async function profilePage(username) {
  const data = await api(`/users/${encodeURIComponent(username)}`);
  const u = data.user;
  const mine = state.me && state.me.username === u.username;
  const followersEl = h('b', {}, data.stats.followers.toLocaleString());

  let pic = avatar(u, 88, data.has_story ? { ring: 'new' } : {});
  if (data.has_story) pic = h('button', { style: 'border:0;background:none;padding:0', 'aria-label': 'View story', onclick: () => openUserStory(u.username) }, pic);

  const head = h('section', { class: 'card glass' },
    h('div', { class: 'profile-top' },
      pic,
      h('div', { class: 'counts' },
        h('button', { onclick: () => window.scrollTo({ top: 300, behavior: 'smooth' }) }, h('b', {}, data.stats.posts.toLocaleString()), h('span', {}, 'posts')),
        h('button', { onclick: () => peopleSheet(u.username, 'followers') }, followersEl, h('span', {}, 'followers')),
        h('button', { onclick: () => peopleSheet(u.username, 'following') }, h('b', {}, data.stats.following.toLocaleString()), h('span', {}, 'following')))),
    h('div', { style: 'margin-top:12px' },
      h('div', { class: 'bold' }, u.display_name),
      h('div', { class: 'muted small' }, '@' + u.username),
      u.bio ? h('p', { class: 'bio' }, u.bio) : null),
    h('div', { class: 'profile-actions' },
      mine ? [
        h('a', { href: '#/settings', class: 'btn soft' }, 'Edit profile'),
        h('button', { class: 'btn soft', onclick: () => openCreate('story') }, 'Add story'),
        h('button', { class: 'btn soft', style: 'flex:0 0 auto;padding:0 12px', 'aria-label': 'Log out', onclick: logout }, icon('logout')),
      ] : [
        followButton(u.username, data.is_following, {
          small: false,
          onChange: (r) => { followersEl.textContent = r.followers.toLocaleString(); },
        }),
        h('a', { href: `#/messages/${u.username}`, class: 'btn soft', onclick: (e) => { if (needLogin()) e.preventDefault(); } }, 'Message'),
      ]),
  );

  const g = grid(data.posts);
  show(
    head,
    data.posts.length ? g : h('div', { class: 'card glass empty' }, icon('camera'),
      h('h3', {}, mine ? 'Share your first photo' : 'No posts yet'),
      mine ? h('p', {}, h('button', { class: 'btn', onclick: () => openCreate() }, 'Create a post')) : null),
    data.posts.length >= 18 ? loadMore(g, (b) => api(`/users/${encodeURIComponent(username)}?before=${b}`), (p) => tile(p)) : null,
  );
}

async function peopleSheet(username, list) {
  const body = h('div', { class: 'sheet-body' }, h('p', { class: 'muted center' }, 'Loading…'));
  openSheet(list === 'followers' ? 'Followers' : 'Following', body);
  const { users } = await api(`/users/${encodeURIComponent(username)}/${list}`);
  body.replaceChildren(...(users.length ? users.map((u) => personRow(u)) : [h('p', { class: 'muted center' }, 'Nobody yet.')]));
}

function settingsPage() {
  if (needLogin()) return;
  let picked = null;
  const preview = h('span', {}, avatar(state.me, 96));
  const name = h('input', { id: 'dn', class: 'field', value: state.me.display_name, maxlength: 50 });
  const bio = h('textarea', { id: 'bio', class: 'field', rows: 4, maxlength: 300 });
  bio.value = state.me.bio;
  const err = h('div', { class: 'error' });
  const save = h('button', { class: 'btn block' }, 'Save');
  show(
    h('a', { href: `#/u/${state.me.username}`, class: 'btn soft sm', style: 'margin-bottom:12px' }, icon('back'), 'Profile'),
    h('form', {
      class: 'card glass stack',
      onsubmit: async (e) => {
        e.preventDefault();
        save.disabled = true;
        try {
          if (picked) {
            const fd = new FormData();
            fd.append('image', picked, 'avatar.jpg');
            await api('/me/avatar', { method: 'POST', form: fd });
          }
          const { user } = await api('/me', { method: 'PUT', body: { display_name: name.value, bio: bio.value } });
          state.me = user;
          renderChrome();
          toast('Profile saved');
          location.hash = `#/u/${user.username}`;
        } catch (ex) { err.textContent = ex.message; save.disabled = false; }
      },
    },
    h('h2', {}, 'Edit profile'),
    h('div', { class: 'row', style: 'gap:16px' }, preview,
      h('button', {
        type: 'button', class: 'btn soft sm',
        onclick: async () => {
          const f = await pickFile();
          if (!f) return;
          picked = await prepareImage(f, 600);
          preview.replaceChildren(h('span', { class: 'av', style: '--s:96px' }, h('img', { src: URL.createObjectURL(picked), alt: '' })));
        },
      }, icon('camera'), 'Change photo')),
    h('div', {}, h('label', { class: 'label', for: 'dn' }, 'Name'), name),
    h('div', {}, h('label', { class: 'label', for: 'bio' }, 'Bio'), bio),
    err,
    save),
  );
}

function authPage(mode) {
  if (state.me) { location.hash = '#/'; return; }
  const isReg = mode === 'register';
  const username = h('input', { id: 'un', class: 'field', autocomplete: 'username', autocapitalize: 'none', required: true, placeholder: 'Username' });
  const display = h('input', { id: 'dn', class: 'field', maxlength: 50, placeholder: 'Full name' });
  const password = h('input', { id: 'pw', class: 'field', type: 'password', autocomplete: isReg ? 'new-password' : 'current-password', required: true, placeholder: 'Password' });
  const err = h('div', { class: 'error' });
  const submit = h('button', { class: 'btn block' }, isReg ? 'Sign up' : 'Log in');
  show(h('section', { class: 'auth card glass' },
    h('div', { class: 'logo' }, 'Kabar'),
    h('p', { class: 'muted', style: 'margin:0' }, isReg ? 'Sign up to see photos from your friends.' : 'Welcome back.'),
    h('form', {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        try {
          await api(isReg ? '/register' : '/login', {
            method: 'POST',
            body: { username: username.value, password: password.value, display_name: display.value },
          });
          await refreshMe();
          location.hash = isReg ? '#/explore' : '#/';
        } catch (ex) { err.textContent = ex.message; submit.disabled = false; }
      },
    },
    username, isReg ? display : null, password, err, submit),
    h('p', { class: 'small muted', style: 'margin:18px 0 0' },
      isReg ? 'Have an account? ' : "Don't have an account? ",
      h('a', { href: isReg ? '#/login' : '#/register', class: 'bold', style: 'color:var(--accent)' }, isReg ? 'Log in' : 'Sign up'))));
  username.focus();
}

async function inboxPage() {
  if (needLogin()) return;
  const render = async (first) => {
    const { conversations } = await api('/conversations');
    const body = conversations.length
      ? h('section', { class: 'card glass', style: 'padding:6px' }, conversations.map((c) =>
        h('a', { href: `#/messages/${c.username}`, class: `convo ${c.unread ? 'unread' : ''}` },
          avatar(c, 52),
          h('div', { class: 'grow' },
            h('div', { class: 'bold' }, c.username),
            h('div', { class: 'preview muted small ellipsis' }, (c.last_from_me ? 'You: ' : '') + c.last_body, ' · ', ago(c.last_at))),
          c.unread ? h('span', { class: 'dot', style: 'position:static' }, c.unread) : null)))
      : h('div', { class: 'card glass empty' }, icon('send'), h('h3', {}, 'Your messages'),
        h('p', { class: 'muted' }, 'Open someone’s profile and tap Message to start a chat.'));
    if (first) show(h('h2', { style: 'margin:4px 6px 12px' }, 'Messages'), body);
    else app.querySelector('.page').lastChild.replaceWith(body);
  };
  await render(true);
  const timer = setInterval(() => render(false).catch(() => {}), 5000);
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
    log.querySelector('.hello')?.remove();
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    log.append(h('div', { class: `bubble ${m.mine ? 'mine' : ''}`, title: ago(m.created_at, true) }, m.body));
    if (atBottom || m.mine) log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' });
  };

  const input = h('input', { class: 'field', placeholder: 'Message…', maxlength: 2000, 'aria-label': 'Message' });
  const sendBtn = h('button', { class: 'btn sm', disabled: true }, 'Send');
  input.addEventListener('input', () => { sendBtn.disabled = !input.value.trim(); });
  const isSelf = state.me.username === other.username;
  show(h('section', { class: 'chat card glass' },
    h('div', { class: 'chat-head row' },
      h('a', { href: '#/messages', class: 'icon-btn', 'aria-label': 'Back' }, icon('back')),
      h('a', { href: `#/u/${other.username}`, class: 'row grow' }, avatar(other, 38),
        h('div', {}, h('div', { class: 'bold' }, other.display_name), h('div', { class: 'muted small' }, '@' + other.username)))),
    log,
    isSelf ? h('p', { class: 'muted center' }, 'You cannot message yourself.') :
      h('form', {
        class: 'composer-row',
        onsubmit: async (e) => {
          e.preventDefault();
          const body = input.value.trim();
          if (!body) return;
          input.value = '';
          sendBtn.disabled = true;
          try {
            const { message } = await api(`/messages/${encodeURIComponent(username)}`, { method: 'POST', body: { body } });
            addMsg(message);
          } catch (err) { toast(err.message); input.value = body; }
        },
      }, input, sendBtn)));

  data.messages.forEach(addMsg);
  if (!data.messages.length) {
    log.append(h('div', { class: 'hello center', style: 'margin:auto' }, avatar(other, 80), h('p', { class: 'bold' }, other.display_name),
      h('p', { class: 'muted small' }, 'Say hi to start the conversation.')));
    log.querySelector('.hello .av').style.margin = '0 auto';
  }
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
  window.scrollTo({ top: 0 });
  markTab();
  try {
    switch (parts[0]) {
      case '': await homePage(); break;
      case 'explore': await explorePage(); break;
      case 'create': if (!needLogin()) { await homePage(); openCreate(); } break;
      case 'login': authPage('login'); break;
      case 'register': authPage('register'); break;
      case 'settings': settingsPage(); break;
      case 'u': await profilePage(parts[1]); break;
      case 'p': await postPage(parts[1]); break;
      case 'messages': parts[1] ? await chatPage(parts[1]) : await inboxPage(); break;
      default: show(h('div', { class: 'card glass empty' }, h('h3', {}, 'Page not found')));
    }
  } catch (err) {
    show(h('div', { class: 'card glass empty' }, h('p', { class: 'muted' }, err.message)));
  }
}

window.addEventListener('hashchange', route);
window.addEventListener('resize', markTab);
setInterval(() => { if (state.me) refreshMe().catch(() => {}); }, 15000);
refreshMe().catch(() => {}).finally(() => { renderChrome(); route(); });

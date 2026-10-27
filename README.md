# Kabar

A small public social network: sign up, edit your profile, post, like, comment, and send direct messages.

**Stack:** Node.js + Express, SQLite (better-sqlite3), plain HTML/CSS/JS frontend. No build step.

## Run it

```bash
npm install
npm start          # http://localhost:3000
```

Data is stored in `data.db` next to `server.js` (override with `DB_PATH`). Set `PORT` to change the port and `NODE_ENV=production` to make the login cookie HTTPS-only.

## Features

- Accounts with hashed passwords (bcrypt) and cookie sessions
- Profiles with display name, bio, post and like counts
- Public feed with "Load more" pagination; anyone can read, members can post
- Likes (toggle) and comments; delete your own posts and comments
- One-to-one messaging with an inbox, unread badges, and live updates (polling every few seconds)
- People search
- Light and dark mode, works on phones

## Layout

- `server.js`: JSON API under `/api`
- `db.js`: SQLite schema
- `public/`: the single-page frontend

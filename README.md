# Kabar

A small Instagram-style social network with an Apple "Liquid Glass" look: frosted, translucent panels over a slowly moving color background, with spring animations throughout.

**Stack:** Node.js + Express, SQLite (better-sqlite3), multer for uploads, plain HTML/CSS/JS frontend. No build step.

## Run it

```bash
npm install
npm start          # http://localhost:3000
```

Settings (all optional):

- `PORT`: port to listen on (default 3000)
- `DB_PATH`: SQLite file (default `data.db` next to `server.js`)
- `UPLOAD_DIR`: where photos are saved (default `uploads/`)
- `NODE_ENV=production`: makes the login cookie HTTPS-only

Databases from the first version are upgraded automatically on start.

## Features

- **Photo posts** with captions; photos are resized in the browser before upload (max 1440px)
- **Home feed** of you and the people you follow, with **double-tap to like** and a heart burst
- **Stories** that last 24 hours: gradient rings for unseen stories, a full-screen player with progress bars, tap to skip, hold to pause
- **Follow / followers / following**, with follower and following lists in a sheet
- **Explore**: a grid of everyone's posts plus live people search
- **Profiles**: profile photo, bio, counts, and a 3-column photo grid
- **Comments** in a slide-up sheet (drag down or press Esc to close)
- **Direct messages** with an inbox, unread badges and live updates
- Floating glass tab bar with a sliding "lens", light and dark mode, works on phones; respects "reduce motion"

## Layout

- `server.js`: JSON API under `/api`, uploaded files under `/uploads`
- `db.js`: SQLite schema and upgrades
- `public/`: the single-page frontend (`app.js`, `style.css`, `index.html`)

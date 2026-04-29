# Steam Review Feed

**English** | [한국어](README.md)

A service that aggregates the latest reviews from your Steam Wishlist and Library games into a single feed.

## Screenshots

| Home | Review Feed |
|------|-------------|
| ![Home](docs/screenshots/home.png) | ![Review Feed](docs/screenshots/feed.png) |

## Key Features

- **Unified Review Feed** — View the latest reviews from Wishlist & Library games in one place
- **Steam Login** — Steam OpenID authentication or direct Steam ID input
- **SSE Progressive Loading** — Reviews collected in parallel and streamed in real-time
- **Rich Filters** — Language, date range, playtime, review length, positive/negative, exclude free games
- **Game Search** — Search games by name and browse reviews without logging in
- **Per-Game Reviews** — Detailed review pages for individual games
- **Media Gallery** — Hover over game names for video/screenshot popups with prev/next navigation; full media gallery on game pages
- **Light/Dark Theme** — Auto-detects system preference + manual toggle (light/dark/system)

## Tech Stack

| Area | Technology |
|------|------------|
| Framework | Next.js 16 (App Router, TypeScript) |
| Styling | Tailwind CSS 4 (class-based dark mode) |
| DB | SQLite (better-sqlite3) — user/game list persistence |
| Session | iron-session (signed cookies) |
| Cache | lru-cache (in-memory) |
| Auth | Steam OpenID |
| Video | hls.js (HLS streaming) |
| Testing | Vitest (77 tests) |
| Deployment | Docker + GitLab CI/CD |

## Project Structure

```
├── app/
│   ├── api/           # API routes (auth, cache, reviews, search, wishlist, library, media)
│   ├── feed/          # Unified review feed page
│   ├── game/[appId]/  # Per-game review page
│   ├── privacy/       # Privacy policy
│   ├── layout.tsx     # Root layout (ThemeProvider, FOUC prevention)
│   └── page.tsx       # Home (login/search)
├── components/        # React components (ThemeProvider, MediaPlayer, ReviewCard, etc.)
├── lib/
│   ├── constants.ts   # Shared constants (PAGE_SIZE, RATE_LIMIT, etc.)
│   ├── env.ts         # Environment variable validation
│   ├── init.ts        # Server initialization (env validation + DB scheduler)
│   ├── cache.ts       # In-memory TTL + LRU cache
│   ├── db.ts          # SQLite DB initialization and queries
│   ├── logger.ts      # JSONL event logging
│   ├── rate-limit.ts  # Per-user rate limiting
│   ├── session.ts     # iron-session management
│   └── steam/         # Steam API client, types, sorting, filters
├── __tests__/         # Unit tests (11 files, 77 tests)
├── middleware.ts       # Auth middleware (Edge Runtime)
├── Dockerfile
├── docker-compose.yml
├── .gitlab-ci.yml     # GitLab CI/CD pipeline
└── nginx.conf
```

## Getting Started

### Prerequisites

- **Node.js 20+** ([Official download](https://nodejs.org/en/download))
  - On Windows, running `setup.bat` will offer to install Node.js automatically via winget if it is missing
  - Direct winget install: `winget install OpenJS.NodeJS.LTS`
- Steam Web API Key ([Get one here](https://steamcommunity.com/dev/apikey))

### 1. Environment Variables

Create a `.env.local` file in the project root:

```env
STEAM_API_KEY=your_api_key
SESSION_SECRET=random_string_at_least_32_chars
NEXT_PUBLIC_BASE_URL=http://localhost:3000
```

> `STEAM_API_KEY` and `SESSION_SECRET` are required. A warning will be displayed on server start if missing.

### 2. Install & Run

#### On Windows — Batch files (recommended)

Just **double-click** the `.bat` files in the project root. Each script auto-checks prerequisites (`node_modules`, `.env.local`, standalone build).

| File | Action |
|------|--------|
| `setup.bat` | `npm install` + auto-generates `.env.local` (32-byte random SESSION_SECRET) |
| `dev.bat` | Dev server (`npm run dev`) |
| `build.bat` | Production build (`npm run build`) |
| `start.bat` | Standalone server (`npm run start:standalone`) |

On first run, execute `setup.bat`, then fill in `STEAM_API_KEY` in the generated `.env.local` — that's it.

#### Manual (npm)

```bash
# Install dependencies
npm install

# Dev server
npm run dev

# Run tests
npm test

# Production build (standalone + static files auto-copied)
npm run build

# Production server
npm run start:standalone
```

> **Note:** `start:standalone` auto-loads `.env.local` via `--env-file`. In standalone mode, Next.js does not read `.env.local` on its own.

Open http://localhost:3000 in your browser.

### 3. Docker Deployment

```bash
# Create .env file (docker-compose auto-loads it)
cp .env.local .env

# Build and run
docker-compose up --build
```

SQLite DB is stored in the `data/` volume.
To enable the Nginx reverse proxy, uncomment the nginx service in `docker-compose.yml`.

### 4. GitLab CI/CD

A `.gitlab-ci.yml` is included. Register these variables in GitLab > Settings > CI/CD > Variables:

| Variable | Description |
|----------|-------------|
| `SSH_PRIVATE_KEY` | Deploy server SSH key |
| `SSH_KNOWN_HOSTS` | Deploy server known_hosts |
| `SSH_USER` / `SSH_HOST` | Deploy server access |
| `STEAM_API_KEY` | Steam API key |
| `SESSION_SECRET` | Session encryption key |
| `NEXT_PUBLIC_BASE_URL` | Service URL |

Pipeline: `develop`/`main` push -> Docker image build -> GitLab Registry push -> Manual deploy

## npm Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Dev server (HMR, auto-loads .env.local) |
| `npm run build` | Production build + copy static files to standalone |
| `npm run start` | next start (dev production server) |
| `npm run start:standalone` | Standalone server (auto-loads .env.local) |
| `npm run lint` | ESLint check |
| `npm test` | Run Vitest tests |

## Troubleshooting

### PowerShell security error when running `npm` on Windows

```
npm : File ... cannot be loaded because running scripts is disabled...
+ CategoryInfo : SecurityError: (:) [], PSSecurityException
```

**Option 1 — Change execution policy (Admin PowerShell, permanent)**
```powershell
Set-ExecutionPolicy RemoteSigned
```

**Option 2 — Allow for current session only**
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned
```

**Option 3 — Use cmd instead**
```
cmd
npm install
```

### CSS not loading in standalone mode

`npm run build` automatically copies static files via the `postbuild` script.
If you built manually, copy static files yourself:

```bash
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public
```

### Environment variable errors in standalone mode

Standalone mode does not auto-load `.env.local`:

```bash
# Correct way to run
node --env-file .env.local .next/standalone/server.js

# Or use npm script
npm run start:standalone
```

## License

[MIT](LICENSE)

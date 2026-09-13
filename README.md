# Bear-Net Poker

Self-hosted **No-Limit Texas Hold'em** for you and your friends, in the browser, behind Cloudflare Access.

- Up to **10 seats**, humans + bots (skill levels 1–5, funny gamertag names)
- **Lobby / start screen** where the admin sets table rules and starts, pauses, and ends the game
- **Player profiles** keyed by the Google account Cloudflare Access verified: display name + avatar (emoji or uploaded picture) persist across sessions
- **Rebuys** for busted players (same starting stack) with a `×N` buy-in marker on the seat
- **Dark/light mode** (per player) and **six table themes** (felt, nature, city, retro, space, ocean); a player's theme pick is queued and switches for everyone when their turn comes up
- **Side pots**, blinds schedule, action timer with auto check/fold, chat and hand log
- Desktop first, but works on a phone
- **Zero npm dependencies** — Node built-ins only (HTTP, Server-Sent Events, `node:sqlite`, `crypto`). Nothing to audit, tiny image.

Image: `ghcr.io/jchebert1/poker` — built by GitHub Actions on every push to `main`.

---

## 1. Layout of this repo

```
server/            Node server (no deps)
  index.js         HTTP + SSE + REST actions, static files
  auth.js          Cloudflare Access JWT verification (or dev mode)
  db.js            SQLite: profiles + persisted table settings
  engine/          Poker engine: cards/evaluator, table state machine, bots
public/            Browser client (vanilla JS/CSS)
test/              sim.js (bot-only engine test), auth.test.js, e2e.js (Playwright, optional)
Dockerfile, docker-compose.yml (Portainer stack), docker-compose.dev.yml (LAN testing)
.github/workflows/docker.yml   builds + pushes to GHCR
```

## 2. Push the code to GitHub

From this folder (Windows PowerShell or Git Bash):

```bash
git init -b main
git add .
git commit -m "Bear-Net Poker: initial import"
git remote add origin https://github.com/jchebert1/poker.git
git push -u origin main
```

The **Actions** tab will build the image. First build takes ~5 minutes (multi-arch); later builds are cached.

### Make the image pullable by Portainer

GHCR packages are **private by default**. Pick one:

- **Simplest:** GitHub → your profile → *Packages* → `poker` → *Package settings* → *Change visibility* → **Public**. (The code can stay private; only the image becomes public. There are no secrets in the image.)
- **Or keep it private:** create a classic PAT with `read:packages`, then in Portainer add a registry (*Registries → Add → Custom*, URL `ghcr.io`, username = your GitHub username, password = the PAT) and select it when deploying the stack.

Docs: <https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry>

## 3. Cloudflare setup (Tunnel + Zero Trust Access)

Everything below is in the Cloudflare dashboard. Vendor docs are linked for each step; they're the source of truth if the UI has moved.

### 3a. Google as a login method
Zero Trust → **Settings → Authentication → Login methods → Add new → Google**.
You'll create an OAuth client in Google Cloud Console and paste its Client ID / Secret.
Docs: <https://developers.cloudflare.com/cloudflare-one/identity/idp-integration/google/>

Note your **team domain** (Settings → Custom Pages → *Team domain*), e.g. `bearnet.cloudflareaccess.com`. That's `CF_TEAM_DOMAIN`.

### 3b. Create the tunnel
Zero Trust → **Networks → Tunnels → Create a tunnel → Cloudflared**. Name it (e.g. `poker`). On the *Install connector* step, copy the **token** from the docker command (the long string after `--token`). That's `CF_TUNNEL_TOKEN`. You don't need to run their command; the Portainer stack runs cloudflared for you.
Docs: <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/>

### 3c. Public hostname → the container
In the tunnel → **Public Hostname → Add a public hostname**:
- Subdomain `poker`, Domain `bear-net.com`
- Service: Type **HTTP**, URL **`poker:3000`** (the container name on the stack network)

Cloudflare creates the DNS record for `poker.bear-net.com` automatically.

### 3d. The Access application (the Gmail allowlist)
Zero Trust → **Access → Applications → Add an application → Self-hosted**:
- Application name: `Poker`; Session duration: e.g. `1 week`
- Application domain: `poker.bear-net.com`
- Identity providers: only **Google** (untick others so nobody can use a one-time PIN)
- **Policy**: name `Friends`, action **Allow**, *Include* → selector **Emails** → paste the Gmail addresses, one per line. Add/remove friends here any time; no redeploy needed.

After saving, open the app's **Overview** tab and copy the **Application Audience (AUD) Tag**. That's `CF_POLICY_AUD`.
Docs: <https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/> and <https://developers.cloudflare.com/cloudflare-one/policies/access/>

The server validates every request's `Cf-Access-Jwt-Assertion` JWT against your team's public keys (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`), checking signature, expiry, audience and issuer, per <https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/>. The verified email is the player's identity, so profiles stick to the Google account.

## 4. Deploy in Portainer

Portainer → **Stacks → Add stack** → name `poker`:

- **Build method:** *Repository* → URL `https://github.com/jchebert1/poker`, reference `refs/heads/main`, compose path `docker-compose.yml` (needs repo access if private — alternatively choose *Web editor* and paste `docker-compose.yml`).
- **Environment variables** (Advanced mode lets you paste `.env` format):

```
CF_TUNNEL_TOKEN=<from 3b>
CF_TEAM_DOMAIN=<your team>.cloudflareaccess.com
CF_POLICY_AUD=<from 3d>
ADMIN_EMAILS=jchebert1@gmail.com
```

- Deploy. Within ~30 s the tunnel shows **Healthy** in Zero Trust → Networks → Tunnels, and <https://poker.bear-net.com> prompts for Google login.

The stack publishes **no ports** on the host: the only path to the app is through the tunnel, so Cloudflare Access can't be bypassed from the internet. Profiles and settings live in the `poker-data` volume.

**Updating:** push to `main` → Actions rebuilds `:latest` → in Portainer open the stack → *Pull and redeploy* (or enable *Re-pull image* on update). Portainer's "Stacks → webhook" can automate this if you want.

## 5. Playing

1. **You (admin)** open the site, sign in with Google, click the avatar (top right) to set your name/picture.
2. In the **lobby**: set table settings (stack, blinds, timer, rebuys, blinds increase, theme…) → *Save settings*. Click *Sit down*. Add bots with a skill level. Friends who open the site click *Sit down* too. Then **▶ Start game**.
3. In the game: act with Fold / Check / Call / Raise (presets: min, ½ pot, pot, max) / All-in. Timer runs out → auto check or fold. The 🎨 button queues a theme change for your next turn; 🌙/☀️ toggles dark/light just for you. 💬 Log opens the hand log, chat and player list (admin can kick / change bot levels there).
4. Busted? The **Rebuy** bar appears; you're back in next hand with a `×2` marker. Bots auto-rebuy if enabled.
5. Admin controls at the bottom: **+ Bot**, **⏸ Pause** (after the current hand), **■ End game** (returns bets of an unfinished hand, shows the results table in the lobby). Late-comers can *Join table* mid-game; they're dealt in next hand.

Bot levels: 1 Fish (random, calls everything) · 2 Casual · 3 Regular (Monte-Carlo equity + pot odds) · 4 Shark (position, semi-bluffs) · 5 Pro. In simulation the levels finish in strict 1 < 2 < 3 < 4 < 5 order.

## 6. Local / LAN testing without Cloudflare

```bash
docker compose -f docker-compose.dev.yml up --build
# or, with Node 22.13+ installed:
AUTH_MODE=dev ADMIN_EMAILS=jchebert1@gmail.com npm start
```

Open `http://localhost:3000`; a dev login page asks for any email-like id (addresses in `ADMIN_EMAILS` get admin). Open a second browser/incognito window as a "friend". **Never expose `AUTH_MODE=dev` to the internet.**

Tests: `npm test` (JWT verification + a few thousand simulated bot hands checking chip conservation), `npm run test:skill` (bot level ranking), `npm run test:e2e` (full browser run; needs `playwright` installed globally or locally).

## 7. Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `AUTH_MODE` | `cloudflare` | `cloudflare` verifies Access JWTs; `dev` uses a cookie login page (LAN only) |
| `CF_TEAM_DOMAIN` | — | e.g. `bearnet.cloudflareaccess.com` (required in cloudflare mode) |
| `CF_POLICY_AUD` | — | Access application AUD tag (required in cloudflare mode) |
| `ADMIN_EMAILS` | — | comma-separated emails with admin powers |
| `PORT` | `3000` | listen port |
| `DATA_DIR` | `/data` | SQLite location (mount a volume) |

## 8. Notes / limits

- One table per server instance (that's the use case). Table settings persist; a game in progress does not survive a container restart (players just go back to the lobby).
- Cloudflare Access sessions last as long as you set in the app (default 24 h); the game keeps you connected via Server-Sent Events with automatic reconnect.
- Avatars uploaded by players are resized in the browser to 96×96 and stored in SQLite (~10 KB each).

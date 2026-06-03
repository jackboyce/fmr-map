# FMR Map

An interactive choropleth map for exploring **HUD Fair Market Rents** across the United States — built for housing researchers, voucher administrators, landlords, and anyone who needs to understand the geographic distribution of Section 8 rent limits.

![Status](https://img.shields.io/badge/status-active-brightgreen) ![Node.js](https://img.shields.io/badge/node-20%2B-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue)

---

## What are Fair Market Rents?

Fair Market Rents (FMRs) are rent estimates published annually by the U.S. Department of Housing and Urban Development (HUD). They represent the **40th percentile gross rent** for standard quality rental units in a given area — meaning 40% of recently-moved renters in that area pay at or below the FMR.

FMRs are used to:
- Set **Section 8 Housing Choice Voucher** payment standards — the maximum rent HUD will subsidize
- Determine eligibility for other HUD assistance programs
- Inform housing policy and affordability research

HUD updates FMRs every October for the new fiscal year. Data is available from FY 2017 onward via the [HUD USER API](https://www.huduser.gov/hudapi/public).

---

## What This App Does

FMR Map pulls live FMR data from the HUD USER REST API and visualizes it on an interactive map using county-level polygons.

### Core features

**Choropleth map**
- Select any US state from the dropdown or click any state directly on the map
- Every county (or HUD-defined FMR area) is filled with a color gradient from dark blue (low rent) through teal, green, amber, orange to red (high rent)
- The map auto-centers and zooms to fit the selected state

**State switching**
- A permanent US state outline layer sits beneath the county polygons
- Hovering any unselected state highlights its border; clicking it loads that state instantly
- The currently selected state has a teal accent border

**County detail panel**
- Click any county to open a side panel showing FMRs for all five bedroom sizes: Studio, 1 BR, 2 BR, 3 BR, and 4 BR
- Three tabs: **Current year**, **Previous year**, and **Year-over-Year change** with dollar and percentage deltas
- Color-coded amounts (green = low, amber = mid, orange/red = high)

**Year-over-Year Trends panel**
- Toggle the **YOY Trends** panel from the header to see every area in the state ranked by rent change percentage
- Summary bar shows state average change, count of areas up vs down
- Increases and decreases are split into separate sections with rank badges
- Click any row to fly the map to that county and open the detail panel

**Bedroom and year selectors**
- Switch the choropleth between bedroom sizes (Studio through 4 BR) — the map re-colors instantly
- Switch fiscal years (FY 2017–present) — the entire dataset reloads for the selected year

**Light / dark mode**
- Toggle between dark (default) and light CartoDB basemaps from the header
- Preference is persisted to `localStorage` and defaults to the OS `prefers-color-scheme` setting

**Splash screen / About**
- First-time visitors see an explanatory splash screen covering what FMRs are and how to use the app
- The `?` button in the header reopens it at any time

**Session memory**
- The last selected state is stored in `localStorage` and restored on return visits
- Fresh visits start on a full US view with state outlines visible and clickable

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express |
| HUD API proxy | `node-fetch` with Bearer token auth |
| Server-side cache | In-memory Map with 24-hour TTL |
| Frontend | Vanilla JavaScript (ES modules) |
| Map engine | [Leaflet.js](https://leafletjs.com/) 1.9 |
| Map tiles | CartoDB Dark Matter / Positron (light mode) |
| County polygons | Census Bureau TIGER/Line GeoJSON (52 files) |
| State outlines | Natural Earth simplified GeoJSON |
| Fonts | DM Serif Display, DM Mono, Inter (Google Fonts) |
| Containerisation | Docker + Docker Compose |

---

## Project Structure

```
fmr-map/
├── server/
│   └── index.js            # Express server — API proxy, caching, static file serving
├── public/
│   ├── index.html          # Single-page app shell
│   ├── css/
│   │   └── style.css       # Dark/light editorial UI theme
│   ├── js/
│   │   └── app.js          # All frontend logic — map, data pipeline, UI
│   └── data/
│       ├── states.json     # US state boundary polygons (always-visible layer)
│       └── counties/       # 52 GeoJSON files, one per state, named by FIPS code
│           ├── 25.json     #   e.g. Massachusetts
│           ├── 48.json     #   e.g. Texas
│           └── ...
├── nginx/
│   └── nginx.conf          # Reverse proxy config for production (optional)
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── package.json
```

---

## How the Data Pipeline Works

1. **State selected** → app fetches the state's GeoJSON county polygons from `/data/counties/{fips}.json` and the HUD county list from `/api/counties/{stateCode}` in parallel
2. **FIPS matching** → each HUD area (10-digit FIPS code) is mapped to a GeoJSON polygon (5-digit county FIPS) by taking the first 5 digits of the HUD code
3. **FMR data fetch** → app calls `/api/fmr-state/{stateCode}?year={year}` for both the current and previous fiscal year, which hits HUD's `statedata` endpoint and returns `metroareas` + `counties` arrays
4. **Choropleth render** → each polygon is filled using a 7-stop color gradient keyed to the 2 BR rent by default
5. **County click** → if FMR data for the clicked entity is already cached from step 3, it renders instantly; otherwise a per-entity fallback fetch is made to `/api/fmr/{entityId}`

The Express server acts as a proxy so the HUD API token never reaches the browser. All HUD responses are cached in-memory for 24 hours — after the first load of a state the data is served instantly with no external requests.

---

## GeoJSON Data Notes

The county boundary files in `public/data/counties/` have been updated to reflect current Census Bureau designations:

| Old name | New name | FIPS | Year changed |
|---|---|---|---|
| Wade Hampton Census Area, AK | Kusilvak Census Area | 02158 (was 02270) | 2015 |
| Shannon County, SD | Oglala Lakota County | 46102 (was 46113) | 2015 |
| Valdez-Cordova Census Area, AK | Split into Chugach (02063) + Copper River (02066) | — | 2019 |

Alaska's Aleutians West Census Area (02016) crosses the antimeridian; its bounding box is excluded from the map's auto-zoom calculation so Alaska loads at a sensible zoom level.

---

## Getting Started

### Prerequisites

- Node.js 20+
- A free HUD USER API token — register at [https://www.huduser.gov/hudapi/public/register](https://www.huduser.gov/hudapi/public/register)

### Local development

```bash
# Clone the repo
git clone https://github.com/jackboyce/fmr-map.git
cd fmr-map

# Install dependencies
npm install

# Create your .env file
cp .env.example .env
# Edit .env and set HUD_API_TOKEN=your_token_here

# Start the server
npm start
# or, with auto-restart on file changes:
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Docker Deployment

### Simple (no domain, direct port access)

```yaml
# docker-compose.yml
services:
  app:
    build: .
    container_name: fmr-map
    restart: unless-stopped
    env_file: .env
    ports:
      - "3000:3000"
```

```bash
# On your server
cp .env.example .env
nano .env  # add your HUD_API_TOKEN

sudo ufw allow 3000/tcp

docker compose up -d --build
docker compose ps      # should show (healthy)
docker compose logs    # check for startup errors
```

App will be available at `http://your-server-ip:3000`.

### With Nginx reverse proxy + TLS

The repo includes a full `nginx/nginx.conf` and a `docker-compose.yml` with both `app` and `nginx` services. See [DEPLOY.md](DEPLOY.md) for the complete walkthrough including Let's Encrypt certificate setup and auto-renewal.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `HUD_API_TOKEN` | **Yes** | Bearer token from HUD USER API registration |
| `PORT` | No | Port the server listens on (default: `3000`) |

The `.env` file is excluded from git and never baked into the Docker image. It is injected at container runtime via `env_file` in `docker-compose.yml`.

---

## API Routes

| Route | Description |
|---|---|
| `GET /api/state-fips` | Static state abbreviation → FIPS lookup table |
| `GET /api/states` | List of all states from HUD (name + code) |
| `GET /api/counties/:stateCode` | List of HUD FMR areas for a state |
| `GET /api/fmr-state/:stateCode?year=` | Full FMR dataset for a state (metro areas + counties) |
| `GET /api/fmr/:entityId?year=` | FMR data for a single entity (fallback) |
| `GET /api/years` | Available fiscal years (2017–present) |
| `GET /data/counties/:fips.json` | County boundary GeoJSON (static) |
| `GET /data/states.json` | US state boundary GeoJSON (static) |

---

## Planned Features

- **Small Area FMR (SAFMR) support** — HUD has implemented Small Area FMRs in certain metropolitan areas (including Massachusetts and Connecticut), setting voucher payment standards at the ZIP code level rather than the broader metro area level. A future update will detect when a state uses SAFMR and display ZIP-code-level rent data instead of county-level FMRs for those areas.
- Nginx + TLS production deployment guide (see DEPLOY.md)
- Auto-renewal cron for Let's Encrypt certificates

---

## Data Sources

- **HUD USER API** — [https://www.huduser.gov/hudapi/public](https://www.huduser.gov/hudapi/public) — Fair Market Rent data
- **US Census Bureau TIGER/Line** — County boundary shapefiles (converted to GeoJSON)
- **Natural Earth / PublicaMundi** — Simplified US state boundaries

---

## License

MIT — Built by [Jack Boyce](https://github.com/jackboyce/fmr-map)

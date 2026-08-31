// ===================================================
//  FMR MAP — POLYGON CHOROPLETH EDITION
// ===================================================

// ── Config ───────────────────────────────────────────
const BEDROOM_KEYS   = ['efficiency','one_br','two_br','three_br','four_br'];
const BEDROOM_LABELS = {
  efficiency:{ short:'Studio', long:'Studio / Efficiency', icon:'🏠' },
  one_br:    { short:'1 BR',   long:'1 Bedroom',           icon:'🛏' },
  two_br:    { short:'2 BR',   long:'2 Bedrooms',          icon:'🛏' },
  three_br:  { short:'3 BR',   long:'3 Bedrooms',          icon:'🏡' },
  four_br:   { short:'4 BR',   long:'4 Bedrooms',          icon:'🏘' },
};

// Color stops: [threshold, hex]
const COLOR_STOPS = [
  [0,    '#1a3a5c'],
  [700,  '#1e6091'],
  [1000, '#1a9e8f'],
  [1400, '#52c07a'],
  [1800, '#f6c643'],
  [2400, '#f4813d'],
  [3200, '#e63946'],
  [5000, '#9b1c2e'],
];

// States for which HUD publishes Small Area FMR (ZIP-level) data
// ── State ────────────────────────────────────────────
const appState = {
  currentYear:     2025,
  previousYear:    2024,
  selectedBedroom: 'two_br',
  selectedStateCode: null,
  stateFips:       {},          // MA → '25' etc
  fipsToState:     {},          // '25' → 'MA' etc (reverse lookup)
  counties:        [],          // HUD area list for selected state
  fmrData:         new Map(),   // "entityId_year" → parsed rent obj
  geojsonLayer:    null,
  statesLayer:     null,        // always-visible US state outlines
  selectedAreaId:  null,
  activeTab:       'current',
  polygonsByFips:  new Map(),   // fips5 → L.polygon layer(s)
  areaByFips:      new Map(),   // fips5 → HUD area object
  mapAnimating:    false,       // true while fitBounds is running
  trendsWasOpen:   false,       // mobile: restore trends panel after closing county detail
  safmrMode:       false,       // true = render ZIP polygons for SAFMR metros
  safmrMetros:     [],          // metros with smallarea_status=1 for selected state
  mrvpMode:        false,       // true = render MA MRVP payment standards (MA only)
};

// ── DOM refs ─────────────────────────────────────────
const elStateSelect   = document.getElementById('stateSelect');
const elYearSelect    = document.getElementById('yearSelect');
const elBedroomSelect = document.getElementById('bedroomSelect');
const elDetailPanel   = document.getElementById('detailPanel');
const elClosePanel    = document.getElementById('closePanel');
const elFmrContent    = document.getElementById('fmrContent');
const elAreaName      = document.getElementById('areaName');
const elAreaState     = document.getElementById('areaState');
const elMetroStatus   = document.getElementById('metroStatus');
const elCurrentYearLbl= document.getElementById('currentYearLabel');
const elPrevYearLbl   = document.getElementById('prevYearLabel');
const elMapMessage    = document.getElementById('mapMessage');
const elMapLegend     = document.getElementById('mapLegend');
const elLegendMin     = document.getElementById('legendMin');
const elLegendMax     = document.getElementById('legendMax');
const elLoadingOverlay= document.getElementById('loadingOverlay');
const elSplashScreen  = document.getElementById('splashScreen');
const elSplashClose   = document.getElementById('splashClose');
const elAboutBtn      = document.getElementById('aboutBtn');
const elSplashBackdrop= document.querySelector('.splash-backdrop');
const elSafmrToggle   = document.getElementById('safmrToggle');
const elTrendsPanel   = document.getElementById('trendsPanel');
const elTrendsToggle  = document.getElementById('trendsToggle');
const elCloseTrends   = document.getElementById('closeTrends');
const elTrendsList    = document.getElementById('trendsList');
const elTrendsSummary = document.getElementById('trendsSummary');
const elTrendsSubtitle= document.getElementById('trendsSubtitle');

// ── Map init ─────────────────────────────────────────
const map = L.map('map', {
  center: [39.5, -98.35],
  zoom: 4,
  zoomControl: true,
  attributionControl: true,
});

// Suppress hover highlights during any map movement (drag + inertia).
// mapAnimating is already checked in each layer's mouseover handler.
map.on('movestart', () => { appState.mapAnimating = true;  clearHoveredLayer(); });
map.on('moveend',   () => { appState.mapAnimating = false; });
window.addEventListener('blur', clearHoveredLayer);

map.attributionControl.setPrefix(
  '<a href="https://github.com/jackboyce/fmr-map" target="_blank" rel="noopener">Jack Boyce</a> | <a href="https://leafletjs.com" title="A JavaScript library for interactive maps">Leaflet</a>'
);

function makeTiles(key) {
  const q = key ? `?api_key=${key}` : '';
  return {
    dark: {
      base:   `https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png${q}`,
      labels: `https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png${q}`,
    },
    light: {
      base:   `https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png${q}`,
      labels: `https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png${q}`,
    },
  };
}
let TILES = makeTiles('');
const CARTO_ATTR = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/">CARTO</a>';

// Tile layers are added after /api/config resolves so the API key is baked in from the first request
let tileBase   = L.tileLayer('', { attribution: CARTO_ATTR, subdomains: 'abcd', maxZoom: 19 });
const labelPane = map.createPane('labels');
labelPane.style.zIndex = 450;
labelPane.style.pointerEvents = 'none';
let tileLabels = L.tileLayer('', { attribution: '', subdomains: 'abcd', maxZoom: 19, pane: 'labels' });

// ── Helpers ──────────────────────────────────────────
const fmt    = n => (n == null || n === 0) ? 'N/A' : '$' + Math.round(n).toLocaleString();
const isLight = () => document.documentElement.dataset.theme === 'light';

function getRentColor(amount) {
  if (!amount) return isLight() ? '#d0d5e4' : '#0d1b2a';
  for (let i = 1; i < COLOR_STOPS.length; i++) {
    const [v0, c0] = COLOR_STOPS[i - 1];
    const [v1, c1] = COLOR_STOPS[i];
    if (amount <= v1) return lerpColor(c0, c1, (amount - v0) / (v1 - v0));
  }
  return COLOR_STOPS[COLOR_STOPS.length - 1][1];
}

function lerpColor(a, b, t) {
  const ah = parseInt(a.slice(1), 16), bh = parseInt(b.slice(1), 16);
  const [ar,ag,ab] = [(ah>>16)&255,(ah>>8)&255,ah&255];
  const [br,bg,bb] = [(bh>>16)&255,(bh>>8)&255,bh&255];
  const hex = n => Math.round(n).toString(16).padStart(2,'0');
  return `#${hex(ar+(br-ar)*t)}${hex(ag+(bg-ag)*t)}${hex(ab+(bb-ab)*t)}`;
}

function rentClass(n) {
  if (!n) return '';
  return n < 1000 ? 'is-low' : n < 2000 ? 'is-mid' : 'is-high';
}

function fmrKey(id, year) { return `${id}_${year}`; }

// Extract rent values from an HUD response (handles several API shapes)
function extractAllRents(entry) {
  if (!entry) return {};
  const d    = entry.data   || entry;
  const bd   = d.basicdata?.[0] || d;
  const MAP  = {
    efficiency: ['Efficiency','efficiency'],
    one_br:     ['One-Bedroom','one_br'],
    two_br:     ['Two-Bedroom','two_br'],
    three_br:   ['Three-Bedroom','three_br'],
    four_br:    ['Four-Bedroom','four_br'],
  };
  const out = {};
  for (const key of BEDROOM_KEYS) {
    for (const k of MAP[key]) { if (bd[k] != null) { out[key] = bd[k]; break; } }
  }
  return out;
}

function extractRent(entry, bedroom) { return extractAllRents(entry)[bedroom] ?? null; }

// ── API ──────────────────────────────────────────────
async function api(path) {
  const res = await fetch(path);
  if (!res.ok) { const e = await res.json().catch(()=>({error:`HTTP ${res.status}`})); throw new Error(e.error||`HTTP ${res.status}`); }
  return res.json();
}

// ── Overlay helpers ───────────────────────────────────
function showOverlay(msg) {
  elLoadingOverlay.querySelector('.overlay-msg').textContent = msg;
  elLoadingOverlay.classList.remove('hidden');
}
function hideOverlay() { elLoadingOverlay.classList.add('hidden'); }

// ── Initialise ───────────────────────────────────────
async function init() {
  // Fetch server config then add tile layers so the API key is in the very first tile request
  try {
    const cfg = await api('/api/config');
    if (cfg.cartoKey) TILES = makeTiles(cfg.cartoKey);
  } catch {}
  tileBase.setUrl(TILES.dark.base);
  tileLabels.setUrl(TILES.dark.labels);
  tileBase.addTo(map);
  tileLabels.addTo(map);

  // Load years
  try {
    const years = await api('/api/years');
    elYearSelect.innerHTML = '';
    for (const y of years) {
      const o = document.createElement('option');
      o.value = y; o.textContent = isNarrow() ? `${y}` : `FY ${y}`;
      if (y === appState.currentYear) o.selected = true;
      elYearSelect.appendChild(o);
    }
  } catch {}

  // State-FIPS map + reverse lookup
  try {
    appState.stateFips = await api('/api/state-fips');
    for (const [abbr, fips] of Object.entries(appState.stateFips)) {
      appState.fipsToState[fips] = abbr;
    }
  } catch {}

  // States outline layer
  try {
    const statesGeo = await fetch('/data/states.json').then(r => r.json());
    initStatesLayer(statesGeo);
  } catch (e) { console.warn('States layer failed:', e); }

  // State list
  try {
    const data  = await api('/api/states');
    const states = (data.data || data).sort((a,b) => a.state_name.localeCompare(b.state_name));
    elStateSelect.innerHTML = `<option value="">${isNarrow() ? 'State' : '— Select a state —'}</option>`;
    for (const s of states) {
      const o = document.createElement('option');
      o.value = s.state_code; o.textContent = isNarrow() ? s.state_code : s.state_name;
      elStateSelect.appendChild(o);
    }
    // Restore last visited state, otherwise leave the map on the full US view
    const lastState = localStorage.getItem('fmrmap_last_state');
    if (lastState) {
      const opt = [...elStateSelect.options].find(o => o.value === lastState);
      if (opt) { opt.selected = true; loadState(lastState); }
    }
  } catch (e) {
    loadStaticStates();
  }
}

function loadStaticStates() {
  const S=[['AL','Alabama'],['AK','Alaska'],['AZ','Arizona'],['AR','Arkansas'],['CA','California'],
    ['CO','Colorado'],['CT','Connecticut'],['DE','Delaware'],['FL','Florida'],['GA','Georgia'],
    ['HI','Hawaii'],['ID','Idaho'],['IL','Illinois'],['IN','Indiana'],['IA','Iowa'],
    ['KS','Kansas'],['KY','Kentucky'],['LA','Louisiana'],['ME','Maine'],['MD','Maryland'],
    ['MA','Massachusetts'],['MI','Michigan'],['MN','Minnesota'],['MS','Mississippi'],['MO','Missouri'],
    ['MT','Montana'],['NE','Nebraska'],['NV','Nevada'],['NH','New Hampshire'],['NJ','New Jersey'],
    ['NM','New Mexico'],['NY','New York'],['NC','North Carolina'],['ND','North Dakota'],['OH','Ohio'],
    ['OK','Oklahoma'],['OR','Oregon'],['PA','Pennsylvania'],['RI','Rhode Island'],['SC','South Carolina'],
    ['SD','South Dakota'],['TN','Tennessee'],['TX','Texas'],['UT','Utah'],['VT','Vermont'],
    ['VA','Virginia'],['WA','Washington'],['WV','West Virginia'],['WI','Wisconsin'],['WY','Wyoming']];
  elStateSelect.innerHTML = `<option value="">${isNarrow() ? 'State' : '— Select a state —'}</option>`;
  for (const [c,n] of S) {
    const o = document.createElement('option'); o.value=c; o.textContent=isNarrow()?c:n; elStateSelect.appendChild(o);
  }
}

// ── States outline layer ──────────────────────────────
function stateStyle(feature) {
  const isSelected = appState.fipsToState[feature.id] === appState.selectedStateCode;
  return {
    fillColor:   '#4fd1c5',
    fillOpacity: isSelected ? 0.04 : 0.01, // near-zero but non-zero so SVG hit-testing works
    color:       isSelected ? '#4fd1c5' : (isLight() ? '#9aa5c0' : '#2e3d5a'),
    weight:      isSelected ? 2 : 1,
    opacity:     1,
  };
}

function initStatesLayer(geojson) {
  appState.statesLayer = L.geoJSON(geojson, {
    style: feature => stateStyle(feature),
    onEachFeature: (feature, layer) => {
      // Resolve state code once at creation time — avoids stale-closure issues at click time
      const code = appState.fipsToState[feature.id];
      const name = (feature.properties && feature.properties.name) || '';
      if (!code) return; // skip territories with no matching state code

      layer.on({
        mouseover: e => {
          if (code !== appState.selectedStateCode) {
            e.target.setStyle({ color: '#6b7fa8', weight: 1.5, fillOpacity: 0.07, fillColor: '#4fd1c5' });
          }
          if (appState.geojsonLayer) appState.geojsonLayer.bringToFront();
        },
        mouseout: e => {
          e.target.setStyle(stateStyle(feature));
          if (appState.geojsonLayer) appState.geojsonLayer.bringToFront();
        },
        click: () => {
          if (code !== appState.selectedStateCode) {
            elStateSelect.value = code;
            loadState(code);
          }
        },
      });

      layer.bindTooltip(`<span class="state-name-tt">${name}</span>`, {
        sticky: true, offset: [12, 0], direction: 'right',
      });
    },
  }).addTo(map);
}

function refreshStatesLayer() {
  if (!appState.statesLayer) return;
  appState.statesLayer.eachLayer(layer => {
    layer.setStyle(stateStyle(layer.feature));
  });
  if (appState.geojsonLayer) appState.geojsonLayer.bringToFront();
}

// ── SAFMR button state ────────────────────────────────
const MRVP_YEARS = new Set([2023, 2024, 2025]);

function updateAltButton() {
  const state = appState.selectedStateCode;
  const year  = appState.currentYear;

  if (state === 'MA') {
    const canMrvp = MRVP_YEARS.has(year);
    elSafmrToggle.textContent = 'MRVP';
    elSafmrToggle.disabled    = !canMrvp;
    elSafmrToggle.classList.toggle('active', canMrvp && appState.mrvpMode);
    elSafmrToggle.title = canMrvp
      ? (appState.mrvpMode ? 'Switch back to HUD FMR view' : 'View MRVP payment standards by ZIP')
      : 'No MRVP data available for this year';
  } else {
    const canSafmr = appState.safmrMetros.length > 0;
    elSafmrToggle.textContent = 'SAFMR';
    elSafmrToggle.disabled    = !canSafmr;
    elSafmrToggle.classList.toggle('active', canSafmr && appState.safmrMode);
    const n = appState.safmrMetros.length;
    elSafmrToggle.title = canSafmr
      ? (appState.safmrMode
          ? 'Switch to county view'
          : `Switch to ZIP-level Small Area FMR view (${n} metro${n > 1 ? 's' : ''})`)
      : 'No Small Area FMR metros in this state';
  }
}
// legacy alias — remove once all call sites updated
const updateSafmrButton = updateAltButton;

// ── Load a state ─────────────────────────────────────
async function loadState(stateCode, { skipZoom = false } = {}) {
  if (!stateCode) return;
  // MRVP is MA-only; SAFMR metro list refreshes per state
  if (stateCode !== 'MA') appState.mrvpMode = false;
  appState.safmrMetros = [];
  updateAltButton();
  appState.selectedStateCode = stateCode;
  appState.polygonsByFips.clear();
  appState.areaByFips.clear();
  appState.fmrData.clear();
  appState.selectedAreaId = null;
  elDetailPanel.classList.add('hidden');
  elMapMessage.classList.add('hidden');

  showOverlay('Loading county data…');

  try {
    const stateFipsCode = appState.stateFips[stateCode];
    if (!stateFipsCode) throw new Error(`No FIPS code for state ${stateCode}`);

    // Load county GeoJSON + optional town GeoJSON + HUD area list in parallel
    const [countyGeojson, townGeojson, countiesResp] = await Promise.all([
      fetch(`/data/counties/${stateFipsCode}.json`).then(r => r.ok ? r.json() : Promise.reject('GeoJSON not found')),
      fetch(`/data/towns/${stateFipsCode}.json`).then(r => r.ok ? r.json() : null).catch(() => null),
      api(`/api/counties/${stateCode}`),
    ]);

    appState.counties = countiesResp.data || countiesResp;

    // Detect town-level data: HUD defines FMR at the town level for some New England states
    const isTownLevel = townGeojson !== null && appState.counties.some(a => a.town_name);
    if (isTownLevel && townGeojson) {
      // Strip Census placeholder features (ocean/unorganized areas with no real name)
      townGeojson.features = townGeojson.features.filter(
        f => f.properties.NAME && !f.properties.NAME.toLowerCase().includes('not defined')
      );
    }
    const geojson = isTownLevel ? townGeojson : countyGeojson;

    // Build a name→FIPS lookup from GeoJSON for metro matching
    const nameToFips = new Map();
    for (const f of geojson.features) {
      const name = f.properties.NAME.toLowerCase();
      nameToFips.set(name, f.id);
      nameToFips.set(name + ' county', f.id);
    }

    // Build areaByFips: for each HUD area, figure out which FIPS polygons it covers
    for (const area of appState.counties) {
      if (area.metro_status === '0' || !area.metro_status) {
        // Town-level states (e.g. MA): match by full 10-digit FIPS
        // County-level states: use first 5 digits
        const fips = isTownLevel
          ? (area.fips_code || '').toString()
          : (area.fips_code || '').toString().slice(0, 5);
        appState.areaByFips.set(fips, area);
      } else {
        // Metro area: parse counties_msa string into individual county names
        // e.g. "Hampden County, MA; Hampshire County, MA"
        const msaStr = area.counties_msa || area.area_name || '';
        const countyNames = msaStr
          .split(';')
          .map(s => s.trim().split(',')[0].trim().toLowerCase())
          .filter(Boolean);

        for (const cname of countyNames) {
          const fips = nameToFips.get(cname) || nameToFips.get(cname.replace(/ county$/, ''));
          if (fips) appState.areaByFips.set(fips, area);
        }
        if (area.fips_code) {
          appState.areaByFips.set(area.fips_code.toString().padStart(5,'0'), area);
        }
      }
    }

    // For town-level states: some municipalities changed Census place codes (e.g. towns that
    // incorporated as cities) but HUD kept the old FIPS. For GeoJSON polygons that have no
    // areaByFips match, try a name-based fallback against the HUD area list.
    if (isTownLevel) {
      const norm = n => n.toLowerCase().replace(/\s+town\s+city$/, ' city').trim();
      const areaByName = new Map();
      for (const area of appState.counties) {
        areaByName.set(norm(area.town_name || ''), area);
      }
      for (const f of geojson.features) {
        if (appState.areaByFips.has(f.id)) continue; // already matched by FIPS
        const area = areaByName.get(norm(f.properties.NAME));
        if (area) appState.areaByFips.set(f.id, area);
      }
    }

    // Load FMR data for both years (also populates appState.safmrMetros)
    showOverlay('Loading rent data…');
    await Promise.allSettled([
      loadStateFmr(stateCode, appState.currentYear),
      loadStateFmr(stateCode, appState.previousYear),
    ]);

    // For town-level states: statedata uses year-specific FIPS codes that may differ from the
    // current FIPS in listCounties. Alias any missing lookups by normalized town name so that
    // older years (e.g. towns that later became cities) still display correctly.
    if (isTownLevel) {
      const normT = n => n.toLowerCase().replace(/\s+(town city|town|city|village)$/i, '').trim();
      for (const year of [appState.currentYear, appState.previousYear]) {
        // Build name → fmrData entry from what statedata actually stored this year
        const entryByName = new Map();
        for (const [k, entry] of appState.fmrData) {
          if (!k.endsWith(`_${year}`)) continue;
          const tn = (entry.data || entry).town_name;
          if (tn) entryByName.set(normT(tn), entry);
        }
        // For each current-FIPS area that has no fmrData, alias from the name lookup
        for (const [, area] of appState.areaByFips) {
          if (!area.town_name) continue;
          const key = fmrKey(area.fips_code, year);
          if (appState.fmrData.has(key)) continue;
          const entry = entryByName.get(normT(area.town_name));
          if (entry) appState.fmrData.set(key, entry);
        }
      }
    }

    // MRVP mode: switch to MRVP payment-standard view (MA only)
    if (appState.mrvpMode && stateCode === 'MA' && MRVP_YEARS.has(appState.currentYear)) {
      return loadMrvpState(stateCode, { skipZoom });
    }

    // SAFMR mode: switch to ZIP-level Small Area FMR view
    if (appState.safmrMode && appState.safmrMetros.length > 0) {
      return loadSafmrState(stateCode, { skipZoom });
    }

    // Render the choropleth
    renderPolygons(geojson, skipZoom);
    refreshStatesLayer();
    buildTrendsList();
    hideOverlay();
    localStorage.setItem('fmrmap_last_state', stateCode);

  } catch (e) {
    hideOverlay();
    console.error(e);
    elMapMessage.classList.remove('hidden');
    elMapMessage.querySelector('p').textContent = `Error: ${e.message || e}`;
  }
}

async function loadStateFmr(stateCode, year) {
  try {
    const data       = await api(`/api/fmr-state/${stateCode}?year=${year}`);
    const inner      = data.data || data;
    const counties   = inner.counties   || [];
    const metroareas = inner.metroareas || [];
    for (const area of [...counties, ...metroareas]) {
      const id = area.fips_code || area.code || area.cbsacode || area.entity_id;
      if (id) appState.fmrData.set(fmrKey(id, year), { data: area });
    }
    // Detect SAFMR metros in the current-year load
    if (year === appState.currentYear) {
      appState.safmrMetros = metroareas.filter(m => String(m.smallarea_status) === '1');
      updateSafmrButton();
    }
  } catch (e) { console.warn(`State FMR ${stateCode}/${year}:`, e.message); }
}

async function loadSafmrState(stateCode, { skipZoom = false } = {}) {
  appState.selectedStateCode = stateCode;
  appState.polygonsByFips.clear();
  appState.areaByFips.clear();
  appState.fmrData.clear();
  appState.counties = [];
  appState.selectedAreaId = null;
  elDetailPanel.classList.add('hidden');
  elMapMessage.classList.add('hidden');

  showOverlay('Loading ZIP data…');

  try {
    const stateFipsCode = appState.stateFips[stateCode];
    if (!stateFipsCode) throw new Error(`No FIPS for ${stateCode}`);

    // Load statedata for both years + ZIP GeoJSON in parallel
    const [stateCurr, statePrev, geojson] = await Promise.all([
      api(`/api/fmr-state/${stateCode}?year=${appState.currentYear}`).catch(() => null),
      api(`/api/fmr-state/${stateCode}?year=${appState.previousYear}`).catch(() => null),
      fetch(`/data/zips/${stateFipsCode}.json`).then(r => {
        if (!r.ok) throw new Error(`ZIP GeoJSON not found for ${stateCode}`);
        return r.json();
      }),
    ]);

    // Ingest county/metro-level FMR (used for non-SAFMR areas shown grey)
    for (const [data, year] of [[stateCurr, appState.currentYear], [statePrev, appState.previousYear]]) {
      const inner = data?.data || {};
      for (const area of [...(inner.counties || []), ...(inner.metroareas || [])]) {
        const id = area.fips_code || area.code;
        if (id) appState.fmrData.set(fmrKey(id, year), { data: area });
      }
    }

    // Identify SAFMR metros from current-year statedata
    const safmrMetros = (stateCurr?.data?.metroareas || [])
      .filter(m => String(m.smallarea_status) === '1');
    appState.safmrMetros = safmrMetros;
    updateSafmrButton();

    if (safmrMetros.length === 0) throw new Error('No Small Area FMR metros found for this state');

    // Fetch per-metro ZIP-level FMR data (basicdata has one entry per ZIP)
    showOverlay('Loading ZIP rent data…');
    const metroCodes = safmrMetros.map(m => m.code);
    const [zipDataCurr, zipDataPrev] = await Promise.all([
      Promise.allSettled(metroCodes.map(c => api(`/api/fmr/${c}?year=${appState.currentYear}`))),
      Promise.allSettled(metroCodes.map(c => api(`/api/fmr/${c}?year=${appState.previousYear}`))),
    ]);

    // Ingest ZIP-level data: keyed by 5-digit ZIP
    for (const [results, year] of [[zipDataCurr, appState.currentYear], [zipDataPrev, appState.previousYear]]) {
      for (const [i, result] of results.entries()) {
        if (result.status !== 'fulfilled') continue;
        const metro   = safmrMetros[i];
        const rawBd   = result.value?.data?.basicdata;
        const entries = Array.isArray(rawBd) ? rawBd : [];
        for (const entry of entries) {
          const raw = entry.zip_code?.toString();
          if (!raw || raw === 'MSA level') continue;
          const zip = raw.padStart(5, '0');
          appState.fmrData.set(fmrKey(zip, year), { data: entry });
          if (year === appState.currentYear) {
            appState.areaByFips.set(zip, {
              fips_code:    zip,
              zip_code:     zip,
              area_name:    `ZIP ${zip}`,
              metro_name:   metro.metro_name,
              metro_status: '1',
            });
          }
        }
      }
    }

    // Normalize ZIP GeoJSON feature IDs to 5-digit strings
    const sampleProps = geojson.features[0]?.properties || {};
    const zipProp = 'ZCTA5CE20' in sampleProps ? 'ZCTA5CE20'
                  : 'ZCTA5CE10' in sampleProps ? 'ZCTA5CE10'
                  : 'GEOID10'   in sampleProps ? 'GEOID10'
                  : null;
    for (const f of geojson.features) {
      const raw = zipProp ? f.properties[zipProp] : f.id;
      f.id = raw ? raw.toString().padStart(5, '0') : String(f.id);
    }

    showOverlay('Rendering…');
    renderPolygons(geojson, skipZoom);
    refreshStatesLayer();
    buildTrendsList();
    hideOverlay();
    localStorage.setItem('fmrmap_last_state', stateCode);

  } catch (e) {
    hideOverlay();
    console.error(e);
    appState.safmrMode = false;
    updateSafmrButton();
    elMapMessage.classList.remove('hidden');
    elMapMessage.querySelector('p').textContent = `ZIP view unavailable for ${stateCode}: ${e.message}`;
  }
}

async function loadMrvpState(stateCode, { skipZoom = false } = {}) {
  const year      = appState.currentYear;
  const prevYear  = appState.previousYear;
  const stateFips = appState.stateFips[stateCode];
  const useZip    = year >= 2024;

  appState.selectedStateCode = stateCode;
  appState.polygonsByFips.clear();
  appState.areaByFips.clear();
  appState.fmrData.clear();
  appState.counties = [];
  appState.selectedAreaId = null;
  elDetailPanel.classList.add('hidden');
  elMapMessage.classList.add('hidden');

  showOverlay('Loading MRVP data…');

  try {
    const geoPath = useZip ? `/data/zips/${stateFips}.json` : `/data/towns/${stateFips}.json`;
    const prevPath = MRVP_YEARS.has(prevYear) ? `/data/mrvp/${prevYear}.json` : null;

    const [mrvpCurr, mrvpPrev, geojson] = await Promise.all([
      fetch(`/data/mrvp/${year}.json`).then(r => { if (!r.ok) throw new Error(`No MRVP data for FY${year}`); return r.json(); }),
      prevPath ? fetch(prevPath).then(r => r.ok ? r.json() : null).catch(() => null) : Promise.resolve(null),
      fetch(geoPath).then(r => r.json()),
    ]);

    if (useZip) {
      // Normalize ZIP GeoJSON feature IDs
      const sampleProps = geojson.features[0]?.properties || {};
      const zipProp = 'ZCTA5CE20' in sampleProps ? 'ZCTA5CE20'
                    : 'ZCTA5CE10' in sampleProps ? 'ZCTA5CE10'
                    : 'GEOID10'   in sampleProps ? 'GEOID10' : null;
      for (const f of geojson.features) {
        const raw = zipProp ? f.properties[zipProp] : f.id;
        f.id = raw ? raw.toString().padStart(5, '0') : String(f.id);
      }

      for (const [zip, entry] of Object.entries(mrvpCurr)) {
        appState.areaByFips.set(zip, { fips_code: zip, zip_code: zip, area_name: `ZIP ${zip}`, town_name: entry.town || '', mrvp: true });
        appState.fmrData.set(fmrKey(zip, year), { data: entry });
      }
      if (mrvpPrev) {
        for (const [zip, entry] of Object.entries(mrvpPrev)) {
          appState.fmrData.set(fmrKey(zip, prevYear), { data: entry });
        }
      }
    } else {
      // Town mode (2023) — normalize name, match to town GeoJSON features
      const normT = n => n.toLowerCase().replace(/\s+(town city|town|city|village)$/i, '').trim();
      for (const f of geojson.features) {
        const key   = normT(f.properties.NAME || '');
        const entry = mrvpCurr[key];
        if (!entry) continue;
        appState.areaByFips.set(f.id, { fips_code: f.id, area_name: f.properties.NAME, town_name: f.properties.NAME, mrvp: true });
        appState.fmrData.set(fmrKey(f.id, year), { data: entry });
      }
    }

    renderPolygons(geojson, skipZoom);
    refreshStatesLayer();
    buildTrendsList();
    hideOverlay();
    localStorage.setItem('fmrmap_last_state', stateCode);

  } catch (e) {
    hideOverlay();
    console.error(e);
    appState.mrvpMode = false;
    updateAltButton();
    elMapMessage.classList.remove('hidden');
    elMapMessage.querySelector('p').textContent = `MRVP data unavailable: ${e.message}`;
  }
}

async function loadEntityFmr(entityId, year) {
  const k = fmrKey(entityId, year);
  if (appState.fmrData.has(k)) return appState.fmrData.get(k);
  try {
    const d = await api(`/api/fmr/${entityId}?year=${year}`);
    appState.fmrData.set(k, d);
    return d;
  } catch { return null; }
}

// ── Get rent for an area ─────────────────────────────
function getRentForArea(area) {
  const id = area.fips_code || area.cbsacode || area.entity_id;
  const entry = appState.fmrData.get(fmrKey(id, appState.currentYear));
  return extractRent(entry, appState.selectedBedroom);
}

// ── Render polygons ───────────────────────────────────

// Leaflet's getBounds() on a GeoJSON layer that contains antimeridian-crossing
// polygons (e.g. Aleutians West in Alaska, lon -179° to +179°) returns a
// near-globe-wide bounding box and causes the map to zoom all the way out.
// Fix: collect each sub-layer's bounds individually and skip any whose
// east-west span exceeds 200° (a reliable indicator of antimeridian wrap).
function safeBounds(geojsonLayer) {
  let bounds = null;
  geojsonLayer.eachLayer(l => {
    try {
      const b = l.getBounds();
      if (b.getEast() - b.getWest() > 200) return; // skip antimeridian-crossing polygon
      bounds = bounds ? bounds.extend(b) : L.latLngBounds(b.getSouthWest(), b.getNorthEast());
    } catch (_) {}
  });
  return bounds || geojsonLayer.getBounds(); // fallback if all polys were skipped
}

function renderPolygons(geojson, skipZoom = false) {
  if (appState.geojsonLayer) { map.removeLayer(appState.geojsonLayer); appState.geojsonLayer = null; }
  appState.polygonsByFips.clear();

  // Compute rent range for legend
  const rents = [];
  for (const [, area] of appState.areaByFips) {
    const r = getRentForArea(area); if (r) rents.push(r);
  }
  if (rents.length) {
    elMapLegend.classList.remove('hidden');
    elLegendMin.textContent = fmt(Math.min(...rents));
    elLegendMax.textContent = fmt(Math.max(...rents));
    const br = BEDROOM_LABELS[appState.selectedBedroom].short;
    const prefix = appState.mrvpMode ? 'MRVP' : 'Monthly FMR';
    document.getElementById('bedroomLegendLabel').textContent = br;
    document.querySelector('.legend-title').firstChild.textContent = `${prefix} · `;
  }

  const layer = L.geoJSON(geojson, {
    style: feature => styleFeature(feature),
    onEachFeature: (feature, layer) => {
      const fips = feature.id;
      appState.polygonsByFips.set(fips, layer);

      const area = appState.areaByFips.get(fips);
      const name = area?.area_name || area?.town_name || area?.county_name || feature.properties.NAME;

      layer.on({
        mouseover: e => {
          if (appState.mapAnimating || fips === appState.selectedAreaId) return;
          highlightLayer(e.target);
          showHoverTooltip(buildTooltip(name, area ? getRentForArea(area) : null), e.latlng);
        },
        mousemove: e => {
          if (!appState.mapAnimating && fips !== appState.selectedAreaId) {
            moveHoverTooltip(e.latlng);
          }
        },
        mouseout: e => {
          if (fips !== appState.selectedAreaId) layer.setStyle(styleFeature(feature));
          hideHoverTooltip();
        },
        click: () => {
          if (area) selectArea(area, fips);
        },
      });
    },
  });

  clearHoveredLayer();
  appState.geojsonLayer = layer.addTo(map);
  if (!skipZoom) {
    map.fitBounds(safeBounds(layer).pad(0.05));
  }
}

function styleFeature(feature) {
  const fips  = feature.id;
  const area  = appState.areaByFips.get(fips);
  const rent  = area ? getRentForArea(area) : null;
  const isSelected = fips === appState.selectedAreaId;
  return {
    fillColor:   getRentColor(rent),
    fillOpacity: rent ? 0.78 : 0.15,
    color:       isSelected ? '#4fd1c5' : (isLight() ? '#9aa5c0' : '#0d1b2a'),
    weight:      isSelected ? 2.5 : 0.6,
    opacity:     1,
  };
}

// ── Single shared hover tooltip ───────────────────────
// Using one map-level tooltip avoids Leaflet's per-layer auto-reopen behavior
// which causes phantom duplicate tooltips on overlapping polygons.
const _hoverTip = L.tooltip({ className: 'fmr-tooltip', offset: [12, 0], direction: 'right' });

function showHoverTooltip(content, latlng) {
  _hoverTip.setContent(content);
  _hoverTip.setLatLng(latlng);
  if (!_hoverTip._map) map.openTooltip(_hoverTip);
}

function moveHoverTooltip(latlng) {
  if (_hoverTip._map) _hoverTip.setLatLng(latlng);
}

function hideHoverTooltip() {
  if (_hoverTip._map) map.closeTooltip(_hoverTip);
}

let _hoveredLayer = null;

function highlightLayer(layer) {
  if (_hoveredLayer && _hoveredLayer !== layer) {
    const f = _hoveredLayer.feature;
    if (f) _hoveredLayer.setStyle(styleFeature(f));
  }
  _hoveredLayer = layer;
  layer.setStyle({ weight: 2, color: '#a0e4dc', fillOpacity: 0.9 });
  layer.bringToFront();
}

function clearHoveredLayer() {
  if (_hoveredLayer) {
    const f = _hoveredLayer.feature;
    if (f) _hoveredLayer.setStyle(styleFeature(f));
    _hoveredLayer = null;
  }
  hideHoverTooltip();
}

function buildTooltip(name, rent) {
  return `<strong>${name || 'Unknown area'}</strong>
<span class="tt-rent">${fmt(rent)}</span>
<small>${BEDROOM_LABELS[appState.selectedBedroom].short}/mo</small>`;
}

// Refresh all polygon colors (bedroom/year change)
function refreshPolygonStyles() {
  if (!appState.geojsonLayer) return;
  appState.geojsonLayer.eachLayer(layer => {
    const fips = layer.feature?.id;
    const area = fips ? appState.areaByFips.get(fips) : null;
    const rent = area ? getRentForArea(area) : null;
    const isSelected = fips === appState.selectedAreaId;

    layer.setStyle({
      fillColor:   getRentColor(rent),
      fillOpacity: rent ? 0.78 : 0.15,
      color:       isSelected ? '#4fd1c5' : (isLight() ? '#9aa5c0' : '#0d1b2a'),
      weight:      isSelected ? 2.5 : 0.6,
    });

  });

  // Refresh legend
  const rents = [];
  for (const [, area] of appState.areaByFips) {
    const r = getRentForArea(area); if (r) rents.push(r);
  }
  if (rents.length) {
    elLegendMin.textContent = fmt(Math.min(...rents));
    elLegendMax.textContent = fmt(Math.max(...rents));
  }
}

// ── Area selection ────────────────────────────────────
async function selectArea(area, fips) {
  const prevId = appState.selectedAreaId;
  appState.selectedAreaId = fips; // set first so styleFeature sees the new selection

  // Deselect old
  if (prevId && prevId !== fips) {
    const oldLayer = appState.polygonsByFips.get(prevId);
    if (oldLayer) oldLayer.setStyle(styleFeature(oldLayer.feature));
    deselectMetroPolygons(prevId);
  }

  // Highlight all polygons that share this HUD area
  highlightAreaPolygons(area, fips);

  const entityId = area.fips_code || area.cbsacode || area.entity_id;
  const name = area.area_name || area.town_name || area.county_name || 'Unknown';
  const stateLabel = area.state_code || appState.selectedStateCode;

  elAreaName.textContent   = name;
  elAreaState.textContent  = stateLabel;
  elCurrentYearLbl.textContent = `FY ${appState.currentYear}`;
  elPrevYearLbl.textContent    = `FY ${appState.previousYear}`;
  // On mobile, close trends panel when county detail opens (remember to restore on close)
  if (isMobile()) {
    appState.trendsWasOpen = !elTrendsPanel.classList.contains('hidden');
    elTrendsPanel.classList.add('hidden');
    elTrendsToggle.classList.remove('active');
    document.querySelector('.app-body').classList.remove('trends-open');
  }
  elDetailPanel.classList.remove('hidden');
  syncPanelOpenClass();
  setTimeout(() => map.invalidateSize({ animate: false }), 50);
  showPanelLoading();

  // In SAFMR/MRVP modes all data is pre-loaded; skip the per-entity API call
  const [curr, prev] = (appState.safmrMode || appState.mrvpMode)
    ? [appState.fmrData.get(fmrKey(entityId, appState.currentYear)),
       appState.fmrData.get(fmrKey(entityId, appState.previousYear))]
    : await Promise.all([
        loadEntityFmr(entityId, appState.currentYear),
        loadEntityFmr(entityId, appState.previousYear),
      ]);

  elMetroStatus.textContent = appState.mrvpMode
    ? (appState.currentYear >= 2024
        ? `MRVP Payment Standard · ZIP ${area.zip_code || fips}`
        : `MRVP Payment Standard · ${area.town_name || fips}`)
    : appState.safmrMode
      ? `Small Area FMR · ZIP ${area.zip_code || fips}`
      : area.metro_status === '1'
        ? `Metro area · ${area.metro_name || ''}`
        : area.town_name
          ? `Town-level FMR · ${area.county_name || ''}`
          : 'Non-metropolitan county';

  renderPanel(curr, prev);
  refreshTrendsSelection();
}

function highlightAreaPolygons(area, clickedFips) {
  // Style all constituent polygons for the selected area.
  // No bringToFront — letting adjacent polygons render on top prevents
  // the selection border from visually bleeding onto their fills.
  const clickedId = area.fips_code || area.cbsacode || area.entity_id;
  for (const [fips, a] of appState.areaByFips) {
    if ((a.fips_code || a.cbsacode || a.entity_id) === clickedId) {
      const poly = appState.polygonsByFips.get(fips);
      if (poly) poly.setStyle({ weight: 2.5, color: '#4fd1c5', fillOpacity: 0.88 });
    }
  }
}

function deselectMetroPolygons(fips) {
  const area = appState.areaByFips.get(fips);
  if (!area) return;
  const id = area.fips_code || area.cbsacode || area.entity_id;
  for (const [f, a] of appState.areaByFips) {
    if ((a.fips_code || a.cbsacode || a.entity_id) === id) {
      const poly = appState.polygonsByFips.get(f);
      if (poly) poly.setStyle(styleFeature(poly.feature));
    }
  }
}

// ── Panel rendering ───────────────────────────────────
function showPanelLoading() {
  elFmrContent.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading…</span></div>`;
}

function renderPanel(curr, prev) {
  switch (appState.activeTab) {
    case 'current':  renderYearTable(curr, appState.currentYear);  break;
    case 'previous': renderYearTable(prev, appState.previousYear); break;
    case 'change':   renderChangeTable(curr, prev);                break;
  }
}

function renderYearTable(entry, year) {
  const rents = extractAllRents(entry);
  if (!Object.values(rents).some(Boolean)) {
    elFmrContent.innerHTML = `<div class="error-state"><strong>No data</strong>FY ${year} not available for this area.</div>`;
    return;
  }
  elFmrContent.innerHTML = `
    <div class="fmr-table">
      <div class="table-header">FY ${year} Monthly Rent</div>
      ${BEDROOM_KEYS.map(key => {
        const amt = rents[key];
        const { short, long, icon } = BEDROOM_LABELS[key];
        const sel = key === appState.selectedBedroom;
        return `<div class="fmr-row ${sel?'highlighted':''}">
          <div class="fmr-row-icon">${icon}</div>
          <div class="fmr-row-label"><strong>${short}</strong>${long}</div>
          <div class="fmr-row-amount ${rentClass(amt)}">${fmt(amt)}</div>
        </div>`;
      }).join('')}
    </div>`;
}

function renderChangeTable(curr, prev) {
  const c = extractAllRents(curr), p = extractAllRents(prev);
  elFmrContent.innerHTML = `
    <div class="fmr-table">
      <div class="table-header">FY ${appState.previousYear} → FY ${appState.currentYear}</div>
      ${BEDROOM_KEYS.map(key => {
        const cv = c[key], pv = p[key];
        const diff = (cv!=null&&pv!=null) ? cv - pv : null;
        const pct  = (diff!=null&&pv)     ? ((diff/pv)*100).toFixed(1) : null;
        const cls  = diff==null?'change-flat':diff>0?'change-up':diff<0?'change-down':'change-flat';
        const arrow= diff==null?'':diff>0?'▲':diff<0?'▼':'—';
        const sel  = key === appState.selectedBedroom;
        return `<div class="change-row ${sel?'highlighted':''}">
          <div class="change-row-label"><strong>${BEDROOM_LABELS[key].short}</strong>${fmt(pv)} → ${fmt(cv)}</div>
          <div class="change-values ${cls}">
            <span class="change-amount">${diff!=null?arrow+' '+fmt(Math.abs(diff)):'—'}</span>
            <span class="change-pct">${pct!=null?pct+'%':''}</span>
          </div>
        </div>`;
      }).join('')}
    </div>`;
}

// ── Trends panel ─────────────────────────────────────
function isMobile() { return window.innerWidth <= 1100; }
function isNarrow() { return window.innerWidth <= 1100; }

function toggleTrendsPanel(forceOpen) {
  const open = forceOpen !== undefined ? forceOpen : elTrendsPanel.classList.contains('hidden');
  // On mobile, trends and detail panels are mutually exclusive
  if (open && isMobile()) {
    elDetailPanel.classList.add('hidden');
  }
  elTrendsPanel.classList.toggle('hidden', !open);
  elTrendsToggle.classList.toggle('active', open);
  const appBody = document.querySelector('.app-body');
  appBody.classList.toggle('trends-open', open);
  syncPanelOpenClass();
}

function syncPanelOpenClass() {
  const anyOpen = !elDetailPanel.classList.contains('hidden') ||
                  !elTrendsPanel.classList.contains('hidden');
  document.querySelector('.app-body').classList.toggle('panel-open', anyOpen);
}

function buildTrendsList() {
  if (elTrendsPanel.classList.contains('hidden')) return; // don't build if not visible

  const br   = appState.selectedBedroom;
  const curY = appState.currentYear;
  const preY = appState.previousYear;

  // Update subtitle
  const stateLabel = appState.selectedStateCode || '—';
  elTrendsSubtitle.textContent =
    `FY ${preY} → FY ${curY}  ·  ${stateLabel}  ·  ${BEDROOM_LABELS[br].short}`;

  if (!appState.selectedStateCode || appState.areaByFips.size === 0) {
    elTrendsList.innerHTML = '<div class="trends-empty">Select a state to see year-over-year rent change rankings.</div>';
    elTrendsSummary.classList.add('hidden');
    return;
  }

  // Collect unique areas (deduplicate metros that span multiple counties)
  const seen = new Set();
  const rows = [];

  for (const [fips, area] of appState.areaByFips) {
    const id = area.fips_code || area.cbsacode || area.entity_id;
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const currEntry = appState.fmrData.get(fmrKey(id, curY));
    const prevEntry = appState.fmrData.get(fmrKey(id, preY));
    const cv = extractRent(currEntry, br);
    const pv = extractRent(prevEntry, br);

    if (cv == null || pv == null || pv === 0) continue;

    const diff = cv - pv;
    const pct  = (diff / pv) * 100;
    const name = area.area_name || area.town_name || area.county_name || 'Unknown';

    rows.push({ fips, area, id, name, cv, pv, diff, pct });
  }

  if (rows.length === 0) {
    elTrendsList.innerHTML = '<div class="trends-empty">No year-over-year data available for this state and year combination.</div>';
    elTrendsSummary.classList.add('hidden');
    return;
  }

  // Sort highest increase first
  rows.sort((a, b) => b.pct - a.pct);

  // Summary stats
  const avgPct   = rows.reduce((s, r) => s + r.pct, 0) / rows.length;
  const maxRow   = rows[0];
  const minRow   = rows[rows.length - 1];
  const numUp    = rows.filter(r => r.diff > 0).length;
  const numDown  = rows.filter(r => r.diff < 0).length;

  elTrendsSummary.classList.remove('hidden');
  elTrendsSummary.innerHTML = `
    <div class="trend-stat">
      <span class="trend-stat-label">State Avg</span>
      <span class="trend-stat-value ${avgPct > 0 ? 'is-up' : avgPct < 0 ? 'is-down' : 'is-flat'}">
        ${avgPct > 0 ? '▲' : avgPct < 0 ? '▼' : '—'} ${Math.abs(avgPct).toFixed(1)}%
      </span>
    </div>
    <div class="trend-stat">
      <span class="trend-stat-label">Areas Up</span>
      <span class="trend-stat-value is-up">${numUp}</span>
    </div>
    <div class="trend-stat">
      <span class="trend-stat-label">Areas Down</span>
      <span class="trend-stat-value is-down">${numDown}</span>
    </div>
    <div class="trend-stat">
      <span class="trend-stat-label">Total Areas</span>
      <span class="trend-stat-value">${rows.length}</span>
    </div>`;

  // Build list HTML
  const increases = rows.filter(r => r.diff > 0);
  const flat      = rows.filter(r => r.diff === 0);
  const decreases = rows.filter(r => r.diff < 0);

  let html = '';
  let incRank = 1;

  if (increases.length) {
    html += `<div class="trends-section-label">▲ Increases (${increases.length})</div>`;
    for (const r of increases) {
      html += trendRowHTML(r, incRank++);
    }
  }
  if (flat.length) {
    html += `<div class="trends-section-label">— No Change (${flat.length})</div>`;
    for (const r of flat) html += trendRowHTML(r, null);
  }
  if (decreases.length) {
    // decreases are already at the end of sorted array, reverse for "least decrease" first
    html += `<div class="trends-section-label">▼ Decreases (${decreases.length})</div>`;
    for (const r of decreases) html += trendRowHTML(r, null);
  }

  elTrendsList.innerHTML = html;

  // Attach click handlers
  elTrendsList.querySelectorAll('.trend-row').forEach(el => {
    el.addEventListener('click', () => {
      const fips = el.dataset.fips;
      const area = appState.areaByFips.get(fips);
      if (area) {
        // Open the detail panel first so the map resizes to its final dimensions,
        // then fly — otherwise flyToBounds targets the pre-resize centre.
        selectArea(area, fips);
        const poly = appState.polygonsByFips.get(fips);
        if (poly) {
          setTimeout(() => {
            map.invalidateSize({ animate: false });
            map.flyToBounds(poly.getBounds().pad(0.3), { duration: 0.6 });
          }, 30);
        }
      }
    });
  });

  // Highlight selected row if any
  refreshTrendsSelection();
}

function trendRowHTML(r, rank) {
  const cls  = r.diff > 0 ? 'is-up' : r.diff < 0 ? 'is-down' : 'is-flat';
  const arrow= r.diff > 0 ? '▲' : r.diff < 0 ? '▼' : '—';
  const pct  = Math.abs(r.pct).toFixed(1) + '%';
  const dol  = (r.diff > 0 ? '+' : '') + fmt(r.diff);
  const rankStr = rank != null ? `#${rank}` : '';
  return `<div class="trend-row" data-fips="${r.fips}">
    <span class="trend-rank">${rankStr}</span>
    <div class="trend-info">
      <div class="trend-name">${r.name}</div>
      <div class="trend-rents">${fmt(r.pv)} → ${fmt(r.cv)}</div>
    </div>
    <div class="trend-change ${cls}">
      <span class="trend-pct">${arrow} ${pct}</span>
      <span class="trend-dollar">${dol}</span>
    </div>
  </div>`;
}

function refreshTrendsSelection() {
  elTrendsList.querySelectorAll('.trend-row').forEach(el => {
    el.classList.toggle('selected', el.dataset.fips === appState.selectedAreaId);
  });
}

// ── Event listeners ───────────────────────────────────
elStateSelect.addEventListener('change', e => loadState(e.target.value));

elYearSelect.addEventListener('change', async e => {
  appState.currentYear  = +e.target.value;
  appState.previousYear = appState.currentYear - 1;
  elCurrentYearLbl.textContent = `FY ${appState.currentYear}`;
  elPrevYearLbl.textContent    = `FY ${appState.previousYear}`;
  // If MRVP mode is on but the new year has no MRVP data, turn it off
  if (appState.mrvpMode && !MRVP_YEARS.has(appState.currentYear)) {
    appState.mrvpMode = false;
  }
  updateAltButton();
  const prevAreaId = appState.selectedAreaId;
  if (appState.selectedStateCode) {
    await loadState(appState.selectedStateCode, { skipZoom: !!prevAreaId });
    if (prevAreaId) {
      const area = appState.areaByFips.get(prevAreaId);
      if (area) {
        const savedTrendsWasOpen = appState.trendsWasOpen;
        await selectArea(area, prevAreaId);
        appState.trendsWasOpen = savedTrendsWasOpen;
        // Close the panel if the new year has no data for this county
        if (elFmrContent.querySelector('.error-state')) {
          elDetailPanel.classList.add('hidden');
          syncPanelOpenClass();
          setTimeout(() => map.invalidateSize({ animate: false }), 30);
        }
      }
    }
  }
});

elBedroomSelect.addEventListener('change', e => {
  appState.selectedBedroom = e.target.value;
  refreshPolygonStyles();
  buildTrendsList();
  if (appState.selectedAreaId) {
    const area = appState.areaByFips.get(appState.selectedAreaId);
    if (area) {
      const id = area.fips_code || area.cbsacode || area.entity_id;
      const curr = appState.fmrData.get(fmrKey(id, appState.currentYear));
      const prev = appState.fmrData.get(fmrKey(id, appState.previousYear));
      renderPanel(curr, prev);
    }
  }
});

elTrendsToggle.addEventListener('click', () => {
  toggleTrendsPanel();
  buildTrendsList();
  setTimeout(() => map.invalidateSize({ animate: false }), 250);
});

elCloseTrends.addEventListener('click', () => {
  toggleTrendsPanel(false);
  setTimeout(() => {
    // Counteract Leaflet's re-centring pan: the map grows leftward by the
    // panel width, so pan right by half that amount to keep the view stable.
    const TRENDS_W = window.innerWidth <= 1100 ? 0 : 320;
    map.invalidateSize({ animate: false, pan: false });
    if (TRENDS_W > 0) map.panBy([-TRENDS_W / 2, 0], { animate: false });
  }, 250);
});

elClosePanel.addEventListener('click', () => {
  elDetailPanel.classList.add('hidden');
  syncPanelOpenClass();
  if (isMobile() && appState.trendsWasOpen) {
    appState.trendsWasOpen = false;
    toggleTrendsPanel(true);
    buildTrendsList();
    setTimeout(() => {
      map.invalidateSize({ animate: false });
      if (appState.geojsonLayer) map.fitBounds(safeBounds(appState.geojsonLayer).pad(0.05));
    }, 50);
  }
  setTimeout(() => map.invalidateSize({ animate: false }), 30);
  if (appState.selectedAreaId) {
    const prev = appState.selectedAreaId;
    appState.selectedAreaId = null;   // clear first so styleFeature returns unselected style
    deselectMetroPolygons(prev);
  }
});

document.querySelectorAll('.year-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.year-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    appState.activeTab = tab.dataset.tab;
    if (appState.selectedAreaId) {
      const area = appState.areaByFips.get(appState.selectedAreaId);
      if (area) {
        const id = area.fips_code || area.cbsacode || area.entity_id;
        const curr = appState.fmrData.get(fmrKey(id, appState.currentYear));
        const prev = appState.fmrData.get(fmrKey(id, appState.previousYear));
        renderPanel(curr, prev);
      }
    }
  });
});

// ── Alt-view toggle (MRVP for MA, ZIP/SAFMR for other states) ─────────────
elSafmrToggle.addEventListener('click', () => {
  const state = appState.selectedStateCode;
  if (state === 'MA') {
    appState.mrvpMode = !appState.mrvpMode;
    updateAltButton();
    if (appState.mrvpMode) {
      loadMrvpState(state);
    } else {
      loadState(state);
    }
  } else {
    appState.safmrMode = !appState.safmrMode;
    updateAltButton();
    if (appState.safmrMode) {
      loadSafmrState(state);
    } else {
      loadState(state);
    }
  }
});

// ── Theme ──────────────────────────────────────────────
const elThemeToggle = document.getElementById('themeToggle');

function applyTheme(theme, save = true) {
  document.documentElement.dataset.theme = theme;
  elThemeToggle.textContent = theme === 'light' ? '🌙' : '☀';
  elThemeToggle.title = theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode';

  // Swap map tile layers
  const urls = TILES[theme];
  tileBase.setUrl(urls.base);
  tileLabels.setUrl(urls.labels);

  // Refresh polygon strokes so they match the new background
  if (appState.geojsonLayer) refreshPolygonStyles();
  if (appState.statesLayer)  refreshStatesLayer();

  if (save) localStorage.setItem('fmrmap_theme', theme);
}

elThemeToggle.addEventListener('click', () => {
  applyTheme(isLight() ? 'dark' : 'light');
});

// Apply saved or system preference on load
const savedTheme = localStorage.getItem('fmrmap_theme');
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
applyTheme(savedTheme || (prefersDark ? 'dark' : 'light'), false);

// ── Splash screen ─────────────────────────────────────
function showSplash() { elSplashScreen.classList.remove('hidden'); }
function hideSplash() {
  elSplashScreen.classList.add('hidden');
  localStorage.setItem('fmrmap_seen', '1');
}

elSplashClose.addEventListener('click', hideSplash);
elSplashBackdrop.addEventListener('click', hideSplash);
elAboutBtn.addEventListener('click', showSplash);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !elSplashScreen.classList.contains('hidden')) hideSplash();
});

// Show on first visit; skip on return visits
if (!localStorage.getItem('fmrmap_seen')) showSplash();
else elSplashScreen.classList.add('hidden');

// ── Go ────────────────────────────────────────────────
init();

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

// ── Map init ─────────────────────────────────────────
const map = L.map('map', {
  center: [39.5, -98.35],
  zoom: 4,
  zoomControl: true,
  attributionControl: true,
});

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/">CARTO</a>',
  subdomains: 'abcd', maxZoom: 19,
}).addTo(map);

// Labels on top pane
const labelPane = map.createPane('labels');
labelPane.style.zIndex = 450;
labelPane.style.pointerEvents = 'none';
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
  attribution: '', subdomains: 'abcd', maxZoom: 19, pane: 'labels',
}).addTo(map);

// ── Helpers ──────────────────────────────────────────
const fmt = n => (n == null || n === 0) ? 'N/A' : '$' + Math.round(n).toLocaleString();

function getRentColor(amount) {
  if (!amount) return '#0d1b2a';
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
  // Load years
  try {
    const years = await api('/api/years');
    elYearSelect.innerHTML = '';
    for (const y of years) {
      const o = document.createElement('option');
      o.value = y; o.textContent = `FY ${y}`;
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
    elStateSelect.innerHTML = '<option value="">— Select a state —</option>';
    for (const s of states) {
      const o = document.createElement('option');
      o.value = s.state_code; o.textContent = s.state_name;
      elStateSelect.appendChild(o);
    }
    // Pre-select MA
    const ma = [...elStateSelect.options].find(o => o.value === 'MA');
    if (ma) { ma.selected = true; loadState('MA'); }
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
  elStateSelect.innerHTML = '<option value="">— Select a state —</option>';
  for (const [c,n] of S) {
    const o = document.createElement('option'); o.value=c; o.textContent=n; elStateSelect.appendChild(o);
  }
}

// ── States outline layer ──────────────────────────────
function stateStyle(feature) {
  const isSelected = appState.fipsToState[feature.id] === appState.selectedStateCode;
  return {
    fillColor:   '#4fd1c5',
    fillOpacity: isSelected ? 0.04 : 0.01, // near-zero but non-zero so SVG hit-testing works
    color:       isSelected ? '#4fd1c5' : '#2e3d5a',
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

// ── Load a state ─────────────────────────────────────
async function loadState(stateCode) {
  if (!stateCode) return;
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

    // Load GeoJSON + HUD county list + FMR data in parallel
    const [geojson, countiesResp] = await Promise.all([
      fetch(`/data/counties/${stateFipsCode}.json`).then(r => r.ok ? r.json() : Promise.reject('GeoJSON not found')),
      api(`/api/counties/${stateCode}`),
    ]);

    appState.counties = countiesResp.data || countiesResp;

    // Build a name→FIPS lookup from GeoJSON for metro matching
    const nameToFips = new Map();
    for (const f of geojson.features) {
      const name = f.properties.NAME.toLowerCase();
      nameToFips.set(name, f.id);
      // Also store "X county" variant
      nameToFips.set(name + ' county', f.id);
    }

    // Build areaByFips: for each HUD area, figure out which FIPS polygons it covers
    for (const area of appState.counties) {
      const entityId = area.fips_code || area.cbsacode || area.entity_id;

      if (area.metro_status === '0' || !area.metro_status) {
        // Non-metro county: use first 5 digits of the 10-digit HUD fips_code
        const fips = (area.fips_code || '').toString().slice(0, 5);
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
        // Also try direct FIPS if available
        if (area.fips_code) {
          appState.areaByFips.set(area.fips_code.toString().padStart(5,'0'), area);
        }
      }
    }

    // Load FMR data for both years
    showOverlay('Loading rent data…');
    await Promise.allSettled([
      loadStateFmr(stateCode, appState.currentYear),
      loadStateFmr(stateCode, appState.previousYear),
    ]);

    // Render the choropleth
    renderPolygons(geojson);
    refreshStatesLayer();
    hideOverlay();

  } catch (e) {
    hideOverlay();
    console.error(e);
    elMapMessage.classList.remove('hidden');
    elMapMessage.querySelector('p').textContent = `Error: ${e.message || e}`;
  }
}

async function loadStateFmr(stateCode, year) {
  try {
    const data     = await api(`/api/fmr-state/${stateCode}?year=${year}`);
    // HUD statedata returns { data: { metroareas: [...], counties: [...] } }
    const inner      = data.data || data;
    const counties   = inner.counties   || [];
    const metroareas = inner.metroareas || [];
    for (const area of [...counties, ...metroareas]) {
      const id = area.fips_code || area.code || area.cbsacode || area.entity_id;
      if (id) appState.fmrData.set(fmrKey(id, year), { data: area });
    }
  } catch (e) { console.warn(`State FMR ${stateCode}/${year}:`, e.message); }
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
function renderPolygons(geojson) {
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
  }

  const layer = L.geoJSON(geojson, {
    style: feature => styleFeature(feature),
    onEachFeature: (feature, layer) => {
      const fips = feature.id;
      appState.polygonsByFips.set(fips, layer);

      const area = appState.areaByFips.get(fips);
      const rent = area ? getRentForArea(area) : null;
      const name = area?.area_name || area?.county_name || feature.properties.NAME;

      layer.bindTooltip(buildTooltip(name, rent), {
        className: 'fmr-tooltip', sticky: true, offset: [10, 0],
      });

      layer.on({
        mouseover: e => { if (!appState.mapAnimating && fips !== appState.selectedAreaId) highlightLayer(e.target); },
        mouseout:  e => { if (fips !== appState.selectedAreaId) layer.setStyle(styleFeature(feature)); },
        click:     () => {
          if (area) selectArea(area, fips);
        },
      });
    },
  });

  appState.geojsonLayer = layer.addTo(map);
  appState.mapAnimating = true;
  map.once('moveend', () => { appState.mapAnimating = false; });
  map.fitBounds(layer.getBounds().pad(0.05));
}

function styleFeature(feature) {
  const fips  = feature.id;
  const area  = appState.areaByFips.get(fips);
  const rent  = area ? getRentForArea(area) : null;
  const isSelected = fips === appState.selectedAreaId;
  return {
    fillColor:   getRentColor(rent),
    fillOpacity: rent ? 0.78 : 0.15,
    color:       isSelected ? '#4fd1c5' : '#0d1b2a',
    weight:      isSelected ? 2.5 : 0.6,
    opacity:     1,
  };
}

function highlightLayer(layer) {
  layer.setStyle({ weight: 2, color: '#a0e4dc', fillOpacity: 0.9 });
  layer.bringToFront();
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
      color:       isSelected ? '#4fd1c5' : '#0d1b2a',
      weight:      isSelected ? 2.5 : 0.6,
    });

    // Update tooltip content
    const name = area?.area_name || area?.county_name || layer.feature?.properties?.NAME;
    layer.setTooltipContent(buildTooltip(name, rent));
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
  const name = area.area_name || area.county_name || area.town_name || 'Unknown';
  const stateLabel = area.state_code || appState.selectedStateCode;

  elAreaName.textContent   = name;
  elAreaState.textContent  = stateLabel;
  elCurrentYearLbl.textContent = `FY ${appState.currentYear}`;
  elPrevYearLbl.textContent    = `FY ${appState.previousYear}`;
  elDetailPanel.classList.remove('hidden');
  showPanelLoading();

  const [curr, prev] = await Promise.all([
    loadEntityFmr(entityId, appState.currentYear),
    loadEntityFmr(entityId, appState.previousYear),
  ]);

  elMetroStatus.textContent = area.metro_status === '1'
    ? `Metro area · ${area.metro_name || ''}`
    : 'Non-metropolitan county';

  renderPanel(curr, prev);
}

function highlightAreaPolygons(area, clickedFips) {
  // For metros: color all constituent county polygons
  for (const [fips, a] of appState.areaByFips) {
    const id = a.fips_code || a.cbsacode || a.entity_id;
    const clickedId = area.fips_code || area.cbsacode || area.entity_id;
    if (id === clickedId) {
      const poly = appState.polygonsByFips.get(fips);
      if (poly) {
        poly.setStyle({ weight: 2.5, color: '#4fd1c5', fillOpacity: 0.88 });
        poly.bringToFront();
      }
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

// ── Event listeners ───────────────────────────────────
elStateSelect.addEventListener('change', e => loadState(e.target.value));

elYearSelect.addEventListener('change', e => {
  appState.currentYear  = +e.target.value;
  appState.previousYear = appState.currentYear - 1;
  elCurrentYearLbl.textContent = `FY ${appState.currentYear}`;
  elPrevYearLbl.textContent    = `FY ${appState.previousYear}`;
  appState.fmrData.clear();
  if (appState.selectedStateCode) loadState(appState.selectedStateCode);
});

elBedroomSelect.addEventListener('change', e => {
  appState.selectedBedroom = e.target.value;
  refreshPolygonStyles();
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

elClosePanel.addEventListener('click', () => {
  elDetailPanel.classList.add('hidden');
  if (appState.selectedAreaId) {
    deselectMetroPolygons(appState.selectedAreaId);
    appState.selectedAreaId = null;
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

// ── Go ────────────────────────────────────────────────
init();

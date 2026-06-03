require('dotenv').config();
const express    = require('express');
const fetch      = require('node-fetch');
const compression = require('compression');
const path       = require('path');

const app      = express();
const PORT     = process.env.PORT || 3000;
const HUD_TOKEN = process.env.HUD_API_TOKEN || '';
const HUD_BASE  = 'https://www.huduser.gov/hudapi/public';

app.use(compression());
app.use(express.static(path.join(__dirname, '../public')));

// ── In-memory cache ──────────────────────────────────
const cache   = new Map();
const CACHE_TTL = 1000 * 60 * 60 * 24; // 24 h

function cached(key, fetchFn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.timestamp < CACHE_TTL) return Promise.resolve(hit.data);
  return fetchFn().then(data => {
    cache.set(key, { data, timestamp: Date.now() });
    return data;
  });
}

async function hudGet(p) {
  if (!HUD_TOKEN) throw new Error('HUD_API_TOKEN not set — add it to .env');
  const res = await fetch(`${HUD_BASE}${p}`, {
    headers: { Authorization: `Bearer ${HUD_TOKEN}` },
  });
  if (!res.ok) throw new Error(`HUD API ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── State → FIPS lookup (served to client) ───────────
const STATE_FIPS = {
  AL:'01',AK:'02',AZ:'04',AR:'05',CA:'06',CO:'08',CT:'09',DE:'10',
  FL:'12',GA:'13',HI:'15',ID:'16',IL:'17',IN:'18',IA:'19',KS:'20',
  KY:'21',LA:'22',ME:'23',MD:'24',MA:'25',MI:'26',MN:'27',MS:'28',
  MO:'29',MT:'30',NE:'31',NV:'32',NH:'33',NJ:'34',NM:'35',NY:'36',
  NC:'37',ND:'38',OH:'39',OK:'40',OR:'41',PA:'42',RI:'44',SC:'45',
  SD:'46',TN:'47',TX:'48',UT:'49',VT:'50',VA:'51',WA:'53',WV:'54',
  WI:'55',WY:'56',DC:'11',PR:'72',
};

app.get('/api/state-fips', (_req, res) => res.json(STATE_FIPS));

// ── HUD endpoints ─────────────────────────────────────
app.get('/api/states', async (_req, res) => {
  try {
    res.json(await cached('states', () => hudGet('/fmr/listStates')));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/counties/:stateCode', async (req, res) => {
  const { stateCode } = req.params;
  try {
    res.json(await cached(`counties_${stateCode}`, () => hudGet(`/fmr/listCounties/${stateCode}`)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/fmr/:entityId', async (req, res) => {
  const { entityId } = req.params;
  const year = req.query.year || new Date().getFullYear();
  try {
    res.json(await cached(`fmr_${entityId}_${year}`, () => hudGet(`/fmr/data/${entityId}?year=${year}`)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/fmr-state/:stateCode', async (req, res) => {
  const { stateCode } = req.params;
  const year = req.query.year || new Date().getFullYear();
  try {
    res.json(await cached(`fmr_state_${stateCode}_${year}`, () => hudGet(`/fmr/statedata/${stateCode}?year=${year}`)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/years', (_req, res) => {
  const cur = new Date().getFullYear();
  const years = [];
  for (let y = cur; y >= 2017; y--) years.push(y);
  res.json(years);
});

app.listen(PORT, () => {
  console.log(`FMR Map → http://localhost:${PORT}`);
  if (!HUD_TOKEN) console.warn('⚠  HUD_API_TOKEN not set — set it in .env');
});

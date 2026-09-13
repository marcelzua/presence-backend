// presence. backend — RA scraper + Supabase manual events
// Run: node server.js

const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const PORT = process.env.PORT || 3000;
const CACHE_FILE = path.join(__dirname, 'data', 'events-cache.json');
const REFRESH_MS = 20 * 60 * 1000;

// --- Supabase config ---
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nidysnffspddrptfqaez.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_-GPaui7_Cf4f_F9QAuH1MQ_WcZUTk93';

// RA area IDs — discovered and validated against returned venue addresses.
// Brno, Florence, Milano, Valencia unresolved: outside the scanned ID range.
const CITY_IDS = {
  amsterdam: 29,
  athens: 37,
  barcelona: 20,
  berlin: 34,
  brussels: 62,
  budapest: 78,
  copenhagen: 99,
  helsinki: 87,
  london: 13,
  lyon: 63,
  madrid: 41,
  marseille: 156,
  moscow: 88,
  naples: 85,
  oslo: 57,
  paris: 44,
  prague: 97,
  rome: 25,
  stockholm: 58,
  turin: 171,
  vienna: 450,
  warsaw: 69,
  zagreb: 94,
  brno: 676,
  florence: 348,
  milano: 347,
  valencia: 607,
};

const venuesSeed = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'venues-seed.json'), 'utf8')
).venues;

fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch { return {}; }
}
function saveCache(c) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2)); }
  catch (e) { console.warn('[cache] write failed (read-only fs?):', e.message); }
}

// ---------- SUPABASE: manually added events ----------
async function fetchSupabaseEvents(city) {
  try {
    const url = `${SUPABASE_URL}/rest/v1/events?city=ilike.${encodeURIComponent(city)}&select=*`;
    const res = await fetch(url, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      },
    });
    if (!res.ok) {
      console.warn(`[supabase] ${city} responded ${res.status}`);
      return [];
    }
    const rows = await res.json();
    return rows.map(r => {
      let dayOffset = 0;
      if (r.date) {
        const evDay = new Date(r.date); evDay.setHours(0,0,0,0);
        const today = new Date(); today.setHours(0,0,0,0);
        dayOffset = Math.round((evDay.getTime() - today.getTime()) / 86400000);
      }
      return {
        id: r.id,
        name: r.name,
        venue: r.venue || 'TBA',
        address: r.address || city,
        lat: r.lat || 0,
        lng: r.lng || 0,
        date: r.date || new Date().toISOString(),
        timeStart: r.time_start || '20:00',
        genres: r.genres || ['community'],
        tags: r.tags || [],
        source: r.source || 'native',
        sourceLabel: r.source_label || 'presence',
        sourceUrl: r.source_url || '',
        description: r.description || '',
        going: r.going || 0,
        maybe: 0, avoid: 0,
        localScore: r.local_score || 80,
        realScore: r.real_score || 90,
        vibeChecks: [],
        visibility: 'public',
        dayOffset,
      };
    });
  } catch (e) {
    console.warn('[supabase] fetch failed:', e.message);
    return [];
  }
}

// ---------- RESIDENT ADVISOR ----------
async function fetchRAByAreaId(city, cityId) {
  if (!cityId) return [];
  const today = new Date().toISOString().split('T')[0];
  const twoWeeks = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0];

  try {
    const res = await fetch('https://ra.co/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://ra.co/events',
        'Origin': 'https://ra.co',
      },
      body: JSON.stringify({
        operationName: 'GET_EVENT_LISTINGS',
        query: `query GET_EVENT_LISTINGS($filters: FilterInputDtoInput, $filterOptions: FilterOptionsInputDtoInput, $pageSize: Int, $page: Int, $sort: SortInputDtoInput) {
          eventListings(filters: $filters, filterOptions: $filterOptions, pageSize: $pageSize, page: $page, sort: $sort) {
            data { id event { id title date startTime endTime contentUrl
              venue { id name address } images { filename } } }
            totalResults
          }
        }`,
        variables: {
          filters: {
            areas: { eq: cityId },
            listingDate: { gte: today, lte: twoWeeks },
          },
          filterOptions: { genre: true, eventType: true },
          pageSize: 100,
          page: 1,
          sort: { listingDate: { order: 'ASCENDING' } },
        },
      }),
    });
    if (!res.ok) { console.warn(`[RA] ${city} responded ${res.status}`); return []; }
    const data = await res.json();
    if (data.errors) { console.warn('[RA] errors:', JSON.stringify(data.errors).slice(0,200)); return []; }

    const listings = data?.data?.eventListings?.data || [];
    const total = data?.data?.eventListings?.totalResults;
    console.log(`[RA] ${city}: ${listings.length} returned, totalResults=${total}`);
    const seen = new Set();
    const unique = listings.filter(item => {
      const id = item?.event?.id;
      if (!id || seen.has(id)) return false;
      seen.add(id); return true;
    });

    return unique.map(item => {
      const ev = item.event;
      let timeStart = '22:00';
      if (ev.startTime) {
        const m = String(ev.startTime).match(/T(\d{2}:\d{2})/);
        if (m) timeStart = m[1];
        else if (/^\d{2}:\d{2}/.test(ev.startTime)) timeStart = ev.startTime.slice(0,5);
      }
      let dayOffset = 0;
      if (ev.date) {
        const evDay = new Date(ev.date); evDay.setHours(0,0,0,0);
        const today2 = new Date(); today2.setHours(0,0,0,0);
        dayOffset = Math.round((evDay.getTime() - today2.getTime()) / 86400000);
      }
      return {
        id: `ra-${ev.id}`,
        name: ev.title || 'Untitled',
        venue: ev.venue?.name || 'TBA',
        address: ev.venue?.address || city,
        lat: 0, lng: 0,
        date: ev.date || new Date().toISOString(),
        timeStart,
        genres: ['electronic', 'club'],
        tags: [],
        source: 'ra', sourceLabel: 'RA',
        sourceUrl: `https://ra.co${ev.contentUrl || ''}`,
        description: '',
        going: 0, maybe: 0, avoid: 0,
        localScore: 85, realScore: 95,
        vibeChecks: [],
        visibility: 'public',
        dayOffset,
      };
    });
  } catch (e) {
    console.warn(`[RA] ${city} fetch failed:`, e.message);
    return [];
  }
}

async function fetchRA(city) {
  const id = CITY_IDS[city.toLowerCase()];
  if (!id) {
    console.warn('[RA] ' + city + ': no area id configured');
    return [];
  }
  return fetchRAByAreaId(city, id);
}
// Match venue names to seed coordinates for map placement
// ---------- GEOCODING (Nominatim) ----------
const GEO_FILE = path.join(__dirname, 'data', 'geocache.json');

function loadGeo() {
  try { return JSON.parse(fs.readFileSync(GEO_FILE, 'utf8')); }
  catch { return {}; }
}
function saveGeo(g) {
  try { fs.writeFileSync(GEO_FILE, JSON.stringify(g, null, 2)); }
  catch (e) { console.warn('[geo] cache write failed:', e.message); }
}

const geoCache = loadGeo();
let geoDirty = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function cleanAddress(addr, city) {
  if (!addr) return null;
  let a = String(addr).replace(/;/g, ',').replace(/\s+/g, ' ').trim();
  if (a.length < 4) return null;
  if (!a.toLowerCase().includes(city.toLowerCase())) a += ', ' + city;
  return a;
}

async function geocodeOne(address) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q='
    + encodeURIComponent(address);
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'presence-app/1.0 (event discovery; contact: marcell.szuha@gmail.com)',
      'Accept': 'application/json',
    },
  });
  if (!res.ok) throw new Error('nominatim ' + res.status);
  const json = await res.json();
  if (!json.length) return null;
  return { lat: parseFloat(json[0].lat), lng: parseFloat(json[0].lon) };
}

async function geocodeEvents(events, city) {
  let looked = 0;
  for (const ev of events) {
    if (ev.lat && ev.lng) continue;
    const key = cleanAddress(ev.address, city);
    if (!key) continue;

    if (geoCache[key] !== undefined) {
      const hit = geoCache[key];
      if (hit) { ev.lat = hit.lat; ev.lng = hit.lng; }
      continue;
    }

    if (looked >= 25) continue;

    try {
      await sleep(1100);
      const coords = await geocodeOne(key);
      geoCache[key] = coords;
      geoDirty = true;
      looked++;
      if (coords) { ev.lat = coords.lat; ev.lng = coords.lng; }
    } catch (e) {
      console.warn('[geo] failed:', key, e.message);
    }
  }
  if (geoDirty) { saveGeo(geoCache); geoDirty = false; }
  const placed = events.filter(e => e.lat && e.lng).length;
  console.log('[geo] ' + city + ': ' + placed + '/' + events.length + ' placed (' + looked + ' new lookups)');
  return events;
}
function enrichWithCoords(events, city) {
  return events.map(ev => {
    if (ev.lat && ev.lng) return ev; // already has coords
    const match = venuesSeed.find(v =>
      v.city.toLowerCase() === city.toLowerCase() &&
      (v.name.toLowerCase().includes(ev.venue.toLowerCase()) ||
       ev.venue.toLowerCase().includes(v.name.toLowerCase()))
    );
    return match ? { ...ev, lat: match.lat, lng: match.lng } : ev;
  });
}

async function refreshCity(city) {
  console.log(`[refresh] ${city}...`);
  const [raEvents, supaEvents] = await Promise.all([
    fetchRA(city),
    fetchSupabaseEvents(city),
  ]);
  // Manual Supabase events take priority — they're curated
  // Seed-file coords are instant. Anything already in the geocache is instant too.
  const seeded = enrichWithCoords(raEvents, city);
  applyGeoCache(seeded, city);
  const merged = [...supaEvents, ...seeded];
  const cache = loadCache();
  cache[city.toLowerCase()] = { events: merged, updatedAt: Date.now() };
  saveCache(cache);
  console.log(`[refresh] ${city}: ${supaEvents.length} manual + ${raEvents.length} RA = ${merged.length}`);
  return merged;
}

// Fill in coords we already know, and queue anything still missing.
// Never blocks the response.
function applyGeoCache(events, city) {
  const missing = [];
  for (const ev of events) {
    if (ev.lat && ev.lng) continue;
    const key = cleanAddress(ev.address, city);
    if (!key) continue;
    const hit = geoCache[key];
    if (hit) { ev.lat = hit.lat; ev.lng = hit.lng; }
    else if (hit === undefined) missing.push({ ev, key, city });
  }
  if (missing.length) { console.log('[geo] queuing ' + missing.length + ' for ' + city); queueGeocode(missing); }
  return events;
}

// --- background geocode queue, 1 request/sec, never blocks a response ---
const geoQueue = [];
let geoRunning = false;

function queueGeocode(items) {
  for (const it of items) {
    if (!geoQueue.some(q => q.key === it.key)) geoQueue.push(it);
  }
  if (!geoRunning) runGeoQueue();
}

async function runGeoQueue() {
  geoRunning = true;
  while (geoQueue.length) {
    const item = geoQueue.shift();
    if (geoCache[item.key] !== undefined) continue;
    try {
      await sleep(1100);
      console.log('[geo] lookup: ' + item.key);
      const coords = await geocodeOne(item.key);
      geoCache[item.key] = coords;
      saveGeo(geoCache);
      if (coords) {
        // write straight into the cached payload so the next request has it
        const entry = loadCache()[item.city.toLowerCase()];
        if (entry) {
          let touched = false;
          for (const e of entry.events) {
            if (!e.lat && cleanAddress(e.address, item.city) === item.key) {
              e.lat = coords.lat; e.lng = coords.lng; touched = true;
            }
          }
          if (touched) {
            const c = loadCache();
            c[item.city.toLowerCase()] = entry;
            saveCache(c);
          }
        }
      }
    } catch (e) {
      console.warn('[geo] failed:', item.key, e.message);
    }
  }
  geoRunning = false;
  console.log('[geo] queue drained');
}

// --- warm every city on boot so the first user never waits ---
async function warmAllCities() {
  const cities = Object.keys(CITY_IDS);
  console.log('[warm] preloading ' + cities.length + ' cities...');
  for (const c of cities) {
    try { await refreshCity(c); }
    catch (e) { console.warn('[warm] ' + c + ' failed:', e.message); }
  }
  console.log('[warm] done');
}
// ---------- ROUTES ----------
app.get('/events', async (req, res) => {
  const city = (req.query.city || 'budapest').toLowerCase();
  const cache = loadCache();
  const entry = cache[city];
  if (entry && Date.now() - entry.updatedAt < REFRESH_MS) {
    return res.json({ city, events: entry.events, cached: true, updatedAt: entry.updatedAt });
  }
  const events = await refreshCity(city);
  res.json({ city, events, cached: false, updatedAt: Date.now() });
});

app.get('/venues', (req, res) => {
  const city = req.query.city;
  const filtered = city
    ? venuesSeed.filter(v => v.city.toLowerCase() === city.toLowerCase())
    : venuesSeed;
  res.json({ venues: filtered });
});

app.get('/', (req, res) => {
  res.json({
    status: 'presence. backend running',
    endpoints: ['/events?city=budapest', '/venues?city=budapest'],
    supabase: SUPABASE_URL ? 'configured' : 'missing',
  });
});

app.listen(PORT, () => {
  console.log(`presence. backend running on port ${PORT}`);
  console.log(`Supabase: ${SUPABASE_URL}`);
  // Warm all cities immediately so the first request is served from cache
  warmAllCities();
});

setInterval(() => {
  Object.keys(CITY_IDS).forEach(city => refreshCity(city));
}, REFRESH_MS);

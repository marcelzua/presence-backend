// presence. backend — RA scraper + Supabase manual events
// Run: node server.js

const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const CACHE_FILE = path.join(__dirname, 'data', 'events-cache.json');
const REFRESH_MS = 20 * 60 * 1000;

// --- Supabase config ---
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nidysnffspddrptfqaez.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_-GPaui7_Cf4f_F9QAuH1MQ_WcZUTk93';

// Verified RA area IDs. Berlin/London/Paris/Vienna confirmed.
// Unverified ones may return wrong-country results — see README.
const CITY_IDS = {
  berlin: 34, london: 13, paris: 44, vienna: 450,
  budapest: 12, barcelona: 20, warsaw: 55, amsterdam: 26,
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
async function fetchRA(city) {
  const cityId = CITY_IDS[city.toLowerCase()];
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
          pageSize: 250,
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

// Match venue names to seed coordinates for map placement
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
  const merged = [...supaEvents, ...enrichWithCoords(raEvents, city)];
  const cache = loadCache();
  cache[city.toLowerCase()] = { events: merged, updatedAt: Date.now() };
  saveCache(cache);
  console.log(`[refresh] ${city}: ${supaEvents.length} manual + ${raEvents.length} RA = ${merged.length}`);
  return merged;
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
});

setInterval(() => {
  Object.keys(CITY_IDS).forEach(city => refreshCity(city));
}, REFRESH_MS);

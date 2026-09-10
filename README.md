# presence. server pieces

## What's here

- `ra-scraper.js` — pulls real RA event listings for a city (working, tested endpoint)
- `venues-seed.json` — 21 real venues across 8 European cities, with addresses and calendar URLs
- Verified entries (Akvárium, Berghain, Kantine am Berghain) were confirmed via live search this session
- Unverified entries are real venues from general knowledge — spot-check the calendarUrl before relying on it, addresses should be accurate

## Running the RA scraper locally

```bash
cd presence-server
npm init -y
npm install node-fetch@2
node ra-scraper.js budapest
node ra-scraper.js berlin
```

This prints raw JSON of upcoming RA events for that city.

## Why this needs to run on a server, not in the app

RA blocks requests that don't look like a real browser. The scraper spoofs
browser headers — this works from Node.js on a server but not reliably from
inside React Native / Expo Go, and doing it client-side means every user's
phone hits RA directly, which will get rate-limited or blocked fast.

## Next step: turn this into a real backend

A minimal version:
1. This script runs on a schedule (cron, every 15-30 min) on a small server
2. Results get saved to a simple database (or even a JSON file to start)
3. Your app calls YOUR server's `/events?city=budapest` endpoint
4. Your server merges RA data + the venues-seed.json + anything else you add manually

This is maybe 100 lines of Express.js on top of what's already here.

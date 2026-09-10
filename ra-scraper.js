// RA (Resident Advisor) scraper — run with: node ra-scraper.js <city>
// Requires: npm install node-fetch

const CITY_IDS = {
  budapest: 12, berlin: 5, barcelona: 7, warsaw: 55,
  london: 13, amsterdam: 4, paris: 17, vienna: 90,
};

async function fetchRA(city) {
  const cityId = CITY_IDS[city.toLowerCase()];
  if (!cityId) throw new Error(`Unknown city: ${city}`);

  const today = new Date().toISOString().split('T')[0];
  const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];

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
      query: `query GET_EVENT_LISTINGS($filters: FilterInputDtoInput, $pageSize: Int, $page: Int) {
        eventListings(filters: $filters, pageSize: $pageSize, page: $page) {
          data {
            id
            event {
              id title date startTime endTime contentUrl
              venue { id name address { country city } }
              images { filename }
            }
          }
        }
      }`,
      variables: {
        filters: { areas: { eq: cityId }, listingDate: { gte: today, lte: nextWeek } },
        pageSize: 30,
        page: 1,
      },
    }),
  });

  if (!res.ok) throw new Error(`RA responded ${res.status}`);
  const data = await res.json();
  return data?.data?.eventListings?.data || [];
}

const city = process.argv[2] || 'budapest';
fetchRA(city)
  .then(events => {
    console.log(`Found ${events.length} events in ${city}`);
    console.log(JSON.stringify(events, null, 2));
  })
  .catch(err => console.error('Error:', err.message));

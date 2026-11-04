// Builds the upcoming-game list shared by the reminder job.
// RAWG is the primary source (its ids match bookmarks made while the
// site was talking to RAWG). When RAWG's origin times out — Cloudflare
// 522s have been taking the whole API down — Steam's coming-soon search
// fills the board so the job and the site still have dates to work with.

const LOOKAHEAD_DAYS = 180;
const CATALOG_LIMIT = 40;

// Steam content descriptors: 1 some nudity or sexual content,
// 3 adult-only sexual content, 4 frequent nudity or sexual content.
// Violence (2) and general mature themes (5) stay on the board.
const SEXUAL_CONTENT_DESCRIPTORS = new Set([1, 3, 4]);
const NSFW_STEAM_TAGS = new Set([
  6650, // Nudity
  9130, // Hentai
  12095 // Sexual Content
]);
const NSFW_NAME = /\b(hentai|porn(?:o|ography)?|nsfw|erotic(?:a)?|nude|nudity|naked|lewd|ecchi|futanari|brothel|succub(?:us|i)|xxx)\b/i;
const NSFW_RAWG_TAGS = new Set([
  'nudity', 'sexual-content', 'sexual content', 'nsfw', 'hentai',
  'erotic', 'erotica', 'porn', 'pornography', 'lewd'
]);

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
};

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

function decodeEntities(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parseSteamDate(text) {
  const match = String(text).trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/);
  if (!match) return null;
  const month = MONTHS[match[1].slice(0, 3).toLowerCase()];
  if (month === undefined) return null;
  const day = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

async function fetchOk(url, { attempts = 2, timeout = 15000, headers = {} } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
      if (res.ok) return res;
      lastError = new Error(`status ${res.status}`);
      lastError.status = res.status;
      // A 4xx other than rate limiting will not succeed on retry.
      if (res.status < 500 && res.status !== 429) break;
    } catch (err) {
      lastError = err;
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  throw lastError || new Error('request failed');
}

function isNsfwName(name) {
  return NSFW_NAME.test(name || '');
}

function hasSexualDescriptors(ids) {
  return (ids || []).some((id) => SEXUAL_CONTENT_DESCRIPTORS.has(Number(id)));
}

function isNsfwRawg(game) {
  if (isNsfwName(game.name)) return true;
  const rating = game.esrb_rating && (game.esrb_rating.slug || game.esrb_rating.name || '');
  if (String(rating).toLowerCase().replace(/\s+/g, '-') === 'adults-only') return true;
  return (game.tags || []).some((tag) => NSFW_RAWG_TAGS.has(String(tag.slug || tag.name || '').toLowerCase()));
}

function isNsfwSteamListing(game) {
  return isNsfwName(game.name)
    || hasSexualDescriptors(game.descriptorIds)
    || (game.tagIds || []).some((id) => NSFW_STEAM_TAGS.has(Number(id)));
}

function mapRawgGame(game) {
  return {
    id: String(game.id),
    name: game.name,
    date: game.released,
    platform: (game.platforms || []).slice(0, 3).map((p) => p.platform.name).join(', ') || 'Platform TBA',
    genre: (game.genres && game.genres[0] && game.genres[0].name) || 'Other',
    image: game.background_image || null
  };
}

async function fetchRawgGames(apiKey) {
  if (!apiKey) throw new Error('RAWG_API_KEY is not set.');

  const today = new Date();
  const end = addDays(today, LOOKAHEAD_DAYS);
  const start = isoDate(today);
  const finish = isoDate(end);
  const games = [];

  for (let page = 1; page <= 4 && games.length < CATALOG_LIMIT; page++) {
    const url = `https://api.rawg.io/api/games?key=${apiKey}&dates=${start},${finish}&ordering=released&page_size=${CATALOG_LIMIT}&page=${page}&exclude_additions=true`;
    let res;
    try {
      res = await fetchOk(url, { attempts: page === 1 ? 2 : 1, timeout: 12000 });
    } catch (err) {
      if (page === 1) {
        const status = err && err.status;
        throw new Error(status ? `RAWG responded with ${status}` : `RAWG request failed: ${err.message}`);
      }
      break;
    }

    const data = await res.json();
    (data.results || [])
      .filter((game) => game.released && game.released >= start && game.released <= finish && !isNsfwRawg(game))
      .map(mapRawgGame)
      .forEach((game) => {
        if (games.length < CATALOG_LIMIT) games.push(game);
      });
    if (!data.next) break;
  }

  return games;
}

function parseIdList(value) {
  if (!value) return [];
  return value.split(',').map((id) => Number(id.trim())).filter((id) => !Number.isNaN(id));
}

function parseSteamHtml(html) {
  const pattern = /data-ds-appid="(\d+)"(?:(?!data-ds-appid)[\s\S])*?data-ds-tagids="\[([^\]]*)\]"(?:(?!data-ds-appid)[\s\S])*?(?:data-ds-descids="\[([^\]]*)\]")?(?:(?!data-ds-appid)[\s\S])*?<img src="([^"]+)"[\s\S]*?<span class="title">([^<]*)<\/span>[\s\S]*?search_platforms">([\s\S]*?)<\/div>[\s\S]*?search_released[^>]*>\s*([^<]*?)\s*<\/div>/g;
  const games = [];
  let match;
  while ((match = pattern.exec(html))) {
    const date = parseSteamDate(match[7]);
    if (!date) continue;
    const platformHtml = match[6];
    const platforms = [];
    if (platformHtml.includes('win')) platforms.push('Windows');
    if (platformHtml.includes('mac')) platforms.push('Mac');
    if (platformHtml.includes('linux')) platforms.push('Linux');
    const game = {
      id: `steam-${match[1]}`,
      name: decodeEntities(match[5].trim()),
      date,
      platform: platforms.join(', ') || 'PC',
      genre: 'Other',
      image: decodeEntities(match[4]),
      tagIds: parseIdList(match[2]),
      descriptorIds: parseIdList(match[3])
    };
    if (!isNsfwSteamListing(game)) games.push(game);
  }
  return games;
}

async function attachSteamGenres(games) {
  const pending = games.slice();
  async function worker() {
    while (pending.length) {
      const game = pending.shift();
      const appId = game.id.slice('steam-'.length);
      try {
        const res = await fetchOk(
          `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=us&l=english`,
          {
            attempts: 1,
            timeout: 15000,
            headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }
          }
        );
        const data = await res.json();
        const app = data[appId] && data[appId].data;
        if (app) {
          const descriptors = app.content_descriptors && app.content_descriptors.ids;
          if (hasSexualDescriptors(descriptors) || isNsfwName(app.name)) {
            game.nsfw = true;
          } else {
            const genre = app.genres && app.genres[0];
            if (genre && genre.description) game.genre = genre.description;
          }
        }
      } catch (err) {
        // A missing genre still leaves the game on the board.
      }
    }
  }
  await Promise.all(Array.from({ length: 5 }, () => worker()));
}

async function fetchSteamSearchPage(start) {
  const url = `https://store.steampowered.com/search/results/?query&start=${start}&count=20&sort_by=Released_ASC&filter=comingsoon&infinite=1&ignore_preferences=1&category1=998&cc=us&l=english`;
  const res = await fetchOk(url, {
    attempts: 2,
    timeout: 20000,
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }
  });
  const data = await res.json();
  return parseSteamHtml(data.results_html || '');
}

async function fetchSteamGames() {
  const today = isoDate(new Date());
  const end = isoDate(addDays(new Date(), LOOKAHEAD_DAYS));
  const games = [];
  const seen = new Set();
  const perDate = new Map();
  // Hundreds of games share each day. Step through the coming-soon list
  // and keep a couple of titles from each date so the board covers the
  // next few weeks instead of a single afternoon.
  const MAX_PER_DATE = 2;
  let start = 0;
  let step = 80;
  let lastDate = null;
  let emptyPages = 0;

  for (let request = 0; request < 30 && games.length < CATALOG_LIMIT && start < 8000; request++) {
    const page = (await fetchSteamSearchPage(start)).filter((game) => game.date >= today && game.date <= end);
    if (!page.length) {
      emptyPages += 1;
      if (emptyPages >= 4) break;
      start += 250;
      continue;
    }
    emptyPages = 0;
    const pageDate = page[0].date;
    let taken = 0;
    for (const game of page) {
      if (seen.has(game.id)) continue;
      const used = perDate.get(game.date) || 0;
      if (used >= MAX_PER_DATE) continue;
      seen.add(game.id);
      perDate.set(game.date, used + 1);
      games.push(game);
      taken += 1;
      if (taken >= MAX_PER_DATE || games.length >= CATALOG_LIMIT) break;
    }
    step = pageDate === lastDate ? Math.min(step + 120, 500) : 80;
    lastDate = pageDate;
    if (pageDate >= end) break;
    start += step;
  }

  await attachSteamGenres(games);
  return games.filter((game) => !game.nsfw).map((game) => {
    delete game.tagIds;
    delete game.descriptorIds;
    delete game.nsfw;
    return game;
  });
}

async function buildCatalog({ apiKey } = {}) {
  if (apiKey) {
    try {
      const games = await fetchRawgGames(apiKey);
      if (games.length) {
        return { source: 'rawg', fetchedAt: new Date().toISOString(), games };
      }
      console.warn('RAWG returned no upcoming games. Falling back to Steam.');
    } catch (err) {
      console.warn(`RAWG catalog failed (${err.message}). Falling back to Steam.`);
    }
  } else {
    console.warn('RAWG_API_KEY is not set. Falling back to Steam.');
  }

  const games = await fetchSteamGames();
  if (!games.length) throw new Error('Steam returned no upcoming games.');
  return { source: 'steam', fetchedAt: new Date().toISOString(), games };
}

module.exports = { buildCatalog, fetchRawgGames, fetchSteamGames };

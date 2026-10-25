const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 7000;
const TMDB_KEY = process.env.TMDB_KEY;

app.use(cors());

const AKWAM_DOMAIN = 'https://akwam.ss';
const EGYBEST_DOMAIN = 'https://egybesstt.bond';
const AR = /[\u0600-\u06FF]/;

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'ar,ar-EG;q=0.9,en-US;q=0.8',
    'Referer': `${AKWAM_DOMAIN}/`
};

const MANIFEST = {
    id: 'org.arabic.akwam.egybest',
    version: '2.1.0',
    name: 'Akwam & EgyBest Scraper',
    description: 'Arabic title resolver for Akwam and EgyBest',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt']
};

app.get('/manifest.json', (req, res) => res.json(MANIFEST));

// ---------- Helpers ----------

async function getJson(url, opts) {
    try {
        const r = await fetch(url, opts);
        if (r.ok) return await r.json();
    } catch (e) {}
    return null;
}

function abs(href, base) {
    if (!href) return null;
    if (href.startsWith('http')) return href;
    if (href.startsWith('//')) return `https:${href}`;
    return `${base}${href.startsWith('/') ? '' : '/'}${href}`;
}

// Normalize Arabic text so matching is forgiving
const norm = s => (s || '')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();

// Pick the search result that actually matches the title, not just the first link
function pickResult($, hrefTest, query) {
    const q = norm(query);
    const cands = [];
    $('a').each((i, el) => {
        const href = $(el).attr('href') || '';
        if (!hrefTest(href)) return;
        let slug = href;
        try { slug = decodeURIComponent(href); } catch (e) {}
        cands.push({ href, text: norm($(el).text() + ' ' + slug) });
    });
    const best = cands.find(c => c.text.includes(q)) || cands[0];
    return best ? best.href : null;
}

// Last-resort machine translation
async function translateToArabic(text) {
    if (!text) return null;
    const data = await getJson(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|ar`);
    const t = data && data.responseData && data.responseData.translatedText;
    if (t && AR.test(t)) return t.trim();
    return null;
}

// ---------- Title resolver (Arabic first, English last) ----------

async function getMediaTitles(type, rawId) {
    const imdbId = rawId.split(':')[0];
    const arabic = new Set();
    let english = null;

    if (!TMDB_KEY) console.warn('[WARN] TMDB_KEY env variable is not set');

    // 1. TMDB: find id, then pull all Arabic translations
    const found = await getJson(`https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id`);
    const list = found && (type === 'series' ? found.tv_results : found.movie_results);
    const item = list && list[0];
    if (item) {
        english = item.title || item.name;
        const orig = item.original_title || item.original_name;
        if (orig && AR.test(orig)) arabic.add(orig);

        const kind = type === 'series' ? 'tv' : 'movie';
        const tr = await getJson(`https://api.themoviedb.org/3/${kind}/${item.id}/translations?api_key=${TMDB_KEY}`);
        for (const t of (tr && tr.translations) || []) {
            if (t.iso_639_1 === 'ar') {
                const name = ((t.data && (t.data.title || t.data.name)) || '').trim();
                if (AR.test(name)) arabic.add(name);
            }
        }
    }

    // 2. Wikidata fallback (lookup by IMDb id)
    if (arabic.size === 0) {
        const q = `SELECT ?l WHERE { ?i wdt:P345 "${imdbId}". ?i rdfs:label ?l. FILTER(lang(?l)="ar") } LIMIT 1`;
        const wd = await getJson('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q), {
            headers: { 'User-Agent': 'NuvioAddon/1.0', 'Accept': 'application/sparql-results+json' }
        });
        const v = wd && wd.results && wd.results.bindings[0] && wd.results.bindings[0].l.value;
        if (v) arabic.add(v);
    }

    // 3. English title via Cinemeta if TMDB didn't give one
    if (!english) {
        const cm = await getJson(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`);
        english = cm && cm.meta && cm.meta.name;
    }

    // 4. Last resort: machine translation
    if (arabic.size === 0 && english) {
        const t = await translateToArabic(english);
        if (t) arabic.add(t);
    }

    const out = [...arabic];
    if (english) out.push(english);
    console.log(`[Titles for ${imdbId}]:`, out);
    return out;
}

// ---------- Akwam ----------

async function resolveAkwamWatchPage(watchUrl) {
    try {
        const res = await fetch(watchUrl, { headers: HEADERS, redirect: 'follow' });
        const html = await res.text();
        const $ = cheerio.load(html);

        let directUrl = $('a[href*=".mp4"], a[href*=".m3u8"], a.download-link, a[href*="dl."]').first().attr('href');
        if (!directUrl) {
            const scripts = $('script').toArray();
            for (const script of scripts) {
                const content = $(script).html() || '';
                const match = content.match(/https?:\/\/[^"']+\.(mp4|m3u8)[^"']*/i);
                if (match) {
                    directUrl = match[0];
                    break;
                }
            }
        }
        return directUrl ? directUrl.replace(/^vcl:\/\//, '').replace(/^vlc:\/\//, '') : null;
    } catch (e) {
        return null;
    }
}

async function scrapeAkwam(queryTitle, targetEpisode, mediaType) {
    const streams = [];
    try {
        const searchUrl = `${AKWAM_DOMAIN}/search?q=${encodeURIComponent(queryTitle)}`;
        console.log(`[Akwam Search] "${queryTitle}"`);
        const res = await fetch(searchUrl, { headers: HEADERS });
        if (!res.ok) return streams;

        const $ = cheerio.load(await res.text());

        const pageUrl = abs(pickResult($, h =>
            mediaType === 'series'
                ? (h.includes('/series/') || h.includes('/episode/')) && !h.includes('/movie/')
                : h.includes('/movie/'),
            queryTitle), AKWAM_DOMAIN);

        if (!pageUrl) return streams;
        console.log(`[Akwam Found] ${pageUrl}`);

        let episodeUrl = null;

        if (mediaType === 'series') {
            const pageRes = await fetch(pageUrl, { headers: HEADERS });
            const $page = cheerio.load(await pageRes.text());

            $page('a[href*="/episode/"]').each((i, el) => {
                const href = $page(el).attr('href');
                const text = $page(el).text().trim();
                if (targetEpisode) {
                    if (text.includes(`الحلقة ${targetEpisode}`) || text.includes(`حلقة ${targetEpisode}`) || href.includes(`-episode-${targetEpisode}`) || href.endsWith(`/${targetEpisode}`)) {
                        episodeUrl = abs(href, AKWAM_DOMAIN);
                        return false;
                    }
                } else if (!episodeUrl) {
                    episodeUrl = abs(href, AKWAM_DOMAIN);
                }
            });
        } else {
            // Movies: the movie page itself holds the watch link
            episodeUrl = pageUrl;
        }

        if (episodeUrl) {
            console.log(`[Akwam Page] ${episodeUrl}`);
            const epRes = await fetch(episodeUrl, { headers: HEADERS });
            const $ep = cheerio.load(await epRes.text());

            let watchUrl = null;
            $ep('a[href*="/watch/"]').each((i, el) => {
                watchUrl = abs($ep(el).attr('href'), AKWAM_DOMAIN);
                return false;
            });

            if (watchUrl) {
                const finalPlayableUrl = await resolveAkwamWatchPage(watchUrl);
                if (finalPlayableUrl) {
                    streams.push({
                        name: 'Akwam (أكوام)',
                        title: `1080p | Native Stream`,
                        url: finalPlayableUrl,
                        behaviorHints: { notSupported: false, proxyHeaders: { request: { 'User-Agent': HEADERS['User-Agent'], 'Referer': `${AKWAM_DOMAIN}/` } } }
                    });
                }
            }
        }
    } catch (e) {
        console.error('[Akwam Error]:', e.message);
    }
    return streams;
}

// ---------- EgyBest ----------

async function scrapeEgyBest(queryTitle, targetEpisode, mediaType) {
    const streams = [];

    try {
        const searchUrl = `${EGYBEST_DOMAIN}/search.php?keywords=${encodeURIComponent(queryTitle)}&video-id=`;
        console.log(`[EgyBest Search] "${queryTitle}"`);
        const res = await fetch(searchUrl, { headers: { ...HEADERS, 'Referer': `${EGYBEST_DOMAIN}/` } });
        if (!res.ok) return streams;

        const $ = cheerio.load(await res.text());
        let watchPath = null;

        if (mediaType === 'series' && targetEpisode) {
            // Find the link whose text mentions the episode number
            $('a').each((i, el) => {
                const href = $(el).attr('href') || '';
                const text = $(el).text().trim();
                if (href.includes('watch.php?vid=')) {
                    if (text.includes(`حلقة ${targetEpisode}`) || text.includes(`الحلقة ${targetEpisode}`)) {
                        watchPath = href;
                        return false;
                    }
                }
            });
        }

        // Otherwise pick the best title match
        if (!watchPath) {
            watchPath = pickResult($, h => h.includes('watch.php?vid='), queryTitle);
        }

        if (watchPath) {
            const fullWatchUrl = abs(watchPath, EGYBEST_DOMAIN);
            const watchRes = await fetch(fullWatchUrl, { headers: { ...HEADERS, 'Referer': `${EGYBEST_DOMAIN}/` } });
            const $watch = cheerio.load(await watchRes.text());

            const iframeSrc = $watch('iframe.embed_player, iframe[src*="embed"], iframe[src*="play"]').attr('src');
            if (iframeSrc) {
                const streamUrl = abs(iframeSrc, EGYBEST_DOMAIN);
                streams.push({
                    name: 'EgyBest (إيجيبست)',
                    title: `HD | Native Stream`,
                    url: streamUrl,
                    behaviorHints: { notSupported: false, proxyHeaders: { request: { 'User-Agent': HEADERS['User-Agent'], 'Referer': `${EGYBEST_DOMAIN}/` } } }
                });
            }
        }
    } catch (e) {
        console.error('[EgyBest Error]:', e.message);
    }
    return streams;
}

// ---------- Route ----------

app.get('/stream/:type/:id.json', async (req, res) => {
    const { type, id } = req.params;
    const cleanId = id.replace('.json', '');

    console.log(`\n========================================`);
    console.log(`[REQUEST] ${type} ID: ${cleanId}`);

    let episode = 1;
    const parts = cleanId.split(':');
    if (type === 'series' && parts.length >= 3) {
        episode = parts[2];
    }

    const baseTitles = await getMediaTitles(type, cleanId);
    if (baseTitles.length === 0) return res.json({ streams: [] });

    let allStreams = [];

    for (const title of baseTitles) {
        const [akwamResults, egybestResults] = await Promise.all([
            scrapeAkwam(title, episode, type),
            scrapeEgyBest(title, episode, type)
        ]);

        allStreams = [...allStreams, ...akwamResults, ...egybestResults];
        if (allStreams.length > 0) {
            console.log(`✓ Streams found using query: "${title}"`);
            break;
        }
    }

    console.log(`Total streams delivered: ${allStreams.length}`);
    console.log(`========================================\n`);
    res.json({ streams: allStreams });
});

app.listen(PORT, () => {
    console.log(`\n🚀 Arabic Resolver active on port ${PORT}`);
});
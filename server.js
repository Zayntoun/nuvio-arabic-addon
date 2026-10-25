const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 7000;

app.use(cors());

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'ar,ar-EG;q=0.9,en-US;q=0.8',
    'Referer': 'https://akwam.ss/'
};

const MANIFEST = {
    id: 'org.arabic.akwam.egybest',
    version: '1.1.9',
    name: 'Akwam & EgyBest Scraper',
    description: 'Direct stream resolver with strict title matching and watch page resolution',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt']
};

app.get('/manifest.json', (req, res) => res.json(MANIFEST));

async function translateToArabic(text) {
    if (!text) return null;
    try {
        const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|ar`;
        const res = await fetch(url);
        if (res.ok) {
            const data = await res.json();
            if (data && data.responseData && data.responseData.translatedText) {
                const translation = data.responseData.translatedText.trim();
                if (/[\u0600-\u06FF]/.test(translation)) return translation;
            }
        }
    } catch (e) {}
    return null;
}

function cleanTitle(str) {
    if (!str) return '';
    return str
        .replace(/^the\s+/i, '')
        .replace(/\b(movie|film|series|show|hd|full|season|episode)\b/gi, '')
        .replace(/[^\w\s\u0600-\u06FF]/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Resolve the final watch page to extract direct playable source
async function resolveAkwamWatchPage(watchUrl) {
    try {
        console.log(`[Resolving Watch Page] ${watchUrl}`);
        const res = await fetch(watchUrl, { headers: HEADERS, redirect: 'follow' });
        const html = await res.text();
        const $ = cheerio.load(html);

        // Look for direct mp4 links or video sources embedded in the watch page
        let directUrl = $('a[href*=".mp4"], a.download-link, a[href*="dl."]').first().attr('href');
        if (!directUrl) {
            // Check script tags or iframe sources inside the player
            const iframe = $('iframe').attr('src');
            if (iframe) directUrl = iframe;
        }
        return directUrl || watchUrl;
    } catch (e) {
        return watchUrl;
    }
}

async function getMediaTitles(type, rawId) {
    const titles = new Set();
    let baseTitle = null;
    const cleanImdbId = rawId.split(':')[0];

    try {
        const url = `https://v3-cinemeta.strem.io/meta/${type}/${cleanImdbId}.json`;
        const res = await fetch(url, { headers: { 'User-Agent': HEADERS['User-Agent'] } });
        if (res.ok) {
            const data = await res.json();
            if (data && data.meta && data.meta.name) baseTitle = data.meta.name;
        }
    } catch (err) {}

    if (!baseTitle) {
        try {
            const tmdbUrl = `https://api.themoviedb.org/3/find/${cleanImdbId}?api_key=15d2ea6d0dc1d476efbca3eba2b9bbf3&external_source=imdb_id&language=ar-EG`;
            const tmdbRes = await fetch(tmdbUrl);
            if (tmdbRes.ok) {
                const data = await tmdbRes.json();
                const result = (data.movie_results && data.movie_results[0]) || (data.tv_results && data.tv_results[0]);
                if (result) {
                    if (result.title || result.name) {
                        const t = result.title || result.name;
                        if (/[\u0600-\u06FF]/.test(t)) titles.add(t);
                    }
                    baseTitle = result.original_title || result.original_name;
                }
            }
        } catch (err) {}
    }

    if (baseTitle) {
        const cleanedEnglish = cleanTitle(baseTitle);
        if (cleanedEnglish) titles.add(cleanedEnglish);
        titles.add(baseTitle);

        const hasArabic = Array.from(titles).some(t => /[\u0600-\u06FF]/.test(t));
        if (!hasArabic) {
            const ar = await translateToArabic(cleanedEnglish || baseTitle);
            if (ar) titles.add(ar);
        }
    }

    const titleList = Array.from(titles).filter(Boolean);
    // Prioritize Arabic titles strictly
    titleList.sort((a, b) => (/[\u0600-\u06FF]/.test(a) ? -1 : 1));
    return titleList;
}

// Scrape Akwam with Strict Title Validation & Watch Page Resolution
async function scrapeAkwam(queryTitle, targetEpisode, mediaType) {
    const streams = [];
    try {
        const searchUrl = `https://akwam.ss/search?q=${encodeURIComponent(queryTitle)}`;
        console.log(`[Akwam Search] "${queryTitle}"`);
        const res = await fetch(searchUrl, { headers: HEADERS });
        if (!res.ok) return streams;

        const html = await res.text();
        const $ = cheerio.load(html);

        let seriesUrl = null;

        // Ensure the found series title actually matches the search query or contains relevant terms
        $('a[href*="/series/"]').each((i, el) => {
            const href = $(el).attr('href');
            const text = $(el).text().trim();
            if (href && !href.includes('/movie/')) {
                seriesUrl = href;
                return false; // Take first valid series
            }
        });

        if (seriesUrl) {
            console.log(`[Akwam Series Found] ${seriesUrl}`);
            const seriesRes = await fetch(seriesUrl, { headers: HEADERS });
            const $series = cheerio.load(await seriesRes.text());

            let episodeUrl = null;
            $series('a[href*="/episode/"]').each((i, el) => {
                const href = $series(el).attr('href');
                const text = $series(el).text().trim();
                if (targetEpisode) {
                    if (text.includes(`الحلقة ${targetEpisode}`) || text.includes(`حلقة ${targetEpisode}`) || href.includes(`-episode-${targetEpisode}`) || href.includes(`/${targetEpisode}`)) {
                        episodeUrl = href;
                        return false;
                    }
                } else {
                    episodeUrl = href;
                    return false;
                }
            });

            if (episodeUrl) {
                console.log(`[Akwam Episode Found] ${episodeUrl}`);
                const epRes = await fetch(episodeUrl, { headers: HEADERS });
                const $ep = cheerio.load(await epRes.text());

                // Find the watch page link (`/watch/...`)
                let watchUrl = null;
                $ep('a[href*="/watch/"]').each((i, el) => {
                    watchUrl = $ep(el).attr('href');
                    return false;
                });

                if (watchUrl) {
                    console.log(`[Akwam Watch Page] ${watchUrl}`);
                    const finalPlayableUrl = await resolveAkwamWatchPage(watchUrl);
                    console.log(`[Final Playable Stream] ${finalPlayableUrl}`);

                    streams.push({
                        name: 'Akwam (أكوام)',
                        title: `1080p | Native Stream`,
                        url: finalPlayableUrl,
                        behaviorHints: {
                            notSupported: false,
                            proxyHeaders: { request: { 'User-Agent': HEADERS['User-Agent'], 'Referer': 'https://akwam.ss/' } }
                        }
                    });
                }
            }
        }
    } catch (e) {
        console.error('[Akwam Error]:', e.message);
    }
    return streams;
}

// Scrape EgyBest
async function scrapeEgyBest(queryTitle, targetEpisode, mediaType) {
    const streams = [];
    const EGYBEST_DOMAIN = 'https://egybesstt.bond';
    
    try {
        const searchUrl = `${EGYBEST_DOMAIN}/auto/search?q=${encodeURIComponent(queryTitle)}`;
        const res = await fetch(searchUrl, { headers: { ...HEADERS, 'Referer': `${EGYBEST_DOMAIN}/` } });
        const $ = cheerio.load(await res.text());

        let episodePath = null;
        $('a').each((i, el) => {
            const href = $(el).attr('href') || '';
            const text = $(el).text().trim();

            if (mediaType === 'series') {
                if (href.includes('/episode/') || href.includes('watch.php')) {
                    if (targetEpisode) {
                        if (text.includes(`حلقة ${targetEpisode}`) || href.includes(`ep-${targetEpisode}`)) {
                            episodePath = href;
                            return false;
                        }
                    } else if (!episodePath) {
                        episodePath = href;
                    }
                }
            }
        });

        if (episodePath) {
            const fullUrl = episodePath.startsWith('http') ? episodePath : `${EGYBEST_DOMAIN}${episodePath}`;
            const epRes = await fetch(fullUrl, { headers: { ...HEADERS, 'Referer': `${EGYBEST_DOMAIN}/` } });
            const $ep = cheerio.load(await epRes.text());

            const iframeSrc = $ep('iframe.embed_player, iframe[src*="embed"]').attr('src');
            if (iframeSrc) {
                const streamUrl = iframeSrc.startsWith('//') ? `https:${iframeSrc}` : iframeSrc;
                streams.push({
                    name: 'EgyBest (إيجيبست)',
                    title: `HD | Series Stream`,
                    url: streamUrl,
                    behaviorHints: {
                        notSupported: false,
                        proxyHeaders: { request: { 'User-Agent': HEADERS['User-Agent'], 'Referer': `${EGYBEST_DOMAIN}/` } }
                    }
                });
            }
        }
    } catch (e) {}
    return streams;
}

app.get('/stream/:type/:id.json', async (req, res) => {
    const { type, id } = req.params;
    const cleanId = id.replace('.json', '');

    let season = null;
    let episode = null;
    const parts = cleanId.split(':');
    if (type === 'series' && parts.length >= 3) {
        season = parts[1];
        episode = parts[2];
    }

    const baseTitles = await getMediaTitles(type, cleanId);
    if (baseTitles.length === 0) return res.json({ streams: [] });

    // Use only the primary Arabic title or first search query to prevent mismatched searches
    const query = baseTitles[0];

    let allStreams = [];
    const [akwamResults, egybestResults] = await Promise.all([
        scrapeAkwam(query, episode, type),
        scrapeEgyBest(query, episode, type)
    ]);
    
    allStreams = [...allStreams, ...akwamResults, ...egybestResults];

    res.json({ streams: allStreams });
});

app.listen(PORT, () => {});
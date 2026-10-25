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
    version: '1.3.0',
    name: 'Akwam & EgyBest Scraper',
    description: 'Dynamic stream resolver for movies and TV series',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt']
};

app.get('/manifest.json', (req, res) => res.json(MANIFEST));

// Helper: Translate English title to Arabic text
async function translateToArabic(text) {
    if (!text) return null;
    try {
        const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|ar`;
        const res = await fetch(url);
        if (res.ok) {
            const data = await res.json();
            if (data && data.responseData && data.responseData.translatedText) {
                const translation = data.responseData.translatedText.trim();
                if (/[\u0600-\u06FF]/.test(translation)) {
                    console.log(`[Translate Success] "${text}" -> "${translation}"`);
                    return translation;
                }
            }
        }
    } catch (e) {
        console.warn('[Translate Error]:', e.message);
    }
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

// Extract direct raw video URL by resolving watch page script tags
async function resolveAkwamWatchPage(watchUrl) {
    try {
        console.log(`[Resolving Watch Page] ${watchUrl}`);
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
        return directUrl || watchUrl;
    } catch (e) {
        return watchUrl;
    }
}

// Fetch Title metadata prioritizing Arabic script
async function getMediaTitles(type, rawId) {
    const titles = new Set();
    let baseTitle = null;
    const cleanImdbId = rawId.split(':')[0];

    // Method 1: TMDB Find API for direct Arabic title
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

    // Method 2: Cinemeta Official Stremio API
    if (!baseTitle) {
        try {
            const url = `https://v3-cinemeta.strem.io/meta/${type}/${cleanImdbId}.json`;
            const res = await fetch(url, { headers: { 'User-Agent': HEADERS['User-Agent'] } });
            if (res.ok) {
                const data = await res.json();
                if (data && data.meta && data.meta.name) baseTitle = data.meta.name;
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
    // Put Arabic script titles strictly at the front of the queue
    titleList.sort((a, b) => (/[\u0600-\u06FF]/.test(a) ? -1 : 1));
    console.log(`[Search Base Queue for ${cleanImdbId}]:`, titleList);
    return titleList;
}

// Dynamic Akwam Scraper with strict result title validation
async function scrapeAkwam(queryTitle, targetEpisode, mediaType) {
    const streams = [];
    try {
        const searchUrl = `https://akwam.ss/search?q=${encodeURIComponent(queryTitle)}`;
        console.log(`[Akwam Searching] "${queryTitle}"`);
        const res = await fetch(searchUrl, { headers: HEADERS });
        if (!res.ok) return streams;

        const html = await res.text();
        const $ = cheerio.load(html);

        let seriesUrl = null;

        $('a').each((i, el) => {
            const href = $(el).attr('href') || '';
            const text = $(el).text().trim();

            if (mediaType === 'series') {
                if ((href.includes('/series/') || href.includes('/episode/')) && !href.includes('/movie/')) {
                    // Title check: Ensure result text shares words with query to prevent wrong show matches
                    const isRelevant = queryTitle.split(' ').some(word => word.length > 2 && text.includes(word));
                    if (isRelevant || !seriesUrl) {
                        seriesUrl = href;
                        if (isRelevant) return false;
                    }
                }
            } else {
                if (href.includes('/movie/')) {
                    seriesUrl = href;
                    return false;
                }
            }
        });

        if (seriesUrl) {
            console.log(`[Akwam Validated Series Page] ${seriesUrl}`);
            const seriesRes = await fetch(seriesUrl, { headers: HEADERS });
            const $series = cheerio.load(await seriesRes.text());

            let episodeUrl = null;
            if (mediaType === 'series') {
                $series('a[href*="/episode/"]').each((i, el) => {
                    const href = $series(el).attr('href');
                    const text = $series(el).text().trim();
                    if (targetEpisode) {
                        if (text.includes(`الحلقة ${targetEpisode}`) || text.includes(`حلقة ${targetEpisode}`) || href.includes(`-episode-${targetEpisode}`) || href.endsWith(`/${targetEpisode}`)) {
                            episodeUrl = href;
                            return false;
                        }
                    } else if (!episodeUrl) {
                        episodeUrl = href;
                    }
                });
            } else {
                episodeUrl = seriesUrl; // For movies
            }

            if (episodeUrl) {
                console.log(`[Akwam Episode Page] ${episodeUrl}`);
                const epRes = await fetch(episodeUrl, { headers: HEADERS });
                const $ep = cheerio.load(await epRes.text());

                let watchUrl = null;
                $ep('a[href*="/watch/"]').each((i, el) => {
                    watchUrl = $ep(el).attr('href');
                    return false;
                });

                if (watchUrl) {
                    const finalPlayableUrl = await resolveAkwamWatchPage(watchUrl);
                    console.log(`[Akwam Stream Resolved] ${finalPlayableUrl}`);
                    streams.push({
                        name: 'Akwam (أكوام)',
                        title: `1080p | Dynamic Stream`,
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

// Dynamic EgyBest Scraper
async function scrapeEgyBest(queryTitle, targetEpisode, mediaType) {
    const streams = [];
    const EGYBEST_DOMAIN = 'https://egybesstt.bond';
    
    try {
        const searchUrl = `${EGYBEST_DOMAIN}/auto/search?q=${encodeURIComponent(queryTitle)}`;
        const res = await fetch(searchUrl, { headers: { ...HEADERS, 'Referer': `${EGYBEST_DOMAIN}/` } });
        const $ = cheerio.load(await res.text());

        let moviePath = null;

        $('a').each((i, el) => {
            const href = $(el).attr('href') || '';
            const text = $(el).text().trim();

            if (mediaType === 'series') {
                if (href.includes('/series/') || href.includes('/episode/')) {
                    if (targetEpisode) {
                        if (text.includes(`حلقة ${targetEpisode}`) || href.includes(`ep-${targetEpisode}`)) {
                            moviePath = href;
                            return false;
                        }
                    } else if (!moviePath) {
                        moviePath = href;
                    }
                }
            } else {
                if (href.includes('/movie/')) {
                    moviePath = href;
                    return false;
                }
            }
        });

        if (moviePath) {
            const fullUrl = moviePath.startsWith('http') ? moviePath : `${EGYBEST_DOMAIN}${moviePath}`;
            const epRes = await fetch(fullUrl, { headers: { ...HEADERS, 'Referer': `${EGYBEST_DOMAIN}/` } });
            const $ep = cheerio.load(await epRes.text());

            const iframeSrc = $ep('iframe.embed_player, iframe[src*="embed"]').attr('src');
            if (iframeSrc) {
                const streamUrl = iframeSrc.startsWith('//') ? `https:${iframeSrc}` : iframeSrc;
                streams.push({
                    name: 'EgyBest (إيجيبست)',
                    title: `HD | Dynamic Stream`,
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

    console.log(`\n========================================`);
    console.log(`[REQUEST] ${type} ID: ${cleanId}`);

    let season = null;
    let episode = null;
    const parts = cleanId.split(':');
    if (type === 'series' && parts.length >= 3) {
        season = parts[1];
        episode = parts[2];
        console.log(`[Series Request] Season ${season}, Episode ${episode}`);
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
            console.log(`✓ Streams found using title query: "${title}"`);
            break;
        }
    }

    console.log(`Total streams delivered: ${allStreams.length}`);
    console.log(`========================================\n`);
    res.json({ streams: allStreams });
});

app.listen(PORT, () => {
    console.log(`\n🚀 Dynamic Resolver active on http://127.0.0.1:${PORT}`);
});
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
    version: '2.0.0',
    name: 'Akwam & EgyBest Scraper',
    description: 'Dynamic Arabic resolver powered by ArabCity Metadata Bridge',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt']
};

app.get('/manifest.json', (req, res) => res.json(MANIFEST));

// Helper: Translate text to Arabic as last-resort fallback
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

// Resolve Akwam Watch page video stream link
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

// ARABCITY Metadata Bridge Resolver
async function getMediaTitles(type, rawId) {
    const titles = new Set();
    const cleanImdbId = rawId.split(':')[0];

    // Method 1: Query ArabCity Metadata API directly
    try {
        const arabCityUrl = `https://arabcity.fly.dev/YWxs/meta/${type}/${cleanImdbId}.json`;
        console.log(`[ArabCity Bridge] Fetching Arabic catalog metadata for ${cleanImdbId}`);
        const arabRes = await fetch(arabCityUrl, { headers: { 'User-Agent': HEADERS['User-Agent'] } });
        if (arabRes.ok) {
            const data = await arabRes.json();
            if (data && data.meta && data.meta.name) {
                const arName = data.meta.name;
                if (/[\u0600-\u06FF]/.test(arName)) {
                    titles.add(arName);
                    console.log(`[ArabCity Native Arabic Title Found]: "${arName}"`);
                }
            }
        }
    } catch (err) {
        console.warn('[ArabCity Bridge Error]:', err.message);
    }

    // Method 2: TMDB Arabic Find Fallback
    if (titles.size === 0) {
        try {
            const tmdbUrl = `https://api.themoviedb.org/3/find/${cleanImdbId}?api_key=15d2ea6d0dc1d476efbca3eba2b9bbf3&external_source=imdb_id&language=ar-EG`;
            const tmdbRes = await fetch(tmdbUrl);
            if (tmdbRes.ok) {
                const data = await tmdbRes.json();
                const results = type === 'series' ? data.tv_results : data.movie_results;
                if (results && results.length > 0) {
                    const item = results[0];
                    const arabicTitle = item.title || item.name;
                    if (arabicTitle && /[\u0600-\u06FF]/.test(arabicTitle)) {
                        titles.add(arabicTitle);
                        console.log(`[TMDB Native Arabic Title Found]: "${arabicTitle}"`);
                    }
                }
            }
        } catch (err) {}
    }

    // Method 3: Cinemeta Title + Forced Translation Fallback
    if (titles.size === 0) {
        try {
            const url = `https://v3-cinemeta.strem.io/meta/${type}/${cleanImdbId}.json`;
            const res = await fetch(url);
            if (res.ok) {
                const data = await res.json();
                if (data && data.meta && data.meta.name) {
                    const engTitle = data.meta.name;
                    const arTrans = await translateToArabic(engTitle);
                    if (arTrans) titles.add(arTrans);
                    titles.add(engTitle);
                }
            }
        } catch (err) {}
    }

    const titleList = Array.from(titles).filter(Boolean);
    titleList.sort((a, b) => (/[\u0600-\u06FF]/.test(a) ? -1 : 1));
    console.log(`[Dynamic Search Queue for ${cleanImdbId}]:`, titleList);
    return titleList;
}

// Akwam Scraper
async function scrapeAkwam(queryTitle, targetEpisode, mediaType) {
    const streams = [];
    try {
        const searchUrl = `https://akwam.ss/search?q=${encodeURIComponent(queryTitle)}`;
        console.log(`[Akwam Search] "${queryTitle}"`);
        const res = await fetch(searchUrl, { headers: HEADERS });
        if (!res.ok) return streams;

        const $ = cheerio.load(await res.text());
        let seriesUrl = null;

        $('a').each((i, el) => {
            const href = $(el).attr('href') || '';
            const text = $(el).text().trim();

            if (mediaType === 'series') {
                if ((href.includes('/series/') || href.includes('/episode/')) && !href.includes('/movie/')) {
                    seriesUrl = href;
                    return false;
                }
            } else {
                if (href.includes('/movie/')) {
                    seriesUrl = href;
                    return false;
                }
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
                    if (text.includes(`الحلقة ${targetEpisode}`) || text.includes(`حلقة ${targetEpisode}`) || href.includes(`-episode-${targetEpisode}`) || href.endsWith(`/${targetEpisode}`)) {
                        episodeUrl = href;
                        return false;
                    }
                } else if (!episodeUrl) {
                    episodeUrl = href;
                }
            });

            if (episodeUrl) {
                console.log(`[Akwam Episode Found] ${episodeUrl}`);
                const epRes = await fetch(episodeUrl, { headers: HEADERS });
                const $ep = cheerio.load(await epRes.text());

                let watchUrl = null;
                $ep('a[href*="/watch/"]').each((i, el) => {
                    watchUrl = $ep(el).attr('href');
                    return false;
                });

                if (watchUrl) {
                    const finalPlayableUrl = await resolveAkwamWatchPage(watchUrl);
                    if (finalPlayableUrl) {
                        streams.push({
                            name: 'Akwam (أكوام)',
                            title: `1080p | Native Stream`,
                            url: finalPlayableUrl,
                            behaviorHints: { notSupported: false, proxyHeaders: { request: { 'User-Agent': HEADERS['User-Agent'], 'Referer': 'https://akwam.ss/' } } }
                        });
                    }
                }
            }
        }
    } catch (e) {
        console.error('[Akwam Error]:', e.message);
    }
    return streams;
}

// EgyBest Scraper
async function scrapeEgyBest(queryTitle, targetEpisode, mediaType) {
    const streams = [];
    const EGYBEST_DOMAIN = 'https://egybesstt.bond';
    
    try {
        const searchUrl = `${EGYBEST_DOMAIN}/search.php?keywords=${encodeURIComponent(queryTitle)}&video-id=`;
        console.log(`[EgyBest Search] "${queryTitle}"`);
        const res = await fetch(searchUrl, { headers: { ...HEADERS, 'Referer': `${EGYBEST_DOMAIN}/` } });
        if (!res.ok) return streams;

        const $ = cheerio.load(await res.text());
        let watchPath = null;

        $('a').each((i, el) => {
            const href = $(el).attr('href') || '';
            const text = $(el).text().trim();

            if (href.includes('watch.php?vid=')) {
                if (targetEpisode) {
                    if (text.includes(`حلقة ${targetEpisode}`) || text.includes(`${targetEpisode}`)) {
                        watchPath = href;
                        return false;
                    }
                } else if (!watchPath) {
                    watchPath = href;
                }
            }
        });

        if (watchPath) {
            const fullWatchUrl = watchPath.startsWith('http') ? watchPath : `${EGYBEST_DOMAIN}/${watchPath}`;
            const watchRes = await fetch(fullWatchUrl, { headers: { ...HEADERS, 'Referer': `${EGYBEST_DOMAIN}/` } });
            const $watch = cheerio.load(await watchRes.text());

            const iframeSrc = $watch('iframe.embed_player, iframe[src*="embed"], iframe[src*="play"]').attr('src');
            if (iframeSrc) {
                const streamUrl = iframeSrc.startsWith('//') ? `https:${iframeSrc}` : iframeSrc;
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
    console.log(`\n🚀 ArabCity-Powered Arabic Resolver active on http://127.0.0.1:${PORT}`);
});
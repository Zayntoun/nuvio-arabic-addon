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
    version: '1.1.3',
    name: 'Akwam & EgyBest Scraper',
    description: 'Direct stream resolver with anti-movie blocking for TV series',
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
                if (/[\u0600-\u06FF]/.test(translation)) {
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

async function resolveDirectAkwamUrl(linkUrl) {
    try {
        const res = await fetch(linkUrl, { headers: HEADERS, redirect: 'follow' });
        const finalUrl = res.url;
        if (finalUrl.includes('.mp4') || finalUrl.includes('.m3u8')) return finalUrl;

        const html = await res.text();
        const $ = cheerio.load(html);
        const directMp4 = $('a[href*=".mp4"], a.download-link, a[href*="dl."]').first().attr('href');
        return directMp4 || finalUrl;
    } catch (e) {
        return linkUrl;
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
    titleList.sort((a, b) => (/[\u0600-\u06FF]/.test(a) ? -1 : 1));
    return titleList;
}

// Akwam Scraper with Anti-Movie Guardrails
async function scrapeAkwam(queryTitle, targetEpisode, mediaType) {
    const streams = [];
    try {
        const searchUrl = `https://akwam.ss/search?q=${encodeURIComponent(queryTitle)}`;
        const res = await fetch(searchUrl, { headers: HEADERS });
        const $ = cheerio.load(await res.text());

        let entryUrl = null;

        // Iterate through all potential links and aggressively weed out movies if it's a series request
        $('a').each((i, el) => {
            const href = $(el).attr('href') || '';
            const text = $(el).text();

            if (mediaType === 'series') {
                // Must be series/episode and CANNOT contain movie indicators
                if ((href.includes('/series/') || href.includes('/episode/')) && !href.includes('/movie/') && !text.includes('فيلم')) {
                    if (targetEpisode) {
                        if (text.includes(`الحلقة ${targetEpisode}`) || href.includes(`-episode-${targetEpisode}`)) {
                            entryUrl = href;
                            return false;
                        }
                    } else {
                        entryUrl = href;
                        return false;
                    }
                }
            } else {
                if (href.includes('/movie/')) {
                    entryUrl = href;
                    return false;
                }
            }
        });

        if (entryUrl) {
            let entryRes = await fetch(entryUrl, { headers: HEADERS });
            let $entry = cheerio.load(await entryRes.text());

            if (mediaType === 'series' && targetEpisode && entryUrl.includes('/series/')) {
                let epUrl = null;
                $entry('a[href*="/episode/"]').each((i, el) => {
                    const text = $entry(el).text();
                    const href = $entry(el).attr('href');
                    if (text.includes(`الحلقة ${targetEpisode}`) || href.includes(`-episode-${targetEpisode}`)) {
                        epUrl = href;
                        return false;
                    }
                });

                if (epUrl) {
                    let epRes = await fetch(epUrl, { headers: HEADERS });
                    $entry = cheerio.load(await epRes.text());
                }
            }

            const downloadLinks = [];
            $entry('a[href*="/download/"], a.link-download, a.btn-primary').each((i, el) => {
                const link = $entry(el).attr('href');
                const label = $entry(el).text().trim() || 'Akwam Stream';
                if (link) downloadLinks.push({ link, label });
            });

            for (const item of downloadLinks.slice(0, 2)) {
                const directUrl = await resolveDirectAkwamUrl(item.link);
                streams.push({
                    name: 'Akwam (أكوام)',
                    title: `1080p | Series Stream | ${item.label}`,
                    url: directUrl,
                    behaviorHints: {
                        notSupported: false,
                        proxyHeaders: { request: { 'User-Agent': HEADERS['User-Agent'], 'Referer': 'https://akwam.ss/' } }
                    }
                });
            }
        }
    } catch (e) {}
    return streams;
}

// EgyBest Scraper with Anti-Movie Guardrails
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
            const text = $(el).text();

            if (mediaType === 'series') {
                if ((href.includes('/series/') || href.includes('/episode/')) && !href.includes('/movie/') && !text.includes('فيلم')) {
                    if (targetEpisode) {
                        if (text.includes(`حلقة ${targetEpisode}`) || href.includes(`ep-${targetEpisode}`)) {
                            moviePath = href;
                            return false;
                        }
                    } else {
                        moviePath = href;
                        return false;
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
            let movieRes = await fetch(fullUrl, { headers: { ...HEADERS, 'Referer': `${EGYBEST_DOMAIN}/` } });
            let $movie = cheerio.load(await movieRes.text());

            if (mediaType === 'series' && targetEpisode && fullUrl.includes('/series/')) {
                let epPath = null;
                $movie('a[href*="/episode/"]').each((i, el) => {
                    const href = $movie(el).attr('href');
                    if (href.includes(`ep-${targetEpisode}`) || $movie(el).text().includes(`${targetEpisode}`)) {
                        epPath = href;
                        return false;
                    }
                });

                if (epPath) {
                    const epUrl = epPath.startsWith('http') ? epPath : `${EGYBEST_DOMAIN}${epPath}`;
                    let epRes = await fetch(epUrl, { headers: { ...HEADERS, 'Referer': `${EGYBEST_DOMAIN}/` } });
                    $movie = cheerio.load(await epRes.text());
                }
            }

            const iframeSrc = $movie('iframe.embed_player, iframe[src*="embed"]').attr('src');
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

    const searchQueries = [];
    for (const title of baseTitles) {
        if (season && episode) {
            if (/[\u0600-\u06FF]/.test(title)) {
                searchQueries.push(`${title} الحلقة ${episode}`);
            }
            searchQueries.push(`${title} S${season.padStart(2, '0')}E${episode.padStart(2, '0')}`);
        }
        searchQueries.push(title);
    }

    let allStreams = [];
    for (const query of searchQueries) {
        const [akwamResults, egybestResults] = await Promise.all([
            scrapeAkwam(query, episode, type),
            scrapeEgyBest(query, episode, type)
        ]);
        
        allStreams = [...allStreams, ...akwamResults, ...egybestResults];
        if (allStreams.length > 0) break;
    }

    res.json({ streams: allStreams });
});

app.listen(PORT, () => {});
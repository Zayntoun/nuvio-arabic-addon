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
    version: '1.1.7',
    name: 'Akwam & EgyBest Scraper',
    description: 'Direct stream resolver with exact structural path matching',
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

// Scrape Akwam matching the exact /series/ -> /episode/ -> /watch/ flow
async function scrapeAkwam(queryTitle, targetEpisode, mediaType) {
    const streams = [];
    try {
        const slugFormatted = queryTitle.replace(/\s+/g, '-');
        const searchUrls = [
            `https://akwam.ss/search?q=${encodeURIComponent(queryTitle)}`,
            `https://akwam.ss/series/${slugFormatted}`
        ];

        let seriesUrl = null;

        for (const url of searchUrls) {
            const res = await fetch(url, { headers: HEADERS });
            if (!res.ok) continue;
            const html = await res.text();
            const $ = cheerio.load(html);

            if (url.includes('/series/') && !html.includes('404')) {
                seriesUrl = url;
                break;
            }

            $('a[href*="/series/"]').each((i, el) => {
                const href = $(el).attr('href');
                if (href && !href.includes('/movie/')) {
                    seriesUrl = href;
                    return false;
                }
            });
            if (seriesUrl) break;
        }

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

                // Find watch page or direct download links
                let watchUrl = null;
                $ep('a[href*="/watch/"]').each((i, el) => {
                    watchUrl = $ep(el).attr('href');
                    return false;
                });

                if (watchUrl) {
                    console.log(`[Akwam Watch Page] ${watchUrl}`);
                    const watchRes = await fetch(watchUrl, { headers: HEADERS });
                    const $watch = cheerio.load(await watchRes.text());
                    
                    $watch('a[href*=".mp4"], a.download-link, a[href*="dl."]').each((i, el) => {
                        const link = $watch(el).attr('href');
                        if (link) {
                            streams.push({
                                name: 'Akwam (أكوام)',
                                title: `1080p | Direct Stream`,
                                url: link,
                                behaviorHints: { notSupported: false, proxyHeaders: { request: { 'User-Agent': HEADERS['User-Agent'], 'Referer': 'https://akwam.ss/' } } }
                            });
                        }
                    });
                }

                // Fallback to standard download links on episode page
                $ep('a[href*="/download/"], a.link-download, a.btn-primary').each((i, el) => {
                    const link = $ep(el).attr('href');
                    const label = $ep(el).text().trim() || 'Akwam Stream';
                    if (link && streams.length === 0) {
                        streams.push({
                            name: 'Akwam (أكوام)',
                            title: `1080p | ${label}`,
                            url: link,
                            behaviorHints: { notSupported: false, proxyHeaders: { request: { 'User-Agent': HEADERS['User-Agent'], 'Referer': 'https://akwam.ss/' } } }
                        });
                    }
                });
            }
        }
    } catch (e) {
        console.error('[Akwam Error]:', e.message);
    }
    return streams;
}

// Scrape EgyBest matching watch.php?vid= pattern
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
            console.log(`[EgyBest Match] ${fullUrl}`);
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

    const searchQueries = [];
    for (const title of baseTitles) {
        if (season && episode) {
            if (/[\u0600-\u06FF]/.test(title)) {
                searchQueries.push(`${title}`);
            }
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
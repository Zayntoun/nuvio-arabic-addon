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
    version: '1.0.8',
    name: 'Akwam & EgyBest Scraper',
    description: 'Direct stream resolver for Nuvio internal player',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt']
};

app.get('/manifest.json', (req, res) => res.json(MANIFEST));

// Helper: Translate text to Arabic via server-friendly MyMemory API + Fallbacks
async function translateToArabic(text) {
    if (!text) return null;
    
    // Method 1: MyMemory Translation API (Works reliably on cloud servers/Render)
    try {
        const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|ar`;
        const res = await fetch(url);
        if (res.ok) {
            const data = await res.json();
            if (data && data.responseData && data.responseData.translatedText) {
                const translation = data.responseData.translatedText.trim();
                // Ensure the returned string actually contains Arabic characters
                if (/[\u0600-\u06FF]/.test(translation)) {
                    console.log(`[Translate Success] "${text}" -> "${translation}"`);
                    return translation;
                }
            }
        }
    } catch (e) {
        console.warn('[MyMemory Translate Error]:', e.message);
    }

    // Method 2: Google Translate GTX Endpoint
    try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ar&dt=t&q=${encodeURIComponent(text)}`;
        const res = await fetch(url, { headers: { 'User-Agent': HEADERS['User-Agent'] } });
        const contentType = res.headers.get('content-type') || '';

        if (res.ok && contentType.includes('application/json')) {
            const data = await res.json();
            if (data && data[0] && data[0][0] && data[0][0][0]) {
                const translation = data[0][0][0];
                if (/[\u0600-\u06FF]/.test(translation)) {
                    return translation;
                }
            }
        }
    } catch (e) {
        console.warn('[Google Translate Error]:', e.message);
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

// Extract direct raw MP4 URL by resolving Akwam redirect pages
async function resolveDirectAkwamUrl(linkUrl) {
    try {
        const res = await fetch(linkUrl, { headers: HEADERS, redirect: 'follow' });
        const finalUrl = res.url;

        if (finalUrl.includes('.mp4') || finalUrl.includes('.m3u8')) {
            return finalUrl;
        }

        const html = await res.text();
        const $ = cheerio.load(html);
        const directMp4 = $('a[href*=".mp4"], a.download-link, a[href*="dl."]').first().attr('href');

        return directMp4 || finalUrl;
    } catch (e) {
        console.error('Resolution error:', e.message);
        return linkUrl;
    }
}

// Fetch Title -> Fallback Metadata Sources -> Translate to Arabic
async function getMediaTitles(type, imdbId) {
    const titles = new Set();
    let baseTitle = null;

    // 1. Try Cinemeta
    try {
        const res = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`);
        const contentType = res.headers.get('content-type') || '';

        if (res.ok && contentType.includes('application/json')) {
            const data = await res.json();
            if (data && data.meta && data.meta.name) {
                baseTitle = data.meta.name;
            }
        } else {
            console.warn(`[Cinemeta Warning] Returned status ${res.status}`);
        }
    } catch (err) {
        console.error('[Cinemeta Error]:', err.message);
    }

    // 2. Fallback to IMDb HTML Scraper if Cinemeta 504s/fails
    if (!baseTitle) {
        try {
            console.log(`[Metadata Fallback] Attempting direct IMDb lookup for ${imdbId}...`);
            const imdbRes = await fetch(`https://www.imdb.com/title/${imdbId}/`, {
                headers: { 'User-Agent': HEADERS['User-Agent'], 'Accept-Language': 'en-US,en;q=0.9' }
            });
            if (imdbRes.ok) {
                const html = await imdbRes.text();
                const $ = cheerio.load(html);
                const rawTitle = $('h1[data-testid="hero__pageTitle"] span').first().text().trim() || 
                                 $('title').text().split('-')[0].trim();
                if (rawTitle) {
                    baseTitle = rawTitle;
                    console.log(`[Metadata Success] Retrieved title from IMDb: "${baseTitle}"`);
                }
            }
        } catch (err) {
            console.error('[IMDb Fallback Error]:', err.message);
        }
    }

    // Build search queue if a title was successfully resolved
    if (baseTitle) {
        const cleanedEnglish = cleanTitle(baseTitle);
        const arabicTranslation = await translateToArabic(cleanedEnglish || baseTitle);

        if (arabicTranslation) {
            titles.add(arabicTranslation);
            const cleanedArabic = cleanTitle(arabicTranslation);
            if (cleanedArabic) titles.add(cleanedArabic);
        }

        if (cleanedEnglish) titles.add(cleanedEnglish);
        titles.add(baseTitle);
    }

    // Prioritize Arabic script strings first
    const titleList = Array.from(titles).filter(Boolean);
    titleList.sort((a, b) => {
        const aHasArabic = /[\u0600-\u06FF]/.test(a);
        const bHasArabic = /[\u0600-\u06FF]/.test(b);
        if (aHasArabic && !bHasArabic) return -1;
        if (!aHasArabic && bHasArabic) return 1;
        return 0;
    });

    return titleList;
}

// Scrape and Resolve Akwam Streams
async function scrapeAkwam(queryTitle) {
    const streams = [];
    try {
        const searchUrl = `https://akwam.ss/search?q=${encodeURIComponent(queryTitle)}`;
        console.log(`[Akwam Search] "${queryTitle}" -> ${searchUrl}`);
        
        const res = await fetch(searchUrl, { headers: HEADERS });
        const html = await res.text();
        const $ = cheerio.load(html);

        const entryUrl = $('a[href*="/movie/"], a[href*="/series/"], .entry-box a').first().attr('href');

        if (entryUrl) {
            console.log(`[Akwam Match] Page found: ${entryUrl}`);
            const entryRes = await fetch(entryUrl, { headers: HEADERS });
            const entryHtml = await entryRes.text();
            const $entry = cheerio.load(entryHtml);

            const downloadLinks = [];
            $entry('a[href*="/download/"], a.link-download, a.btn-primary').each((i, el) => {
                const link = $entry(el).attr('href');
                const label = $entry(el).text().trim() || 'Akwam Direct Stream';
                if (link) downloadLinks.push({ link, label });
            });

            for (const item of downloadLinks.slice(0, 2)) {
                console.log(`[Resolving Stream] ${item.link}`);
                const directUrl = await resolveDirectAkwamUrl(item.link);
                console.log(`[Resolved Target] -> ${directUrl}`);

                streams.push({
                    name: 'Akwam (أكوام)',
                    title: `1080p | Native Direct Stream | ${item.label}`,
                    url: directUrl,
                    behaviorHints: {
                        notSupported: false,
                        proxyHeaders: {
                            request: {
                                'User-Agent': HEADERS['User-Agent'],
                                'Referer': 'https://akwam.ss/'
                            }
                        }
                    }
                });
            }
        }
    } catch (e) {
        console.error('[Akwam Error]:', e.message);
    }
    return streams;
}

// Scrape and Resolve EgyBest Streams
async function scrapeEgyBest(queryTitle) {
    const streams = [];
    try {
        const searchUrl = `https://egybesstt.living/auto/search?q=${encodeURIComponent(queryTitle)}`;
        console.log(`[EgyBest Search] "${queryTitle}" -> ${searchUrl}`);
        
        const res = await fetch(searchUrl, { headers: HEADERS });
        const html = await res.text();
        const $ = cheerio.load(html);

        const moviePath = $('a.movie, a[href*="/movie/"], a[href*="/series/"]').first().attr('href');

        if (moviePath) {
            const fullUrl = moviePath.startsWith('http') ? moviePath : `https://egybesstt.living${moviePath}`;
            console.log(`[EgyBest Match] Page found: ${fullUrl}`);
            const movieRes = await fetch(fullUrl, { headers: HEADERS });
            const movieHtml = await movieRes.text();
            const $movie = cheerio.load(movieHtml);

            const iframeSrc = $movie('iframe.embed_player, iframe[src*="embed"]').attr('src');

            if (iframeSrc) {
                const streamUrl = iframeSrc.startsWith('//') ? `https:${iframeSrc}` : iframeSrc;
                streams.push({
                    name: 'EgyBest (إيجيبست)',
                    title: `HD | Native Stream`,
                    url: streamUrl,
                    behaviorHints: {
                        notSupported: false,
                        proxyHeaders: {
                            request: {
                                'User-Agent': HEADERS['User-Agent'],
                                'Referer': 'https://egybesstt.living/'
                            }
                        }
                    }
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

    const titles = await getMediaTitles(type, cleanId);

    if (titles.length === 0) {
        return res.json({ streams: [] });
    }

    let allStreams = [];

    for (const title of titles) {
        const [akwamResults, egybestResults] = await Promise.all([
            scrapeAkwam(title),
            scrapeEgyBest(title)
        ]);
        
        allStreams = [...allStreams, ...akwamResults, ...egybestResults];
        
        if (allStreams.length > 0) {
            console.log(`✓ SUCCESS: Direct streams resolved for "${title}"`);
            break;
        }
    }

    console.log(`Total resolved streams delivered to Nuvio: ${allStreams.length}`);
    console.log(`========================================\n`);
    res.json({ streams: allStreams });
});

app.listen(PORT, () => {
    console.log(`\n🚀 Native Resolver active on http://127.0.0.1:${PORT}`);
});
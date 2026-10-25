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
    version: '1.1.1',
    name: 'Akwam & EgyBest Scraper',
    description: 'Direct stream resolver with deep episode matching',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt']
};

app.get('/manifest.json', (req, res) => res.json(MANIFEST));

// Helper: Translate text to Arabic
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
        console.warn('[MyMemory Translate Error]:', e.message);
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

// Fetch Title -> Multi-Source Fallback Chain
async function getMediaTitles(type, rawId) {
    const titles = new Set();
    let baseTitle = null;

    const cleanImdbId = rawId.split(':')[0];

    // Method 1: Cinemeta Official Stremio API
    try {
        const url = `https://v3-cinemeta.strem.io/meta/${type}/${cleanImdbId}.json`;
        const res = await fetch(url, { headers: { 'User-Agent': HEADERS['User-Agent'] } });
        if (res.ok) {
            const contentType = res.headers.get('content-type') || '';
            if (contentType.includes('application/json')) {
                const data = await res.json();
                if (data && data.meta && data.meta.name) {
                    baseTitle = data.meta.name;
                }
            }
        }
    } catch (err) {
        console.warn('[Cinemeta Error]:', err.message);
    }

    // Method 2: TMDB Find API
    if (!baseTitle) {
        try {
            const tmdbUrl = `https://api.themoviedb.org/3/find/${cleanImdbId}?api_key=15d2ea6d0dc1d476efbca3eba2b9bbf3&external_source=imdb_id&language=ar-EG`;
            const tmdbRes = await fetch(tmdbUrl);
            if (tmdbRes.ok) {
                const data = await tmdbRes.json();
                const result = (data.movie_results && data.movie_results[0]) || (data.tv_results && data.tv_results[0]);
                if (result) {
                    if (result.title || result.name) {
                        const tmdbTitle = result.title || result.name;
                        if (/[\u0600-\u06FF]/.test(tmdbTitle)) {
                            titles.add(tmdbTitle);
                        }
                    }
                    if (result.original_title || result.original_name) {
                        baseTitle = result.original_title || result.original_name;
                    }
                }
            }
        } catch (err) {
            console.warn('[TMDB Error]:', err.message);
        }
    }

    if (baseTitle) {
        const cleanedEnglish = cleanTitle(baseTitle);
        if (cleanedEnglish) titles.add(cleanedEnglish);
        titles.add(baseTitle);

        const hasArabicScript = Array.from(titles).some(t => /[\u0600-\u06FF]/.test(t));
        if (!hasArabicScript) {
            const arabicTranslation = await translateToArabic(cleanedEnglish || baseTitle);
            if (arabicTranslation) {
                titles.add(arabicTranslation);
                const cleanedArabic = cleanTitle(arabicTranslation);
                if (cleanedArabic) titles.add(cleanedArabic);
            }
        }
    }

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

// Scrape and Resolve Akwam Streams with Deep Episode Navigation
async function scrapeAkwam(queryTitle, targetEpisode) {
    const streams = [];
    try {
        const searchUrl = `https://akwam.ss/search?q=${encodeURIComponent(queryTitle)}`;
        console.log(`[Akwam Search] "${queryTitle}" -> ${searchUrl}`);
        
        const res = await fetch(searchUrl, { headers: HEADERS });
        const html = await res.text();
        const $ = cheerio.load(html);

        let entryUrl = null;

        // If looking for a specific episode, look for direct episode link match first
        if (targetEpisode) {
            $('a[href*="/episode/"]').each((i, el) => {
                const text = $(el).text();
                const href = $(el).attr('href');
                if (text.includes(`الحلقة ${targetEpisode}`) || text.includes(`حلقة ${targetEpisode}`) || href.includes(`-episode-${targetEpisode}`)) {
                    entryUrl = href;
                    return false;
                }
            });
        }

        // Fallback to general
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const OUTPUT_FILE = path.resolve("data/schedule.json");
const PROFILE_DIR = path.resolve(".playwright-profile");
const CALENDAR_URL = "https://www.crunchyroll.com/simulcastcalendar";
const CALENDAR_FILTER = "premium";
const PAST_MONTHS_TO_INCLUDE = 1;
const LINEUP_URL = "https://www.crunchyroll.com/news/seasonal-lineup/2025/12/16/winter-anime-2026-crunchyroll";
const MAL_API_BASE = "https://api.jikan.moe/v4";

async function main() {
  const malSeason = currentMalSeason(new Date());
  const malList = await fetchMalSeasonAnime(malSeason.year, malSeason.season);
  const malIndex = buildMalIndex(malList);
  const scanDates = buildScanWeekDates();
  const seasonEnd = endOfCurrentSeason(new Date());
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: process.env.CI === "true",
    viewport: { width: 1400, height: 900 },
  });
  const page = context.pages()[0] ?? await context.newPage();
  const lineupTitles = await scrapeLineupTitles(page, LINEUP_URL);
  const lineupTitleKeys = new Set(lineupTitles.map((t) => normalizeTitleKey(t)));

  const allRows = [];
  const scannedUrls = [LINEUP_URL];
  for (const day of scanDates) {
    const url = `${CALENDAR_URL}?filter=${CALENDAR_FILTER}&date=${day}`;
    console.log(`Scanning ${url}`);
    scannedUrls.push(url);
    const rows = await scrapeCalendarDay(page, url, day);
    allRows.push(...rows);
  }

  await context.close();

  let episodes = enrichEpisodesWithMal(normalizeAndDedupe(allRows), malIndex);
  const malDetails = await fetchMalAnimeDetails(uniqueMalIds(episodes));
  episodes = applyMalDetails(episodes, malDetails);
  episodes = applyMalSeasonEpisodeNumbers(episodes);
  episodes = sanitizeMalAssignments(episodes);
  const projectedEpisodes = buildProjectedUpcoming(episodes, seasonEnd, lineupTitleKeys);
  const allEpisodes = [...episodes, ...projectedEpisodes].sort(
    (a, b) => new Date(a.releaseDateTime).getTime() - new Date(b.releaseDateTime).getTime(),
  );
  if (allEpisodes.length === 0) {
    if (await fileExists(OUTPUT_FILE)) {
      console.warn(
        "No calendar episodes were extracted (likely Cloudflare). Keeping existing data/schedule.json and exiting without changes.",
      );
      return;
    }
    throw new Error(
      "No calendar episodes were extracted and no existing schedule file is available.",
    );
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    sourceUrls: scannedUrls,
    projectionLineupCount: lineupTitles.length,
    malSeason: `${malSeason.season}-${malSeason.year}`,
    malCount: malList.length,
    malDetailCount: malDetails.size,
    episodes: allEpisodes,
  };

  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await fs.writeFile(OUTPUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Wrote ${allEpisodes.length} episodes (${projectedEpisodes.length} projected) -> ${OUTPUT_FILE}`);
}

function currentMalSeason(today) {
  const year = today.getFullYear();
  const month = today.getMonth();
  if (month <= 1 || month === 11) {
    return { year, season: "winter" };
  }
  if (month <= 4) {
    return { year, season: "spring" };
  }
  if (month <= 7) {
    return { year, season: "summer" };
  }
  return { year, season: "fall" };
}

async function fetchMalSeasonAnime(year, season) {
  const results = [];
  let page = 1;
  let hasNext = true;

  while (hasNext && page <= 8) {
    const url = `${MAL_API_BASE}/seasons/${year}/${season}?page=${page}`;
    console.log(`Fetching MAL ${url}`);
    const response = await fetch(url, { headers: { "User-Agent": "CrunchyrollCalendar/1.0" } });
    if (!response.ok) {
      console.warn(`MAL fetch failed: ${response.status} on page ${page}`);
      break;
    }
    const data = await response.json();
    results.push(...(data.data || []));
    hasNext = Boolean(data.pagination?.has_next_page);
    page += 1;
    await sleep(300);
  }

  return results;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uniqueMalIds(episodes) {
  return [...new Set(
    episodes
      .map((e) => Number(e.malId))
      .filter((id) => Number.isFinite(id) && id > 0),
  )];
}

async function fetchMalAnimeDetails(ids) {
  const details = new Map();
  for (const id of ids) {
    const url = `${MAL_API_BASE}/anime/${id}/full`;
    try {
      const response = await fetch(url, { headers: { "User-Agent": "CrunchyrollCalendar/1.0" } });
      if (!response.ok) {
        if (response.status === 429) {
          await sleep(1200);
        }
        continue;
      }
      const data = await response.json();
      const anime = data.data;
      details.set(id, {
        malEpisodes: Number.isFinite(anime?.episodes) ? anime.episodes : null,
        malAiredFrom: anime?.aired?.from || null,
        malAiredTo: anime?.aired?.to || null,
        malTitle: anime?.title || "",
      });
      await sleep(220);
    } catch {
      continue;
    }
  }
  return details;
}

function applyMalDetails(episodes, detailMap) {
  return episodes.map((ep) => {
    const id = Number(ep.malId);
    if (!Number.isFinite(id) || !detailMap.has(id)) {
      return ep;
    }
    const detail = detailMap.get(id);
    return {
      ...ep,
      malTitle: detail.malTitle || ep.malTitle || "",
      malEpisodes: detail.malEpisodes ?? ep.malEpisodes ?? null,
      malAiredFrom: detail.malAiredFrom || ep.malAiredFrom || null,
      malAiredTo: detail.malAiredTo || ep.malAiredTo || null,
    };
  });
}

function buildMalIndex(malList) {
  const index = new Map();
  for (const anime of malList) {
    const meta = {
      malId: anime.mal_id || null,
      malTitle: anime.title || "",
      malTitleKey: normalizeTitleKey(anime.title || ""),
      malEpisodes: Number.isFinite(anime.episodes) ? anime.episodes : null,
      malAiredFrom: anime.aired?.from || null,
      malAiredTo: anime.aired?.to || null,
    };
    const keys = new Set();
    if (anime.title) keys.add(normalizeTitleKey(anime.title));
    if (anime.title_english) keys.add(normalizeTitleKey(anime.title_english));
    if (Array.isArray(anime.title_synonyms)) {
      anime.title_synonyms.forEach((t) => t && keys.add(normalizeTitleKey(t)));
    }
    if (Array.isArray(anime.titles)) {
      anime.titles.forEach((t) => t?.title && keys.add(normalizeTitleKey(t.title)));
    }
    keys.forEach((key) => {
      if (key) {
        if (!index.has(key)) {
          index.set(key, []);
        }
        index.get(key).push(meta);
      }
    });
  }
  return index;
}

function enrichEpisodesWithMal(episodes, malIndex) {
  return episodes.map((ep) => {
    const key = normalizeTitleKey(ep.title);
    const mal = lookupMalMeta(key, ep.releaseDateTime, malIndex);
    return {
      ...ep,
      malId: mal?.malId || null,
      malTitle: mal?.malTitle || "",
      malEpisodes: mal?.malEpisodes ?? null,
      malAiredFrom: mal?.malAiredFrom || null,
      malAiredTo: mal?.malAiredTo || null,
    };
  });
}

function sanitizeMalAssignments(episodes) {
  const byShow = new Map();
  for (const ep of episodes) {
    const key = `${ep.title}|${ep.audio}`;
    if (!byShow.has(key)) {
      byShow.set(key, []);
    }
    byShow.get(key).push(ep);
  }

  const invalidShowKeys = new Set();
  for (const [showKey, showEpisodes] of byShow.entries()) {
    const malTotals = showEpisodes
      .map((e) => Number(e.malEpisodes))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (malTotals.length === 0) {
      continue;
    }

    const maxSeen = Math.max(
      ...showEpisodes
        .map((e) => parseEpisodeNum(e.seasonEpisode ?? e.episode))
        .filter((n) => Number.isFinite(n)),
    );
    if (!Number.isFinite(maxSeen)) {
      continue;
    }

    const malCap = Math.max(...malTotals);
    if (maxSeen > malCap + 1) {
      invalidShowKeys.add(showKey);
    }
  }

  if (invalidShowKeys.size > 0) {
    console.warn(`Removed MAL links for ${invalidShowKeys.size} mismatched show/audio groups.`);
  }

  return episodes.map((ep) => {
    const key = `${ep.title}|${ep.audio}`;
    if (!invalidShowKeys.has(key)) {
      return ep;
    }
    return {
      ...ep,
      malId: null,
      malTitle: "",
      malEpisodes: null,
      malAiredFrom: null,
      malAiredTo: null,
    };
  });
}

function lookupMalMeta(titleKey, releaseDateTime, malIndex) {
  const release = new Date(releaseDateTime);
  const candidates = [];
  const seen = new Set();

  const addCandidates = (values, matchedKey) => {
    for (const value of values || []) {
      const id = Number(value.malId);
      if (Number.isFinite(id) && seen.has(id)) {
        continue;
      }
      if (Number.isFinite(id)) {
        seen.add(id);
      }
      candidates.push({ value, matchedKey });
    }
  };

  if (malIndex.has(titleKey)) {
    addCandidates(malIndex.get(titleKey), titleKey);
  }
  for (const [key, values] of malIndex.entries()) {
    if (!key || key.length < 5) {
      continue;
    }
    if (titleKey.includes(key) || key.includes(titleKey)) {
      addCandidates(values, key);
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  const scored = candidates.map(({ value, matchedKey }) => {
    let score = 0;
    const candidateTitleKey = value.malTitleKey || normalizeTitleKey(value.malTitle || "");

    if (matchedKey === titleKey) {
      score += 30;
    } else if (matchedKey && matchedKey.length >= 8) {
      score += 8;
    }

    if (candidateTitleKey === titleKey) {
      score += 10;
    } else if (candidateTitleKey && (titleKey.includes(candidateTitleKey) || candidateTitleKey.includes(titleKey))) {
      score += 3;
    }

    const airedFrom = value.malAiredFrom ? new Date(value.malAiredFrom) : null;
    if (airedFrom && !Number.isNaN(airedFrom.getTime()) && !Number.isNaN(release.getTime())) {
      const days = Math.abs((release.getTime() - airedFrom.getTime()) / (24 * 3600 * 1000));
      if (days <= 14) score += 6;
      else if (days <= 45) score += 4;
      else if (days <= 120) score += 2;
      else if (days <= 365) score += 0;
      else score -= 6;
    }

    return { candidate: value, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].candidate;
}

function applyMalSeasonEpisodeNumbers(episodes) {
  const byShow = new Map();
  for (const ep of episodes) {
    const malId = Number(ep.malId);
    if (!Number.isFinite(malId) || malId <= 0) {
      continue;
    }
    const key = `${malId}|${ep.audio}`;
    if (!byShow.has(key)) {
      byShow.set(key, []);
    }
    byShow.get(key).push(ep);
  }

  const offsetByGroup = new Map();
  for (const [groupKey, showEpisodes] of byShow.entries()) {
    const withNum = showEpisodes
      .map((e) => ({ e, ep: parseEpisodeNum(e.episode), d: new Date(e.releaseDateTime) }))
      .filter((x) => Number.isFinite(x.ep) && !Number.isNaN(x.d.getTime()))
      .sort((a, b) => a.d - b.d);
    if (withNum.length === 0) {
      continue;
    }

    const first = withNum[0];
    const malStartRaw = showEpisodes.find((x) => x.malAiredFrom)?.malAiredFrom || null;
    const malStart = malStartRaw ? new Date(malStartRaw) : null;
    const malCap = Number(showEpisodes.find((x) => Number.isFinite(Number(x.malEpisodes)))?.malEpisodes);
    let offset = 0;

    if (Number.isFinite(first.ep) && first.ep > 9 && malStart && !Number.isNaN(malStart.getTime())) {
      const startDays = Math.abs((first.d.getTime() - malStart.getTime()) / (24 * 3600 * 1000));
      if (startDays <= 45) {
        offset = first.ep - 1;
      }
    }

    if (offset === 0 && Number.isFinite(malCap) && malCap > 0 && Number.isFinite(first.ep) && first.ep > malCap) {
      const startDays = malStart && !Number.isNaN(malStart.getTime())
        ? Math.abs((first.d.getTime() - malStart.getTime()) / (24 * 3600 * 1000))
        : Number.POSITIVE_INFINITY;
      if (startDays <= 90) {
        offset = first.ep - 1;
      }
    }

    if (offset === 0 && Number.isFinite(malCap) && malCap > 0) {
      const maxSeen = Math.max(...withNum.map((x) => x.ep));
      const minSeen = Math.min(...withNum.map((x) => x.ep));
      if (maxSeen > malCap && minSeen > malCap) {
        const inferred = maxSeen - malCap;
        if (inferred >= 1 && inferred <= minSeen - 1) {
          offset = inferred;
        }
      }
    }

    offsetByGroup.set(groupKey, Math.max(0, offset));
  }

  return episodes.map((ep) => {
    const malId = Number(ep.malId);
    if (!Number.isFinite(malId) || malId <= 0) {
      return ep;
    }
    const groupKey = `${malId}|${ep.audio}`;
    const offset = offsetByGroup.get(groupKey) || 0;
    const rawEp = parseEpisodeNum(ep.episode);
    if (!Number.isFinite(rawEp)) {
      return ep;
    }
    const adjusted = Math.max(1, rawEp - offset);
    return {
      ...ep,
      seasonEpisode: String(adjusted),
    };
  });
}

async function scrapeLineupTitles(page, url) {
  try {
    console.log(`Loading lineup ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(4000);
    return await page.evaluate(() => {
      const headingTexts = [...document.querySelectorAll("h2, h3")]
        .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
      const seriesTexts = [...document.querySelectorAll("a[href*='/series/']")]
        .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
      const raw = [...headingTexts, ...seriesTexts];
      const blocked = /opens in a new tab|watch now|play|start watching|lineup|seasonal lineup|simulcasts|picks|see also|announced|join crunchyroll|published|updated/i;
      const titles = raw
        .filter((text) => text.length > 2 && text.length < 120)
        .filter((text) => !blocked.test(text))
        .map((text) => text.replace(/\s+Season\s+\d+.*$/i, "").trim())
        .map((text) => text.replace(/\s+Cour\s+\d+.*$/i, "").trim())
        .filter(Boolean);
      return [...new Set(titles)];
    });
  } catch (error) {
    console.warn(`Failed to parse lineup page: ${error.message}`);
    return [];
  }
}

function buildScanWeekDates() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const range = buildScanRange(today);
  const weeks = new Set();
  const cursor = new Date(range.start);
  while (cursor <= range.end) {
    const monday = toMonday(cursor);
    const iso = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
    weeks.add(iso);
    cursor.setDate(cursor.getDate() + 1);
  }
  return [...weeks].sort();
}

function buildScanRange(today) {
  const start = new Date(today.getFullYear(), today.getMonth() - PAST_MONTHS_TO_INCLUDE, 1);
  start.setHours(0, 0, 0, 0);

  const end = endOfCurrentSeason(today);
  end.setHours(23, 59, 59, 999);

  return { start, end };
}

function endOfCurrentSeason(today) {
  const year = today.getFullYear();
  const month = today.getMonth();

  if (month <= 2) {
    return new Date(year, 2, 31);
  }
  if (month <= 5) {
    return new Date(year, 5, 30);
  }
  if (month <= 8) {
    return new Date(year, 8, 30);
  }
  return new Date(year, 11, 31);
}

function toMonday(source) {
  const d = new Date(source);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

async function scrapeCalendarDay(page, url, dayText) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);

    const title = await page.title();
    if (/just a moment/i.test(title)) {
      console.warn(`Cloudflare challenge at ${url}`);
      return [];
    }

    return await page.evaluate(() => {
      const cards = [...document.querySelectorAll("article.release")];
      const rows = [];

      for (const card of cards) {
        const watchAnchor = card.querySelector("a.available-episode-link.js-episode-link-available[href*='/watch/']")
          || card.querySelector("a.js-play-episode[href*='/watch/']")
          || card.querySelector("a[href*='/watch/']");
        if (!watchAnchor) {
          continue;
        }

        const href = watchAnchor.getAttribute("href") || "";
        const episodeUrl = href.startsWith("http") ? href : `https://www.crunchyroll.com${href}`;
        const seriesAnchor = card.querySelector("a[href*='/series/']");
        const seriesHref = seriesAnchor?.getAttribute("href") || "";
        const seriesUrl = seriesHref
          ? (seriesHref.startsWith("http") ? seriesHref : `https://www.crunchyroll.com${seriesHref}`)
          : "";
        const imageEl = card.querySelector("img");
        const rawThumb = imageEl?.getAttribute("src") || imageEl?.getAttribute("data-src") || "";
        const thumbnailUrl = rawThumb
          ? (rawThumb.startsWith("http") ? rawThumb : `https://www.crunchyroll.com${rawThumb}`)
          : "";
        const cardText = (card.textContent || "").replace(/\s+/g, " ").trim();
        const timeEl = card.querySelector("time.available-time[datetime]") || card.querySelector("time[datetime]");
        const dt = timeEl?.getAttribute("datetime") || "";
        const timeText = (timeEl?.textContent || "").trim();
        const seasonName = (card.querySelector(".season-name")?.textContent || "").trim();
        const episodeName = (card.querySelector(".episode-name")?.textContent || "").trim();
        const episodeLabel = (card.querySelector(".available-episode-link")?.textContent || "").trim();
        rows.push({
          episodeUrl,
          cardText,
          seasonName,
          episodeName,
          episodeLabel,
          dateTime: dt,
          timeText,
          seriesUrl,
          thumbnailUrl,
        });
      }
      return rows;
    });
  } catch (error) {
    console.warn(`Failed ${url}: ${error.message}`);
    return [];
  }
}

function normalizeAndDedupe(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const normalized = normalizeRow(row);
    if (!normalized) {
      continue;
    }
    const key = [
      normalized.title,
      normalized.episode,
      normalized.audio,
      normalized.releaseDateTime,
    ].join("|");

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, normalized);
      continue;
    }

    const existingId = extractWatchId(existing.episodeUrl);
    const nextId = extractWatchId(normalized.episodeUrl);
    const existingIsJp = watchIdLocale(existingId) === "JAJP";
    const nextIsJp = watchIdLocale(nextId) === "JAJP";
    if (!existingIsJp && nextIsJp) {
      byKey.set(key, normalized);
    }
  }
  return [...byKey.values()].sort(
    (a, b) => new Date(a.releaseDateTime).getTime() - new Date(b.releaseDateTime).getTime(),
  );
}

function normalizeRow(row) {
  const episodeUrl = normalizeWatchUrl(row.episodeUrl);
  if (!episodeUrl) {
    return null;
  }

  const watchId = extractWatchId(episodeUrl);
  const locale = watchIdLocale(watchId);
  const { title, audio } = parseSeasonAudio(row.seasonName, locale);
  const episode = parseEpisodeNumber(row.episodeLabel, row.episodeName);
  const releaseDate = pickDate(row.dateTime, row.timeText);
  if (!releaseDate) {
    return null;
  }

  return {
    title,
    episode,
    audio,
    releaseDateTime: releaseDate.toISOString(),
    seriesUrl: row.seriesUrl || "",
    episodeUrl,
    thumbnailUrl: row.thumbnailUrl || "",
    airdateSource: "crunchyroll",
    projected: false,
  };
}

function parseSeasonAudio(seasonName, locale) {
  const clean = cleanTitle(seasonName || "Unknown Title");

  const explicitDub = clean.match(/\(([^)]*dub[^)]*)\)/i);
  if (explicitDub) {
    const audio = cleanTitle(explicitDub[1]).replace(/\bDub\b/i, "Dub");
    const title = cleanTitle(stripSeasonSuffix(clean).replace(/\(([^)]*dub[^)]*)\)/gi, ""));
    return { title: title || "Unknown Title", audio };
  }

  const languageMarker = clean.match(/\((English|Deutsch|Français|Español(?: \(América Latina\)| \(España\))?|Portugu[eê]s(?: \(Brasil\))?|Italiano|العربية|हिंदी|தமிழ்|తెలుగు|ไทย|Bahasa Indonesia|Castilian|Russian)\)/i);
  if (languageMarker) {
    const language = cleanTitle(languageMarker[1]);
    const title = cleanTitle(stripSeasonSuffix(clean).replace(languageMarker[0], ""));
    if (/japanese/i.test(language)) {
      return { title: title || "Unknown Title", audio: "Japanese (Original)" };
    }
    return { title: title || "Unknown Title", audio: `${language} Dub` };
  }

  const fallbackTitle = cleanTitle(stripSeasonSuffix(clean).replace(/\([^)]*\)/g, ""));
  if (locale === "JAJP") {
    return { title: fallbackTitle || "Unknown Title", audio: "Japanese (Original)" };
  }
  return { title: fallbackTitle || "Unknown Title", audio: "Japanese (Original)" };
}

function parseEpisodeNumber(episodeLabel, episodeName) {
  const direct = `${episodeLabel || ""} ${episodeName || ""}`;
  const match = direct.match(/episode\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (match) {
    return match[1];
  }
  return "TBD";
}

function pickDate(dateTime) {
  if (dateTime) {
    const dt = new Date(dateTime);
    if (!Number.isNaN(dt.getTime())) {
      return dt;
    }
  }
  return null;
}

function buildProjectedUpcoming(episodes, seasonEnd, lineupTitleKeys) {
  const now = new Date();
  const rangeStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const byShow = new Map();

  for (const ep of episodes) {
    const malId = Number(ep.malId);
    const baseKey = Number.isFinite(malId) && malId > 0 ? `mal:${malId}` : `title:${ep.title}`;
    const key = `${baseKey}|${ep.audio}`;
    if (!byShow.has(key)) {
      byShow.set(key, []);
    }
    byShow.get(key).push(ep);
  }

  const projected = [];
  const existingSlotKeys = new Set(
    episodes.map((e) => `${e.title}|${e.audio}|${new Date(e.releaseDateTime).toISOString().slice(0, 16)}`),
  );
  const existingKeys = new Set(
    episodes.map((e) => `${e.title}|${e.audio}|${new Date(e.releaseDateTime).toISOString().slice(0, 16)}|${e.episode}`),
  );

  for (const eps of byShow.values()) {
    const sorted = [...eps].sort((a, b) => new Date(a.releaseDateTime) - new Date(b.releaseDateTime));
    const withNum = sorted
      .map((e) => ({ e, ep: parseEpisodeNum(e.seasonEpisode ?? e.episode), d: new Date(e.releaseDateTime) }))
      .filter((x) => Number.isFinite(x.ep) && !Number.isNaN(x.d.getTime()));
    if (withNum.length === 0) {
      continue;
    }

    const last = withNum.reduce((best, cur) => (cur.ep > best.ep || (cur.ep === best.ep && cur.d > best.d) ? cur : best), withNum[0]).e;
    const lastDate = new Date(last.releaseDateTime);
    const lastEpisodeNum = parseEpisodeNum(last.seasonEpisode ?? last.episode);
    const malEpisodeCap = Number.isFinite(last.malEpisodes) ? Number(last.malEpisodes) : null;
    if (!Number.isFinite(lastEpisodeNum) || !malEpisodeCap) {
      continue;
    }

    const recent = sorted.filter((e) => new Date(e.releaseDateTime) >= new Date(now.getTime() - 42 * 24 * 3600 * 1000));
    const cadenceDays = inferCadenceDays(withNum.map((x) => x.e))
      || inferCadenceDays(recent)
      || 7;
    if (!cadenceDays) {
      continue;
    }

    const titleKey = normalizeTitleKey(last.title);
    if (lineupTitleKeys.size > 0 && !isLineupMatch(titleKey, lineupTitleKeys)) {
      continue;
    }
    if (now.getTime() - lastDate.getTime() > 65 * 24 * 3600 * 1000) {
      continue;
    }

    const premiere = withNum
      .filter((x) => x.ep === 1)
      .sort((a, b) => a.d - b.d)[0];
    const earliestKnown = withNum.reduce((best, cur) => (cur.ep < best.ep || (cur.ep === best.ep && cur.d < best.d) ? cur : best), withNum[0]);
    const malAiredTo = last.malAiredTo ? new Date(last.malAiredTo) : null;
    const projectionEnd = malAiredTo && !Number.isNaN(malAiredTo.getTime())
      ? new Date(Math.min(seasonEnd.getTime(), malAiredTo.getTime()))
      : seasonEnd;
    let baseEpisodeOneDate = null;
    if (premiere) {
      baseEpisodeOneDate = new Date(premiere.d);
    } else if (last.malAiredFrom) {
      const malStart = new Date(last.malAiredFrom);
      if (!Number.isNaN(malStart.getTime())) {
        baseEpisodeOneDate = malStart;
      }
    } else {
      baseEpisodeOneDate = new Date(earliestKnown.d);
      baseEpisodeOneDate.setDate(baseEpisodeOneDate.getDate() - (earliestKnown.ep - 1) * cadenceDays);
    }

    if (!baseEpisodeOneDate || Number.isNaN(baseEpisodeOneDate.getTime())) {
      continue;
    }

    const knownEpisodeNums = new Set(
      withNum.map((x) => String(x.ep)),
    );

    for (let episodeNum = 1; episodeNum <= malEpisodeCap; episodeNum += 1) {
      const epValue = String(episodeNum);
      if (knownEpisodeNums.has(epValue)) {
        continue;
      }

      const episodeDate = new Date(baseEpisodeOneDate);
      episodeDate.setDate(baseEpisodeOneDate.getDate() + (episodeNum - 1) * cadenceDays);
      if (episodeDate < rangeStart) {
        continue;
      }
      if (episodeDate > projectionEnd) {
        break;
      }

      const key = `${last.title}|${last.audio}|${episodeDate.toISOString().slice(0, 16)}|${epValue}`;
      const slotKey = `${last.title}|${last.audio}|${episodeDate.toISOString().slice(0, 16)}`;
      if (existingSlotKeys.has(slotKey)) {
        continue;
      }
      if (existingKeys.has(key)) {
        continue;
      }
      existingKeys.add(key);
      existingSlotKeys.add(slotKey);

      projected.push({
        title: last.title,
        episode: epValue,
        seasonEpisode: epValue,
        audio: last.audio,
        releaseDateTime: episodeDate.toISOString(),
        seriesUrl: last.seriesUrl || "",
        episodeUrl: last.seriesUrl || last.episodeUrl,
        thumbnailUrl: last.thumbnailUrl || "",
        malId: last.malId || null,
        malTitle: last.malTitle || "",
        malEpisodes: last.malEpisodes ?? null,
        malAiredFrom: last.malAiredFrom || null,
        malAiredTo: last.malAiredTo || null,
        airdateSource: "mal",
        projected: true,
      });
    }
  }

  return projected;
}

function isLineupMatch(titleKey, lineupTitleKeys) {
  if (lineupTitleKeys.has(titleKey)) {
    return true;
  }
  for (const key of lineupTitleKeys) {
    if (titleKey.includes(key) || key.includes(titleKey)) {
      return true;
    }
  }
  return false;
}

function inferCadenceDays(episodes) {
  const diffs = [];
  const sorted = [...episodes].sort((a, b) => new Date(a.releaseDateTime) - new Date(b.releaseDateTime));
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = new Date(sorted[i - 1].releaseDateTime);
    const curr = new Date(sorted[i].releaseDateTime);
    const days = (curr.getTime() - prev.getTime()) / (24 * 3600 * 1000);
    if (days >= 5 && days <= 9) {
      diffs.push(days);
    }
  }
  if (diffs.length === 0) {
    return null;
  }
  const avg = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  return Math.round(avg);
}

function parseEpisodeNum(value) {
  const m = String(value || "").match(/[0-9]+(?:\.[0-9]+)?/);
  return m ? Number(m[0]) : Number.NaN;
}

function normalizeWatchUrl(value) {
  try {
    const input = new URL(value);
    const parts = input.pathname.split("/").filter(Boolean);
    if (parts[0] !== "watch" || !parts[1]) {
      return "";
    }
    return `https://www.crunchyroll.com/watch/${parts[1]}`;
  } catch {
    return "";
  }
}

function cleanTitle(value) {
  return String(value || "Unknown Title").replace(/\s+/g, " ").trim();
}

function stripSeasonSuffix(value) {
  return cleanTitle(value).replace(/\s+Season\s+\d+.*$/i, "").trim();
}

function normalizeTitleKey(value) {
  return cleanTitle(value)
    .replace(/\s+Season\s+\d+.*$/i, "")
    .replace(/\s+Cour\s+\d+.*$/i, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
}

function extractWatchId(url) {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return parts[1] || "";
  } catch {
    return "";
  }
}

function watchIdLocale(watchId) {
  const match = String(watchId || "").match(/([A-Z]{4,5})$/);
  return match ? match[1] : "";
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

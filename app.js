const monthLabel = document.getElementById("monthLabel");
const calendarGrid = document.getElementById("calendarGrid");
const upcomingList = document.getElementById("upcomingList");
const prevMonthButton = document.getElementById("prevMonth");
const nextMonthButton = document.getElementById("nextMonth");
const dayCellTemplate = document.getElementById("dayCellTemplate");
const eventTemplate = document.getElementById("eventTemplate");
const syncMeta = document.getElementById("syncMeta");
const audioFilter = document.getElementById("audioFilter");
const viewModeSelect = document.getElementById("viewMode");
const weekdayRow = document.getElementById("weekdayRow");

const AUDIO_ALL = "All Audio";
const AUDIO_DEFAULT = "Japanese (Original)";
const AUDIO_FILTER_STORAGE_KEY = "crunchyroll_audio_filter_v1";
const VIEW_MODE_STORAGE_KEY = "crunchyroll_view_mode_v1";

let schedule = [];
let metadata = null;
let hoverCard = null;
let selectedAudio = localStorage.getItem(AUDIO_FILTER_STORAGE_KEY) || AUDIO_DEFAULT;
let currentViewMode = localStorage.getItem(VIEW_MODE_STORAGE_KEY) || "month";
let currentCursor = new Date();
currentCursor.setHours(0, 0, 0, 0);

init();

async function init() {
  const data = await loadSchedule();
  schedule = markFinaleEpisodes(data.episodes.map(normalizeEpisodeAudio));
  metadata = data.metadata;

  if (!["month", "week", "day"].includes(currentViewMode)) {
    currentViewMode = "month";
  }
  viewModeSelect.value = currentViewMode;

  buildAudioFilterOptions();
  if (currentViewMode === "month") {
    currentCursor = chooseInitialMonth(currentCursor, getFilteredSchedule());
  }
  wireControls();
  setupHoverCard();
  render();
}

function wireControls() {
  prevMonthButton.addEventListener("click", () => {
    shiftCursor(-1);
    render();
  });

  nextMonthButton.addEventListener("click", () => {
    shiftCursor(1);
    render();
  });

  audioFilter.addEventListener("change", () => {
    selectedAudio = audioFilter.value;
    localStorage.setItem(AUDIO_FILTER_STORAGE_KEY, selectedAudio);
    if (currentViewMode === "month") {
      currentCursor = chooseInitialMonth(currentCursor, getFilteredSchedule());
    }
    render();
  });

  viewModeSelect.addEventListener("change", () => {
    currentViewMode = viewModeSelect.value;
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, currentViewMode);
    if (currentViewMode === "month") {
      currentCursor = new Date(currentCursor.getFullYear(), currentCursor.getMonth(), 1);
    }
    render();
  });
}

async function loadSchedule() {
  try {
    const response = await fetch("data/schedule.json");
    if (!response.ok) {
      throw new Error("Could not load data/schedule.json");
    }

    const data = await response.json();
    const episodes = (data.episodes || [])
      .map((item) => ({ ...item, date: new Date(item.releaseDateTime) }))
      .filter((item) => !Number.isNaN(item.date.getTime()))
      .sort((a, b) => a.date - b.date);
    const scheduleMetadata = {
      generatedAt: data.generatedAt || null,
      sourceUrls: Array.isArray(data.sourceUrls) ? data.sourceUrls : [],
    };
    return { episodes, metadata: scheduleMetadata };
  } catch (error) {
    console.error(error);
    return { episodes: [], metadata: null };
  }
}

function render() {
  renderPeriodLabel();
  renderCalendar();
  renderTodayList();
  renderMetadata();
}

function renderPeriodLabel() {
  if (currentViewMode === "month") {
    monthLabel.textContent = currentCursor.toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    });
    return;
  }

  if (currentViewMode === "week") {
    const weekStart = startOfWeek(currentCursor);
    monthLabel.textContent = `Week of ${weekStart.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    })}`;
    return;
  }

  monthLabel.textContent = currentCursor.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function renderCalendar() {
  const filteredSchedule = getFilteredSchedule();
  calendarGrid.dataset.view = currentViewMode;
  weekdayRow.style.display = currentViewMode === "day" ? "none" : "grid";
  calendarGrid.innerHTML = "";

  if (currentViewMode === "month") {
    renderMonthGrid(filteredSchedule);
    return;
  }

  if (currentViewMode === "week") {
    renderWeekGrid(filteredSchedule);
    return;
  }

  renderDayGrid(filteredSchedule);
}

function renderMonthGrid(filteredSchedule) {
  const monthStart = new Date(currentCursor.getFullYear(), currentCursor.getMonth(), 1);
  const monthEnd = new Date(currentCursor.getFullYear(), currentCursor.getMonth() + 1, 0);
  const startOffset = monthStart.getDay();
  const totalCells = Math.ceil((startOffset + monthEnd.getDate()) / 7) * 7;

  for (let i = 0; i < totalCells; i += 1) {
    const date = new Date(monthStart);
    date.setDate(i - startOffset + 1);
    const isCurrentMonth = date.getMonth() === currentCursor.getMonth();
    calendarGrid.appendChild(buildDayNode(filteredSchedule, date, isCurrentMonth));
  }
}

function renderWeekGrid(filteredSchedule) {
  const weekStart = startOfWeek(currentCursor);
  for (let i = 0; i < 7; i += 1) {
    const date = new Date(weekStart);
    date.setDate(weekStart.getDate() + i);
    calendarGrid.appendChild(buildDayNode(filteredSchedule, date, true));
  }
}

function renderDayGrid(filteredSchedule) {
  calendarGrid.appendChild(buildDayNode(filteredSchedule, currentCursor, true));
}

function buildDayNode(filteredSchedule, date, isCurrentMonth) {
  const today = new Date();
  const dayEvents = scheduleForDay(filteredSchedule, date);
  const dayNode = dayCellTemplate.content.firstElementChild.cloneNode(true);
  dayNode.querySelector(".day-number").textContent = formatDayHeader(date);

  if (!isCurrentMonth) {
    dayNode.classList.add("other-month");
  }
  if (sameDay(date, today)) {
    dayNode.classList.add("today");
  }

  const dayEventsList = dayNode.querySelector(".day-events");
  dayEvents.forEach((event) => {
    const eventNode = eventTemplate.content.firstElementChild.cloneNode(true);
    const eventLink = eventNode.querySelector(".event-link");
    eventLink.href = event.episodeUrl;
    const estimateTag = event.projected ? " (est.)" : "";
    const displayEpisode = event.seasonEpisode || event.episode;
    const fullLabel = `${event.title} - Ep ${displayEpisode}${estimateTag}`;
    if (currentViewMode === "day") {
      eventLink.classList.add("day-card-link");
      const timeChip = document.createElement("span");
      timeChip.className = "event-time-chip";
      timeChip.textContent = formatTime(event.date);

      const mainLine = document.createElement("span");
      mainLine.className = "event-main-line";
      mainLine.textContent = fullLabel;

      eventLink.appendChild(timeChip);
      eventLink.appendChild(mainLine);
    } else {
      eventLink.textContent = fullLabel;
    }
    if (event.isFinale) {
      eventLink.classList.add("finale-event");
    }
    if (isPremiereEpisode(event)) {
      eventLink.classList.add("premiere-event");
    }
    eventLink.dataset.title = event.title || "";
    eventLink.dataset.episode = displayEpisode || "TBD";
    eventLink.dataset.airtime = formatDateTime(event.date);
    eventLink.dataset.thumbnail = event.thumbnailUrl || "";
    eventLink.dataset.projected = event.projected ? "true" : "false";
    eventLink.dataset.finale = event.isFinale ? "true" : "false";
    eventLink.dataset.airdatesource = event.airdateSource || "crunchyroll";
    dayEventsList.appendChild(eventNode);
  });

  return dayNode;
}

function formatDayHeader(date) {
  if (currentViewMode === "month") {
    return date.getDate();
  }
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function renderTodayList() {
  const filteredSchedule = getFilteredSchedule();
  upcomingList.innerHTML = "";
  const now = new Date();
  const listItems = filteredSchedule
    .filter((item) => sameDay(item.date, now))
    .sort((a, b) => a.date - b.date);

  if (listItems.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No episodes scheduled for today.";
    upcomingList.appendChild(empty);
    return;
  }

  listItems.forEach((item) => {
    const row = document.createElement("li");
    const link = document.createElement("a");
    link.href = item.episodeUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const estimateTag = item.projected ? " (Estimated)" : "";
    const statusTag = item.date <= now ? "Aired" : "Upcoming";
    const displayEpisode = item.seasonEpisode || item.episode;
    link.textContent = `${formatTime(item.date)} - ${item.title} Ep ${displayEpisode} [${statusTag}]${estimateTag}`;
    row.appendChild(link);
    upcomingList.appendChild(row);
  });
}

function scheduleForDay(items, date) {
  return items.filter((item) => sameDay(item.date, date));
}

function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatDateTime(date) {
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatTime(date) {
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function renderMetadata() {
  if (!metadata || !metadata.generatedAt) {
    syncMeta.textContent = "Schedule metadata missing. Run the sync script to refresh data.";
    return;
  }

  const generated = new Date(metadata.generatedAt);
  const generatedLabel = Number.isNaN(generated.getTime())
    ? metadata.generatedAt
    : generated.toLocaleString();
  const sourceCount = metadata.sourceUrls.length;
  syncMeta.textContent = `Last synced: ${generatedLabel}. Sources scanned: ${sourceCount}. Audio filter: ${selectedAudio}. View: ${currentViewMode}.`;
}

function chooseInitialMonth(selectedMonth, items) {
  if (items.length === 0) {
    return selectedMonth;
  }

  if (hasEventsInMonth(selectedMonth, items)) {
    return new Date(selectedMonth.getFullYear(), selectedMonth.getMonth(), 1);
  }

  const now = new Date();
  const nearest = [...items].sort(
    (a, b) => Math.abs(a.date.getTime() - now.getTime()) - Math.abs(b.date.getTime() - now.getTime()),
  )[0];
  const target = new Date(nearest.date.getFullYear(), nearest.date.getMonth(), 1);
  target.setHours(0, 0, 0, 0);
  return target;
}

function hasEventsInMonth(monthDate, items) {
  return items.some(
    (item) =>
      item.date.getFullYear() === monthDate.getFullYear() &&
      item.date.getMonth() === monthDate.getMonth(),
  );
}

function buildAudioFilterOptions() {
  const audioSet = new Set(schedule.map((item) => item.audio || AUDIO_DEFAULT));
  const options = [AUDIO_DEFAULT, ...[...audioSet].filter((a) => a !== AUDIO_DEFAULT).sort(), AUDIO_ALL];
  audioFilter.innerHTML = "";

  options.forEach((audio) => {
    const option = document.createElement("option");
    option.value = audio;
    option.textContent = audio;
    audioFilter.appendChild(option);
  });

  if (!options.includes(selectedAudio)) {
    selectedAudio = AUDIO_DEFAULT;
  }
  audioFilter.value = selectedAudio;
}

function getFilteredSchedule() {
  if (selectedAudio === AUDIO_ALL) {
    return schedule;
  }
  return schedule.filter((item) => (item.audio || AUDIO_DEFAULT) === selectedAudio);
}

function normalizeEpisodeAudio(item) {
  const rawTitle = String(item.title || "Unknown Title").trim();
  const dubMatch = rawTitle.match(/^(.*?)\s*\(([^)]+dub)\)\s*$/i);
  if (dubMatch) {
    return {
      ...item,
      title: dubMatch[1].trim(),
      audio: item.audio || dubMatch[2].trim(),
    };
  }

  return {
    ...item,
    audio: item.audio || AUDIO_DEFAULT,
  };
}

function shiftCursor(direction) {
  if (currentViewMode === "month") {
    currentCursor = new Date(currentCursor.getFullYear(), currentCursor.getMonth() + direction, 1);
    return;
  }
  if (currentViewMode === "week") {
    const next = new Date(currentCursor);
    next.setDate(next.getDate() + direction * 7);
    currentCursor = next;
    return;
  }
  const next = new Date(currentCursor);
  next.setDate(next.getDate() + direction);
  currentCursor = next;
}

function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

function setupHoverCard() {
  hoverCard = document.createElement("div");
  hoverCard.className = "event-hover-card";
  hoverCard.innerHTML = `
    <img class="event-hover-thumb" alt="" />
    <div class="event-hover-body">
      <p class="event-hover-finale">Finale</p>
      <p class="event-hover-title"></p>
      <p class="event-hover-episode"></p>
      <p class="event-hover-airtime"></p>
      <p class="event-hover-source"></p>
    </div>
  `;
  document.body.appendChild(hoverCard);

  calendarGrid.addEventListener("mouseover", (event) => {
    const link = event.target.closest(".event-link");
    if (!link) {
      return;
    }
    showHoverCard(link, event);
  });

  calendarGrid.addEventListener("mousemove", (event) => {
    if (!hoverCard.classList.contains("visible")) {
      return;
    }
    positionHoverCard(event.clientX, event.clientY);
  });

  calendarGrid.addEventListener("mouseout", (event) => {
    if (event.target.closest(".event-link")) {
      hideHoverCard();
    }
  });
}

function showHoverCard(link, mouseEvent) {
  const title = link.dataset.title || "Unknown";
  const episode = link.dataset.episode || "TBD";
  const airtime = link.dataset.airtime || "";
  const thumbnail = link.dataset.thumbnail || "";
  const projected = link.dataset.projected === "true";
  const finale = link.dataset.finale === "true";
  const airdateSource = link.dataset.airdatesource === "mal" ? "MyAnimeList" : "Crunchyroll";

  const finaleEl = hoverCard.querySelector(".event-hover-finale");
  finaleEl.style.display = finale ? "inline-block" : "none";
  hoverCard.querySelector(".event-hover-title").textContent = title;
  hoverCard.querySelector(".event-hover-episode").textContent = `Episode: ${episode}${projected ? " (Estimated)" : ""}`;
  hoverCard.querySelector(".event-hover-airtime").textContent = `Airtime: ${airtime}`;
  hoverCard.querySelector(".event-hover-source").textContent = `Airdate Source: ${airdateSource}`;

  const thumbEl = hoverCard.querySelector(".event-hover-thumb");
  if (thumbnail) {
    thumbEl.src = thumbnail;
    thumbEl.style.display = "block";
  } else {
    thumbEl.removeAttribute("src");
    thumbEl.style.display = "none";
  }

  hoverCard.classList.add("visible");
  positionHoverCard(mouseEvent.clientX, mouseEvent.clientY);
}

function positionHoverCard(mouseX, mouseY) {
  const margin = 14;
  const rect = hoverCard.getBoundingClientRect();
  let x = mouseX + margin;
  let y = mouseY + margin;

  if (x + rect.width > window.innerWidth - 8) {
    x = mouseX - rect.width - margin;
  }
  if (y + rect.height > window.innerHeight - 8) {
    y = mouseY - rect.height - margin;
  }

  hoverCard.style.left = `${Math.max(8, x)}px`;
  hoverCard.style.top = `${Math.max(8, y)}px`;
}

function hideHoverCard() {
  hoverCard.classList.remove("visible");
}

function markFinaleEpisodes(items) {
  const byShow = new Map();
  const now = new Date();

  items.forEach((item) => {
    const key = `${item.title}|${item.audio || AUDIO_DEFAULT}`;
    if (!byShow.has(key)) {
      byShow.set(key, []);
    }
    byShow.get(key).push(item);
  });

  const finaleKeys = new Set();
  byShow.forEach((showItems) => {
    const malTotalRaw = showItems.find((x) => Number.isFinite(Number(x.malEpisodes)))?.malEpisodes;
    const malTotal = Number(malTotalRaw);
    if (!Number.isFinite(malTotal)) {
      return;
    }

    const withNum = showItems
      .map((it) => ({ it, ep: parseEpisodeNum(it.seasonEpisode ?? it.episode), t: it.date.getTime() }))
      .filter((x) => Number.isFinite(x.ep));
    if (withNum.length === 0) {
      return;
    }

    const maxSeen = Math.max(...withNum.map((x) => x.ep));
    if (maxSeen > malTotal + 1) {
      return;
    }

    const malMatches = withNum.filter((x) => x.ep === malTotal);
    if (malMatches.length > 0) {
      const latestTime = Math.max(...malMatches.map((x) => x.t));
      malMatches
        .filter((x) => x.t === latestTime)
        .forEach((x) => finaleKeys.add(buildEpisodeKey(x.it)));
      return;
    }

    const airedToRaw = showItems.find((x) => x.malAiredTo)?.malAiredTo;
    if (!airedToRaw) {
      return;
    }

    const airedTo = new Date(airedToRaw);
    if (Number.isNaN(airedTo.getTime()) || airedTo > now) {
      return;
    }

    const latestTime = Math.max(...withNum.map((x) => x.t));
    withNum
      .filter((x) => x.t === latestTime)
      .forEach((x) => finaleKeys.add(buildEpisodeKey(x.it)));
  });

  return items.map((item) => ({
    ...item,
    isFinale: finaleKeys.has(buildEpisodeKey(item)),
  }));
}

function buildEpisodeKey(item) {
  return `${item.title}|${item.audio || AUDIO_DEFAULT}|${item.episode}|${item.releaseDateTime}`;
}

function parseEpisodeNum(value) {
  const m = String(value || "").match(/[0-9]+(?:\.[0-9]+)?/);
  return m ? Number(m[0]) : Number.NaN;
}

function isPremiereEpisode(item) {
  const seasonEp = parseEpisodeNum(item.seasonEpisode ?? item.episode);
  if (seasonEp === 1) {
    return true;
  }

  if (!item.malAiredFrom) {
    return false;
  }
  const malStart = new Date(item.malAiredFrom);
  if (Number.isNaN(malStart.getTime()) || Number.isNaN(item.date.getTime())) {
    return false;
  }
  const days = Math.abs((item.date.getTime() - malStart.getTime()) / (24 * 3600 * 1000));
  return days <= 5;
}

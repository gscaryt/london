'use strict';

/* ===========================================================
   Constants
   =========================================================== */

const LINE_NAMES = {
  bakerloo: 'Bakerloo',
  central: 'Central',
  circle: 'Circle',
  district: 'District',
  'hammersmith-city': 'Hammersmith & City',
  jubilee: 'Jubilee',
  metropolitan: 'Metropolitan',
  northern: 'Northern',
  piccadilly: 'Piccadilly',
  victoria: 'Victoria',
  'waterloo-city': 'Waterloo & City',
  elizabeth: 'Elizabeth line',
  liberty: 'Liberty line',
  lioness: 'Lioness line',
  mildmay: 'Mildmay line',
  suffragette: 'Suffragette line',
  weaver: 'Weaver line',
  windrush: 'Windrush line'
};

const TFL_MAP_URL = 'https://tfl.gov.uk/maps/track/tube';

// Fixed enum (SPEC.md §3). Order here controls grouping order on the
// station page — spoons and fact are pinned near the top per spec.
const CATEGORY_ORDER = ['spoons', 'fact', 'indie_pub', 'history', 'sight', 'food', 'oddity', 'park'];
const CATEGORY_LABELS = {
  spoons: 'Wetherspoons',
  indie_pub: 'Indie Pub',
  history: 'History',
  fact: 'Fact',
  sight: 'Sight',
  food: 'Food',
  oddity: 'Oddity',
  park: 'Park'
};

const USER_ENTRIES_KEY = 'tsg.userEntries';

/* ===========================================================
   State
   =========================================================== */

let CONFIG = null;
let STATIONS = [];
const STATIONS_BY_ID = new Map();
let TAGS = new Set();

const LINE_CACHE = new Map();        // lineId -> line data object, or null if unavailable
const LINE_LOAD_PROMISES = new Map(); // lineId -> in-flight/settled promise

let USER_ENTRIES = [];

/* ===========================================================
   Fetch helpers
   =========================================================== */

async function fetchJSON(url, required) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } catch (err) {
    if (required) {
      console.error(`Failed to load required data: ${url}`, err);
      throw err;
    }
    console.warn(`No data at ${url} (${err.message}) — treating as unavailable.`);
    return null;
  }
}

function loadLine(lineId) {
  if (LINE_LOAD_PROMISES.has(lineId)) return LINE_LOAD_PROMISES.get(lineId);
  const p = fetchJSON(`data/lines/${lineId}.json?v=${CONFIG.dataVersion}`, false)
    .then((data) => {
      LINE_CACHE.set(lineId, data);
      return data;
    });
  LINE_LOAD_PROMISES.set(lineId, p);
  return p;
}

function getAllLineIds() {
  const set = new Set();
  STATIONS.forEach((s) => s.lines.forEach((l) => set.add(l)));
  return [...set];
}

function prefetchAllLines() {
  const ids = getAllLineIds();
  return Promise.allSettled(ids.map(loadLine)).then(() => {
    const route = parseHash();
    if (route.name === 'home' || route.name === 'line') softRerender();
  });
}

/* ===========================================================
   localStorage — user entries
   =========================================================== */

function loadUserEntries() {
  try {
    const raw = localStorage.getItem(USER_ENTRIES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('Could not read tsg.userEntries from localStorage', err);
    return [];
  }
}

function saveUserEntries() {
  localStorage.setItem(USER_ENTRIES_KEY, JSON.stringify(USER_ENTRIES));
}

/* ===========================================================
   Data helpers
   =========================================================== */

function stationIdsOf(entry) {
  return Array.isArray(entry.stationId) ? entry.stationId : [entry.stationId];
}

function validateTags(entry) {
  (entry.tags || []).forEach((tag) => {
    if (!TAGS.has(tag)) {
      console.warn(`Unknown tag "${tag}" on entry ${entry.id} — not in data/tags.json`);
    }
  });
}

// Merge curated (all loaded lines a station belongs to) + user entries for one station.
// Dedupes by entry id; tolerates stationIds not present in stations.json.
function entriesForStation(stationId) {
  const merged = new Map();
  const station = STATIONS_BY_ID.get(stationId);
  const lines = station ? station.lines : [];

  lines.forEach((lineId) => {
    const line = LINE_CACHE.get(lineId);
    if (!line) return;
    line.entries.forEach((entry) => {
      if (!stationIdsOf(entry).includes(stationId)) return;
      if (merged.has(entry.id)) return;
      validateTags(entry);
      merged.set(entry.id, entry);
    });
  });

  USER_ENTRIES.forEach((entry) => {
    if (!stationIdsOf(entry).includes(stationId)) return;
    if (merged.has(entry.id)) return;
    validateTags(entry);
    merged.set(entry.id, entry);
  });

  return [...merged.values()];
}

// Lines with forks define `route`: an ordered array of segments, each either
// `{ stations: [...] }` (fixed trunk) or `{ branches: [{id, name, stations}, ...] }`
// (a fork — rider picks one via a pill toggle). Lines without forks just use
// the plain `stationOrder` array. `selections` maps route-segment-index -> chosen
// branch index (defaults to 0, i.e. the first-listed branch).
function effectiveStationOrder(line, selections) {
  if (!Array.isArray(line.route)) return line.stationOrder || [];
  const ids = [];
  line.route.forEach((seg, i) => {
    if (Array.isArray(seg.stations)) { ids.push(...seg.stations); return; }
    const branches = seg.branches || [];
    const branch = branches[selections[i] || 0] || branches[0];
    if (branch) ids.push(...branch.stations);
  });
  return ids;
}

function entryCountForLine(lineId, stationId) {
  const line = LINE_CACHE.get(lineId);
  if (!line) return 0;
  return line.entries.filter((e) => stationIdsOf(e).includes(stationId)).length;
}

function searchAll(query) {
  const q = query.trim().toLowerCase();
  if (!q) return { stations: [], entries: [] };

  const stations = STATIONS.filter((s) => s.name.toLowerCase().includes(q));

  const entries = [];
  LINE_CACHE.forEach((line) => {
    if (!line) return;
    line.entries.forEach((entry) => {
      const hay = `${entry.title} ${(entry.tags || []).join(' ')}`.toLowerCase();
      if (hay.includes(q)) entries.push(entry);
    });
  });
  USER_ENTRIES.forEach((entry) => {
    const hay = `${entry.title} ${(entry.tags || []).join(' ')}`.toLowerCase();
    if (hay.includes(q)) entries.push(entry);
  });

  return { stations, entries };
}

function firstKnownStationId(entry) {
  return stationIdsOf(entry).find((id) => STATIONS_BY_ID.has(id)) || null;
}

/* ===========================================================
   Small utilities
   =========================================================== */

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function safeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url, location.href);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
  } catch (err) { /* invalid URL */ }
  return '';
}

function snippet(text, len) {
  const t = String(text || '');
  return t.length > len ? `${t.slice(0, len).trim()}…` : t;
}

function mapsUrl(entry) {
  const q = entry.mapsQuery || entry.address || entry.title;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

function lineDisplayName(lineId) {
  return LINE_NAMES[lineId] || lineId;
}

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

/* ===========================================================
   Router
   =========================================================== */

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return { name: 'home' };
  if (parts[0] === 'line' && parts[1]) return { name: 'line', lineId: parts[1] };
  if (parts[0] === 'station' && parts[1]) return { name: 'station', stationId: parts[1] };
  if (parts[0] === 'add') return { name: 'add', stationId: parts[1] || null };
  if (parts[0] === 'borough' && parts[1]) return { name: 'boroughStations', borough: parts[1] };
  if (parts[0] === 'borough') return { name: 'boroughList' };
  return { name: 'home' };
}

function navigate(hash) {
  location.hash = hash;
}

const ROOT = () => document.getElementById('app');

function render() {
  const route = parseHash();
  const root = ROOT();
  root.innerHTML = '';
  window.scrollTo(0, 0);

  switch (route.name) {
    case 'home': return renderHome(root);
    case 'line': return renderLineView(root, route.lineId);
    case 'station': return renderStationView(root, route.stationId);
    case 'add': return renderAddScreen(root, route.stationId);
    case 'boroughList': return renderBoroughList(root);
    case 'boroughStations': return renderBoroughStations(root, route.borough);
    default: return renderHome(root);
  }
}

// Re-render without disturbing an in-progress search: used after background
// line prefetches complete, so cross-line search/counts light up live.
let lastHomeQuery = '';
function softRerender() {
  const route = parseHash();
  if (route.name !== 'home' && route.name !== 'line') { render(); return; }
  const active = document.activeElement;
  const isSearchFocused = active && active.id === 'search-input';
  const caret = isSearchFocused ? active.selectionStart : null;
  render();
  if (isSearchFocused) {
    const input = document.getElementById('search-input');
    if (input) {
      input.focus();
      if (caret !== null) input.setSelectionRange(caret, caret);
    }
  }
}

function topbar(root, title, backHash) {
  const bar = el('div', 'topbar');
  const back = el('button', 'topbar__back', '&larr;');
  back.setAttribute('aria-label', 'Back');
  back.addEventListener('click', () => {
    if (backHash) navigate(backHash);
    else history.back();
  });
  bar.appendChild(back);
  bar.appendChild(el('div', 'topbar__title', escapeHtml(title)));
  root.appendChild(bar);
  document.title = `${title} · Tube Stop Guide`;
}

/* ===========================================================
   Home screen
   =========================================================== */

function renderHome(root) {
  document.title = 'Tube Stop Guide';

  const hero = el('div', 'home-hero');
  hero.innerHTML = '<h1>Tube Stop Guide</h1><p>Pick a station, find something worth the walk.</p>';
  root.appendChild(hero);

  const searchBox = el('div', 'search-box');
  searchBox.innerHTML = `
    <label class="visually-hidden" for="search-input">Search stations, places, or tags</label>
    <input id="search-input" type="text" placeholder="Search &quot;warwick&quot;, &quot;roman&quot;, &quot;free&quot;…" autocomplete="off">
  `;
  root.appendChild(searchBox);

  const resultsContainer = el('div', 'search-results');
  const browseContainer = el('div');
  root.appendChild(resultsContainer);
  root.appendChild(browseContainer);

  function renderBrowse() {
    browseContainer.innerHTML = '';
    browseContainer.appendChild(el('div', 'section-label', 'Lines'));

    const list = el('div', 'line-list');
    const lineIds = getAllLineIds().sort((a, b) => lineDisplayName(a).localeCompare(lineDisplayName(b)));
    lineIds.forEach((lineId) => {
      const count = STATIONS.filter((s) => s.lines.includes(lineId)).length;
      const row = el('button', 'line-row');
      row.innerHTML = `
        <span class="line-roundel" style="background: var(--line-${escapeHtml(lineId)}, var(--text-muted))"></span>
        <span class="line-row__name">${escapeHtml(lineDisplayName(lineId))}</span>
        <span class="line-row__meta">${count} station${count === 1 ? '' : 's'}</span>
      `;
      row.addEventListener('click', () => navigate(`#/line/${lineId}`));
      list.appendChild(row);
    });
    browseContainer.appendChild(list);

    const boroughLink = el('button', 'secondary-link', 'Browse by borough →');
    boroughLink.addEventListener('click', () => navigate('#/borough'));
    browseContainer.appendChild(boroughLink);

    const mapLink = el('a', 'secondary-link', 'View official TfL tube map ↗');
    mapLink.href = TFL_MAP_URL;
    mapLink.target = '_blank';
    mapLink.rel = 'noopener';
    browseContainer.appendChild(mapLink);
  }

  function renderResults(query) {
    resultsContainer.innerHTML = '';
    if (!query.trim()) { browseContainer.style.display = ''; return; }
    browseContainer.style.display = 'none';

    const { stations, entries } = searchAll(query);

    if (!stations.length && !entries.length) {
      resultsContainer.appendChild(el('p', 'empty-state', 'Nothing matches yet.'));
      return;
    }

    if (stations.length) {
      resultsContainer.appendChild(el('div', 'search-results__group-label', 'Stations'));
      stations.forEach((s) => {
        const btn = el('button', 'search-result');
        btn.innerHTML = `<strong>${escapeHtml(s.name)}</strong><small>${escapeHtml(s.borough || '')}</small>`;
        btn.addEventListener('click', () => navigate(`#/station/${s.id}`));
        resultsContainer.appendChild(btn);
      });
    }

    if (entries.length) {
      resultsContainer.appendChild(el('div', 'search-results__group-label', 'Things to see'));
      entries.forEach((entry) => {
        const stationId = firstKnownStationId(entry);
        const station = stationId ? STATIONS_BY_ID.get(stationId) : null;
        const btn = el('button', 'search-result');
        btn.innerHTML = `<strong>${escapeHtml(entry.title)}</strong><small>${escapeHtml(station ? station.name : 'Unknown station')}</small>`;
        if (station) btn.addEventListener('click', () => navigate(`#/station/${station.id}`));
        else btn.disabled = true;
        resultsContainer.appendChild(btn);
      });
    }
  }

  const input = searchBox.querySelector('#search-input');
  input.value = lastHomeQuery;
  input.addEventListener('input', () => {
    lastHomeQuery = input.value;
    renderResults(input.value);
  });

  renderBrowse();
  renderResults(lastHomeQuery);
}

/* ===========================================================
   Line view
   =========================================================== */

async function renderLineView(root, lineId) {
  root.style.setProperty('--line-color', `var(--line-${lineId}, var(--text-muted))`);
  topbar(root, lineDisplayName(lineId), '#/');

  const placeholder = el('p', 'empty-state', 'Loading…');
  root.appendChild(placeholder);

  const line = await loadLine(lineId);
  placeholder.remove();

  const stationsOnLine = STATIONS.filter((s) => s.lines.includes(lineId));

  if (!line) {
    root.appendChild(el('div', 'line-empty-note',
      'No curated content file for this line yet — showing stations only.'));
  }

  const pillsEl = el('div', 'branch-pills-wrap');
  root.appendChild(pillsEl);

  const strip = el('div', 'line-strip');
  root.appendChild(strip);

  const selections = {};

  function renderPills() {
    pillsEl.innerHTML = '';
    if (!line || !Array.isArray(line.route)) return;
    line.route.forEach((seg, segIndex) => {
      const branches = seg.branches;
      if (!branches || branches.length < 2) return;
      const section = el('div', 'branch-section');
      const row = el('div', 'branch-pill-row');
      branches.forEach((branch, branchIndex) => {
        const chosen = (selections[segIndex] || 0) === branchIndex;
        const pill = el('button', 'branch-pill', escapeHtml(branch.name));
        pill.setAttribute('aria-pressed', String(chosen));
        pill.addEventListener('click', () => {
          selections[segIndex] = branchIndex;
          renderPills();
          renderStrip();
        });
        row.appendChild(pill);
      });
      section.appendChild(row);
      pillsEl.appendChild(section);
    });
  }

  function renderStrip() {
    strip.innerHTML = '';
    const orderedIds = line
      ? effectiveStationOrder(line, selections).filter((id) => STATIONS_BY_ID.has(id))
      : stationsOnLine.map((s) => s.id);

    orderedIds.forEach((stationId) => {
      const station = STATIONS_BY_ID.get(stationId);
      if (!station) return;
      const count = line ? entryCountForLine(lineId, stationId) : 0;
      const otherLines = station.lines.filter((l) => l !== lineId);

      const row = el('div', 'line-strip__station');
      row.innerHTML = `
        <div class="line-strip__rail"><span class="line-strip__tick"></span></div>
        <button class="line-strip__btn">
          <span>
            <span class="line-strip__name">${escapeHtml(station.name)}</span>
            ${otherLines.length ? `<div class="line-strip__interchange">+ ${otherLines.map(lineDisplayName).map(escapeHtml).join(', ')}</div>` : ''}
          </span>
          <span class="count-badge" data-nonzero="${count > 0}">${count}</span>
        </button>
      `;
      row.querySelector('.line-strip__btn').addEventListener('click', () => navigate(`#/station/${stationId}`));
      strip.appendChild(row);
    });
  }

  renderPills();
  renderStrip();
}

/* ===========================================================
   Station view
   =========================================================== */

async function renderStationView(root, stationId) {
  const station = STATIONS_BY_ID.get(stationId);
  if (!station) {
    topbar(root, 'Not found', '#/');
    root.appendChild(el('p', 'empty-state', 'This station isn’t in the registry yet.'));
    return;
  }

  topbar(root, station.name, '#/');

  const placeholder = el('p', 'empty-state', 'Loading…');
  root.appendChild(placeholder);
  await Promise.allSettled(station.lines.map(loadLine));
  placeholder.remove();

  const header = el('div', 'station-header');
  const chipRow = station.lines.map((l) => (
    `<span class="line-chip" style="--chip-color: var(--line-${escapeHtml(l)}, var(--text-muted))">${escapeHtml(lineDisplayName(l))}</span>`
  )).join('');

  const coordsLink = (station.lat != null && station.lon != null)
    ? `<a class="map-link" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${station.lat},${station.lon}">Map</a>`
    : '';

  header.innerHTML = `
    <div class="station-header__meta">
      ${chipRow}
      <span class="meta-text">${escapeHtml(station.borough || 'Borough unknown')}${station.verified === false ? ' (unverified)' : ''} · Zone ${escapeHtml(station.zone || '?')}</span>
      ${coordsLink}
    </div>
  `;
  root.appendChild(header);

  const filterRowEl = el('div', 'filter-row');
  header.appendChild(filterRowEl);

  const addBtn = el('button', 'secondary-link', '+ Add an entry for this station');
  addBtn.style.margin = '4px 16px';
  addBtn.addEventListener('click', () => navigate(`#/add/${stationId}`));
  root.appendChild(addBtn);

  const listEl = el('div', 'entry-list');
  root.appendChild(listEl);

  const allEntries = entriesForStation(stationId);
  const selectedFilters = new Set();
  let openEntryId = null;

  function visibleEntries() {
    if (selectedFilters.size === 0) return allEntries;
    return allEntries.filter((entry) => (
      selectedFilters.has(`cat:${entry.category}`)
      || (entry.tags || []).some((t) => selectedFilters.has(`tag:${t}`))
    ));
  }

  function renderFilters() {
    filterRowEl.innerHTML = '';
    const categoriesPresent = CATEGORY_ORDER.filter((c) => allEntries.some((e) => e.category === c));
    const tagsPresent = [...new Set(allEntries.flatMap((e) => e.tags || []))].sort();

    categoriesPresent.forEach((cat) => {
      const key = `cat:${cat}`;
      const chip = el('button', 'filter-chip', escapeHtml(CATEGORY_LABELS[cat] || cat));
      chip.setAttribute('aria-pressed', selectedFilters.has(key));
      chip.addEventListener('click', () => {
        selectedFilters.has(key) ? selectedFilters.delete(key) : selectedFilters.add(key);
        renderFilters();
        renderEntries();
      });
      filterRowEl.appendChild(chip);
    });

    tagsPresent.forEach((tag) => {
      const key = `tag:${tag}`;
      const chip = el('button', 'filter-chip', escapeHtml(tag));
      chip.setAttribute('aria-pressed', selectedFilters.has(key));
      chip.addEventListener('click', () => {
        selectedFilters.has(key) ? selectedFilters.delete(key) : selectedFilters.add(key);
        renderFilters();
        renderEntries();
      });
      filterRowEl.appendChild(chip);
    });

    if (selectedFilters.size > 0) {
      const clear = el('button', 'filter-clear', 'Clear');
      clear.addEventListener('click', () => {
        selectedFilters.clear();
        renderFilters();
        renderEntries();
      });
      filterRowEl.appendChild(clear);
    }
  }

  function badgesHtml(entry) {
    const badges = [];
    if (entry.stretch) badges.push('<span class="badge badge--stretch">bit of a walk</span>');
    if (entry.verify) badges.push('<span class="badge badge--verify">unconfirmed *</span>');
    if (entry.source === 'user') badges.push('<span class="badge badge--user">mine</span>');
    if (entry.source === 'suggested') badges.push('<span class="badge badge--suggested">suggested</span>');
    return badges.length ? `<div class="badge-row">${badges.join('')}</div>` : '';
  }

  function cardBodyHtml(entry) {
    const hasMaps = Boolean(entry.address || entry.mapsQuery);
    const url = safeUrl(entry.url);
    const tags = (entry.tags || []).map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`).join('');
    return `
      <p>${escapeHtml(entry.desc)}</p>
      ${entry.address ? `<div class="entry-card__field">${escapeHtml(entry.address)}</div>` : ''}
      <div class="entry-card__actions">
        ${hasMaps ? `<a class="btn btn--primary" target="_blank" rel="noopener" href="${mapsUrl(entry)}">Open in Maps</a>` : ''}
        ${url ? `<a class="btn" target="_blank" rel="noopener" href="${url}">More info</a>` : ''}
      </div>
      ${tags ? `<div class="entry-card__tags">${tags}</div>` : ''}
      ${badgesHtml(entry)}
    `;
  }

  function renderEntries() {
    listEl.innerHTML = '';
    const visible = visibleEntries();

    if (!visible.length) {
      listEl.appendChild(el('p', 'empty-state', allEntries.length
        ? 'No entries match these filters.'
        : 'Nothing curated here yet — be the first to add one.'));
      return;
    }

    CATEGORY_ORDER.forEach((cat) => {
      const inGroup = visible.filter((e) => e.category === cat);
      if (!inGroup.length) return;
      listEl.appendChild(el('div', 'entry-group-label', CATEGORY_LABELS[cat] || cat));
      inGroup.forEach((entry) => {
        const isOpen = openEntryId === entry.id;
        const card = el('div', 'entry-card');
        card.dataset.open = String(isOpen);
        card.style.setProperty('--cat-color', `var(--cat-${entry.category}, var(--text-muted))`);

        const head = el('button', 'entry-card__head');
        head.setAttribute('aria-expanded', String(isOpen));
        head.innerHTML = `
          <span class="cat-chip">${escapeHtml(CATEGORY_LABELS[entry.category] || entry.category)}</span>
          <span class="entry-card__head-text">
            <span class="entry-card__title-row">
              <span class="entry-card__title">${escapeHtml(entry.title)}</span>
              ${entry.stretch ? '<span class="stretch-inline">🚶 bit of a walk</span>' : ''}
            </span>
            <span class="entry-card__snippet">${escapeHtml(snippet(entry.desc, 60))}</span>
          </span>
          <span class="entry-card__chevron">▾</span>
        `;
        head.addEventListener('click', () => {
          openEntryId = isOpen ? null : entry.id;
          renderEntries();
        });
        card.appendChild(head);

        if (isOpen) {
          const body = el('div', 'entry-card__body', cardBodyHtml(entry));
          card.appendChild(body);
        }
        listEl.appendChild(card);
      });
    });
  }

  renderFilters();
  renderEntries();
}

/* ===========================================================
   Add entry screen (form + export/import)
   =========================================================== */

function compactEntry(raw) {
  const out = { id: raw.id, stationId: raw.stationId, category: raw.category, title: raw.title, desc: raw.desc, tags: raw.tags || [], source: raw.source };
  if (raw.address) out.address = raw.address;
  if (raw.mapsQuery) out.mapsQuery = raw.mapsQuery;
  if (raw.url) out.url = raw.url;
  if (raw.stretch) out.stretch = true;
  if (raw.verify) out.verify = true;
  return out;
}

function renderAddScreen(root, prefStationId) {
  topbar(root, 'Add entry', prefStationId ? `#/station/${prefStationId}` : '#/');

  const form = el('div', 'form-screen');
  const sortedStations = [...STATIONS].sort((a, b) => a.name.localeCompare(b.name));
  const sortedTags = [...TAGS].sort();

  form.innerHTML = `
    <div class="field">
      <label for="f-station">Station</label>
      <select id="f-station">
        ${sortedStations.map((s) => `<option value="${escapeHtml(s.id)}" ${s.id === prefStationId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label for="f-category">Category</label>
      <select id="f-category">
        ${CATEGORY_ORDER.map((c) => `<option value="${c}">${escapeHtml(CATEGORY_LABELS[c])}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label for="f-title">Title</label>
      <input id="f-title" type="text" required>
    </div>
    <div class="field">
      <label for="f-desc">Description</label>
      <textarea id="f-desc" required></textarea>
      <div class="field-hint">One or two sentences: what it is + why it's interesting.</div>
    </div>
    <div class="field">
      <label for="f-address">Address <span class="field-hint">(optional for facts)</span></label>
      <input id="f-address" type="text">
    </div>
    <div class="field">
      <label for="f-url">Link <span class="field-hint">(optional)</span></label>
      <input id="f-url" type="url" placeholder="https://…">
    </div>
    <div class="field">
      <label>Tags</label>
      <div class="tag-picker">
        ${sortedTags.map((t, i) => `
          <span class="tag-picker__option">
            <input type="checkbox" id="f-tag-${i}" value="${escapeHtml(t)}">
            <label for="f-tag-${i}">${escapeHtml(t)}</label>
          </span>
        `).join('')}
      </div>
    </div>
    <div class="field">
      <label for="f-notes">Notes to the owner <span class="field-hint">(only used for the GitHub suggestion, not saved)</span></label>
      <textarea id="f-notes"></textarea>
    </div>
    <div class="form-actions">
      <button class="btn btn--primary" id="f-save">Save locally</button>
      <button class="btn" id="f-suggest">Suggest on GitHub</button>
    </div>
    <div class="form-status" id="f-status"></div>
  `;
  root.appendChild(form);

  function readEntry(source) {
    const stationId = form.querySelector('#f-station').value;
    const category = form.querySelector('#f-category').value;
    const title = form.querySelector('#f-title').value.trim();
    const desc = form.querySelector('#f-desc').value.trim();
    const address = form.querySelector('#f-address').value.trim();
    const url = form.querySelector('#f-url').value.trim();
    const tags = [...form.querySelectorAll('.tag-picker input:checked')].map((i) => i.value);

    if (!stationId || !category || !title || !desc) return null;

    const idPrefix = source === 'user' ? 'user-' : 'suggested-';
    return compactEntry({
      id: idPrefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      stationId, category, title, desc, address, url, tags, source
    });
  }

  const status = form.querySelector('#f-status');

  form.querySelector('#f-save').addEventListener('click', () => {
    const entry = readEntry('user');
    if (!entry) { status.textContent = 'Fill in station, category, title and description first.'; return; }
    USER_ENTRIES.push(entry);
    saveUserEntries();
    status.textContent = `Saved locally. It'll show up on the station page, marked "mine".`;
  });

  form.querySelector('#f-suggest').addEventListener('click', () => {
    const entry = readEntry('suggested');
    if (!entry) { status.textContent = 'Fill in station, category, title and description first.'; return; }
    const station = STATIONS_BY_ID.get(entry.stationId);
    const notes = form.querySelector('#f-notes').value.trim();
    const lineId = station && station.lines[0];

    const body = [
      `**Station:** ${entry.stationId}`,
      '**Suggested entry:**',
      '```json',
      JSON.stringify(entry, null, 2),
      '```',
      `**Notes:** ${notes}`
    ].join('\n');

    const issueTitle = `[entry] ${station ? station.name : entry.stationId} — ${entry.title}`;
    const issueUrl = `https://github.com/${CONFIG.repoOwner}/${CONFIG.repoName}/issues/new`
      + `?title=${encodeURIComponent(issueTitle)}`
      + `&labels=${encodeURIComponent(`suggestion,line:${lineId || 'unknown'}`)}`
      + `&body=${encodeURIComponent(body)}`;

    window.open(issueUrl, '_blank', 'noopener');
    status.textContent = 'Opened a pre-filled GitHub issue in a new tab — review and submit it there.';
  });

  renderDataTools(root);
}

function renderDataTools(root) {
  const section = el('div', 'data-tools');
  section.innerHTML = `
    <div class="data-tools__block">
      <h2>Export local entries</h2>
      <textarea id="dt-export" readonly></textarea>
      <div class="form-actions">
        <button class="btn" id="dt-copy">Copy</button>
      </div>
      <div class="field-hint">Paste this into a data/lines/&lt;line&gt;.json entries array to fold your local additions into the curated data.</div>
    </div>
    <div class="data-tools__block">
      <h2>Import entries</h2>
      <textarea id="dt-import" placeholder="Paste a JSON array of entries here"></textarea>
      <div class="form-actions">
        <button class="btn" id="dt-merge">Merge into local entries</button>
      </div>
      <div class="form-status" id="dt-status"></div>
    </div>
  `;
  root.appendChild(section);

  const exportArea = section.querySelector('#dt-export');
  exportArea.value = JSON.stringify(USER_ENTRIES, null, 2);

  section.querySelector('#dt-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(exportArea.value);
    } catch (err) {
      exportArea.select();
      document.execCommand('copy');
    }
  });

  const importStatus = section.querySelector('#dt-status');
  section.querySelector('#dt-merge').addEventListener('click', () => {
    const raw = section.querySelector('#dt-import').value.trim();
    if (!raw) { importStatus.textContent = 'Paste some JSON first.'; return; }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      importStatus.textContent = 'That isn’t valid JSON.';
      return;
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const existingIds = new Set(USER_ENTRIES.map((e) => e.id));
    let added = 0;
    list.forEach((entry) => {
      if (!entry || !entry.id || !entry.stationId || !entry.category || !entry.title || !entry.desc) return;
      if (existingIds.has(entry.id)) return;
      USER_ENTRIES.push(entry);
      existingIds.add(entry.id);
      added += 1;
    });
    saveUserEntries();
    exportArea.value = JSON.stringify(USER_ENTRIES, null, 2);
    importStatus.textContent = `Merged ${added} new entr${added === 1 ? 'y' : 'ies'}.`;
  });
}

/* ===========================================================
   Borough browse (secondary nav)
   =========================================================== */

function renderBoroughList(root) {
  topbar(root, 'Browse by borough', '#/');
  const boroughs = [...new Set(STATIONS.map((s) => s.borough).filter(Boolean))].sort();
  const list = el('div', 'borough-list');
  boroughs.forEach((borough) => {
    const count = STATIONS.filter((s) => s.borough === borough).length;
    const row = el('button', 'borough-row');
    row.innerHTML = `<span>${escapeHtml(borough)}</span><span class="line-row__meta">${count}</span>`;
    row.addEventListener('click', () => navigate(`#/borough/${encodeURIComponent(borough)}`));
    list.appendChild(row);
  });
  root.appendChild(list);
}

function renderBoroughStations(root, borough) {
  topbar(root, borough, '#/borough');
  const list = el('div', 'borough-list');
  STATIONS.filter((s) => s.borough === borough)
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((s) => {
      const row = el('button', 'borough-row');
      row.innerHTML = `<span>${escapeHtml(s.name)}</span><span class="line-row__meta">${s.verified === false ? 'unverified' : ''}</span>`;
      row.addEventListener('click', () => navigate(`#/station/${s.id}`));
      list.appendChild(row);
    });
  root.appendChild(list);
}

/* ===========================================================
   Init
   =========================================================== */

async function init() {
  CONFIG = await fetchJSON('config.json', true);
  const v = CONFIG.dataVersion;

  const stationsData = await fetchJSON(`data/stations.json?v=${v}`, true);
  STATIONS = stationsData.stations;
  STATIONS.forEach((s) => STATIONS_BY_ID.set(s.id, s));

  const tagsData = await fetchJSON(`data/tags.json?v=${v}`, true);
  TAGS = new Set(tagsData.tags);

  USER_ENTRIES = loadUserEntries();

  window.addEventListener('hashchange', render);
  render();

  prefetchAllLines();
}

init().catch((err) => {
  ROOT().innerHTML = '<p class="empty-state">Could not load Tube Stop Guide data. Check the console for details.</p>';
  console.error(err);
});

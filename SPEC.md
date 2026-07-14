# Tube Stop Guide — Implementation Spec (v3, consolidated)

## 1. Product summary

Mobile-first static web app. User picks a London Underground station — by fuzzy search or by browsing a line — and sees a curated list of 5–10 interesting things within ~12 minutes' walk: the nearest Wetherspoons, quirky/independent pubs, historical sites, curiosities, notable sights, and parks. Users can add entries locally and suggest new entries via pre-filled GitHub issues, which the owner consolidates and commits later.

Design intent: wiki-like utility, but modern and engaging. Dense but not crowded — most info visible at a glance, expandable for detail, filterable by category and tag.

Navigation is **station-first, not borough-first**: tube lines cut across boroughs and users don't know borough boundaries. Borough is metadata shown on the station page and available as a secondary filter/browse path.

## 2. Architecture

- Static site on GitHub Pages. Vanilla HTML/CSS/JS, no build step (see CLAUDE.md constraints).
- `data/stations.json` loads at startup (small; powers search instantly).
- `data/lines/<line>.json` content files lazy-load on first access to a station on that line, then cache in memory. A station's page merges entries from **all** loaded line files keyed by `stationId`, deduped by entry `id` — interchange stations get one merged page regardless of which research batch the content came from. Line files are research batches, not ownership.
- All fetches append `?v=<dataVersion>` from `config.json` to defeat CDN caching.
- PWA (manifest + service worker for offline/home-screen) is a later phase — structure CSS/JS so nothing blocks it, but don't build it in v1.

## 3. Data model

### stations.json
```json
{
  "version": 1,
  "stations": [
    {
      "id": "harrow-wealdstone",
      "name": "Harrow & Wealdstone",
      "lines": ["bakerloo", "overground"],
      "borough": "Harrow",
      "zone": "5",
      "lat": 51.5923,
      "lon": -0.3351,
      "verified": true
    }
  ]
}
```
- `id`: kebab-case, canonical, never changes.
- `zone` is a string ("2/3" exists for boundary stations).
- `lat`/`lon` nullable → hides station map link.
- `verified: false` marks best-effort borough/zone pending owner check.
- Stations in each line file's `stationOrder` array define geographic order for the line view.

### Line content file (data/lines/bakerloo.json)
```json
{
  "line": "bakerloo",
  "name": "Bakerloo",
  "color": "#B36305",
  "stationOrder": ["harrow-wealdstone", "kenton", "..."],
  "entries": [ Entry, Entry, ... ]
}
```

#### Forked lines: `route`

Lines with real-world branches (Northern, Central, District, Piccadilly, Metropolitan, Elizabeth, Mildmay, Weaver, Windrush) use `route` instead of `stationOrder`:

```json
{
  "line": "northern",
  "name": "Northern",
  "color": "#000000",
  "route": [
    { "branches": [
        { "id": "edgware", "name": "Edgware branch", "stations": ["edgware", "..."] },
        { "id": "high-barnet", "name": "High Barnet branch", "stations": ["high-barnet", "..."] }
    ]},
    { "stations": ["camden-town", "euston", "..."] },
    { "branches": [
        { "id": "morden", "name": "Morden branch", "stations": ["oval", "..."] },
        { "id": "battersea", "name": "Battersea branch", "stations": ["nine-elms", "..."] }
    ]}
  ],
  "entries": [ Entry, Entry, ... ]
}
```

- `route` is an ordered array of segments. A segment is either `{ "stations": [...] }` (a fixed trunk, always shown) or `{ "branches": [...] }` (a fork — the line view renders a small pill toggle so the rider picks one; the strip below shows only the chosen branch's stations).
- Shared/trunk stations that lie on more than one branch simply appear in each branch's `stations` array — no dedup needed, since entry counts and station pages are keyed by `stationId`, not by which branch list rendered them.
- Lines without any real fork just keep the plain `stationOrder` array (unchanged, fully backward compatible).
- London Overground was split into six branded lines in 2024 (Liberty, Lioness, Mildmay, Suffragette, Weaver, Windrush) — treat each as its own line file, not a shared "overground" line.

### Entry
```json
{
  "id": "hw-002",
  "stationId": "harrow-wealdstone",
  "category": "history",
  "title": "The Weald Stone",
  "desc": "One or two sentences: what it is + why it's interesting.",
  "address": "328 High Road, Harrow Weald, HA3 6QD",
  "mapsQuery": "Bombay Central Harrow Weald",
  "url": "",
  "tags": ["free", "quirky"],
  "source": "curated",
  "stretch": true,
  "verify": false
}
```
- `stationId`: string or array of strings (entry appears under each; e.g. a pub between two stations).
- `category` (exactly one, fixed enum): `spoons` | `indie_pub` | `history` | `fact` | `sight` | `food` | `oddity` | `park`.
  - `spoons`: nearest Wetherspoons. An explicit "none within reach" is valid content.
  - `fact`: a curiosity about the station/neighbourhood itself; no address required.
  - `park`: includes cemeteries and burial grounds (use the `cemetery` tag) — deliberate decision, do not add a cemetery category.
- `address`: required for anything physical; omitted for `fact`.
- `mapsQuery`: optional override when the address is ambiguous. Maps link = `https://www.google.com/maps/search/?api=1&query=<encodeURIComponent(mapsQuery || address || title)>` (opens native app on Android and iOS).
- `tags`: from `data/tags.json` only (controlled vocabulary; prevents `live-music`/`livemusic` drift).
- `source`: `curated` | `user` | `suggested`.
- `stretch: true`: beyond the ~12-min walk radius but worth it (e.g. the Weald Stone, ~1 mile out). Renders a small "bit of a walk" badge.
- `verify: true`: contains one owner-unconfirmed claim. Subtle marker in UI, filterable, so unverified claims can be batch-checked later.
- Entry id convention: station-prefix + zero-padded counter (`hw-001`). Ids are permanent.

### config.json
```json
{ "repoOwner": "YOUR_GITHUB_USERNAME", "repoName": "tube-stop-guide", "dataVersion": 1 }
```

## 4. Screens

1. **Home**: search box (fuzzy match on station names, entry titles, and tags — so "roman" finds Clapham's stone without knowing the station) + line list rendered with official roundel colours. "Browse by borough" and "View official TfL tube map" (external link, new tab) as secondary links — the app deliberately doesn't embed the full convoluted map, only per-line strips.
2. **Line view**: vertical "tube map strip" — coloured line down the left edge with station ticks, stations in `stationOrder`. Each row shows an entry-count badge (doubles as the coverage dashboard).
3. **Station view**: sticky header (name, line roundel chips, borough, zone, map link if coords present) + sticky horizontal filter-chip row (categories and tags present on this page, multi-select, instant). Entries grouped by category; `spoons` and `fact` pinned near the top.
4. **Add entry**: form (station picker pre-filled from context, category, title, desc, address, url, tags) with two actions: **Save locally** and **Suggest on GitHub**.

## 5. UI specification

- **Collapsed cards, tap to expand (accordion, one open at a time).** Collapsed = single row: colour-coded category chip + title + first ~60 chars of desc. Target 8–10 collapsed cards per screen. Expanded = full desc, address, "Open in Maps" button, external link, tags, source badge, stretch/verify markers.
- Badges: `stretch` → "bit of a walk"; `verify` → subtle dot/asterisk; `source: user` → "mine"; `source: suggested` → "suggested".
- Category chip palette: fixed, distinct from line colours; define once as CSS variables.
- TfL line colours: bakerloo `#B36305`, central `#E32017`, circle `#FFD300`, district `#00782A`, hammersmith-city `#F3A9BB`, jubilee `#A0A5A9`, metropolitan `#9B0056`, northern `#000000`, piccadilly `#003688`, victoria `#0098D4`, waterloo-city `#95CDBA`, elizabeth `#6950A1`.
- Overground (split into six branded lines since 2024, official TfL colour standard): liberty `#5D6061`, lioness `#FAA61A`, mildmay `#0077AD`, suffragette `#5BBD72`, weaver `#823A62`, windrush `#ED1B00`.
- System font stack; tight vertical rhythm; generous title type scale. Dark mode via CSS variables + `prefers-color-scheme` from day one.

## 6. Local entries (localStorage)

- Saved under `tsg.userEntries`, same Entry schema, `source: "user"`, ids prefixed `user-`.
- Rendered merged with curated data, marked "mine".
- **Export**: dumps user entries as formatted JSON (textarea + copy button) shaped to paste directly into a line file. Critical feature — without it, additions are trapped on one device.
- **Import**: paste JSON to merge entries on another device.

## 7. Content curation rules (for content batches, not code)

- 5–10 entries per station; fewer is fine for genuinely dull stations — never pad.
- ~12-minute walk radius; `stretch: true` for justified exceptions.
- Every entry needs a *reason* ("free folk music Sundays", "last galleried coaching inn in London"), not just a name.
- One–two sentences per desc.
- Parks only if: destination-quality in themselves, OR a specific nameable feature, OR the obvious "pint in hand, sit somewhere nice" answer. "There is a park" is not an entry.

## 8. Suggest via GitHub (no backend)

"Suggest on GitHub" builds a pre-filled new-issue URL:

```
https://github.com/{repoOwner}/{repoName}/issues/new
  ?title=[entry] {Station Name} — {Entry Title}
  &labels=suggestion,line:{lineId}
  &body={urlencoded body}
```

Issue body format — exact, machine-parsed later, do not restyle:

    **Station:** harrow-wealdstone
    **Suggested entry:**
    ```json
    { ...entry in exact schema, "source": "suggested" }
    ```
    **Notes:** free text

Consolidation loop (outside this app): owner reviews open `suggestion` issues with Claude in chat, which verifies/researches, normalises to schema, dedupes, and produces updated line JSON to commit; issues closed as merged. Requires being logged into GitHub; single-entry URLs are far below URL length limits.

## 9. Build order

1. Repo skeleton, `config.json`, `stations.json` (Bakerloo), fetch plumbing, fuzzy search.
2. Line strip view + station view with collapsed/expand cards, category/tag filters.
3. Add-entry form, localStorage save, export/import, Suggest-on-GitHub URL builder.
4. Seed content is already provided in `data/lines/bakerloo.json` (4 stations); remaining Bakerloo content arrives as later data commits — no code changes needed.
5. Dark-mode polish; then PWA; then next line file.

## 10. Acceptance criteria

- Opening the site on a phone, typing "hol" finds Holmes-related entries and any station matching; typing "warwick" finds Warwick Avenue.
- Tapping Bakerloo shows all 25 stations in order with correct entry counts (4 stations non-zero with seed data).
- Baker Street page shows its 4 seed entries; each expands with a working Maps link where an address exists.
- Weald Stone entry shows the "bit of a walk" badge.
- Adding a local entry survives reload; export produces valid JSON matching the schema; Suggest opens a correctly pre-filled GitHub issue.
- Filter chips narrow the list instantly; clearing restores it.
- Everything works served by `python3 -m http.server` and on GitHub Pages, in light and dark mode.

## 11. Out of scope (v1)

Walking-time computation, per-entry coordinates, PWA/offline, multi-user sync, any backend, boroughs as primary navigation, lines beyond Bakerloo.

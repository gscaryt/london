# CLAUDE.md — Tube Stop Guide

Mobile-first static web app: pick a London tube station, see 5–10 curated points of interest nearby (nearest Wetherspoons, quirky independent pubs, history, curiosities, parks). Hosted on GitHub Pages. Full requirements in `SPEC.md` — read it before writing code.

## Hard constraints

- **Vanilla HTML/CSS/JS only.** No frameworks, no build step, no transpilers, no npm, no external dependencies, no CDN libraries, no web fonts, no analytics. If you think you need a library, you don't.
- Single-page app: `index.html` + `app.js` + `style.css`. Data lives in `/data/*.json`, fetched at runtime.
- Must work when served as plain static files (GitHub Pages). Test locally with `python3 -m http.server` — never rely on anything that requires a server-side component.
- Mobile-first (~380px viewport is the primary target). Desktop just gets a centered column.
- System font stack. Dark mode via `prefers-color-scheme` and CSS variables from day one.

## Repo layout

```
/index.html
/app.js
/style.css
/config.json          repoOwner, repoName, dataVersion
/data/stations.json   canonical station registry (all stations, all lines)
/data/tags.json       controlled tag vocabulary
/data/lines/*.json    content entries, one file per line (research batches)
/CLAUDE.md  /SPEC.md
```

## Data rules — important

- The JSON schema in `SPEC.md` §3 is the source of truth. Do not add, rename, or remove fields without updating SPEC.md.
- **Never invent, embellish, or "improve" content entries.** Every curated entry was researched and fact-checked by the owner. You may fix JSON syntax, never wording or facts. Do not scaffold placeholder entries for uncovered stations — absence of content is meaningful (it shows coverage gaps in the line view).
- `stations.json` ships with `lat`/`lon` filled for only 3 stations; the rest are `null`. When coords are `null`, hide the station map link — do not guess coordinates. Filling them (from TfL open data or Wikipedia) is a listed task, done deliberately, not as a side effect.
- Borough and zone values for non-seed stations are best-effort and flagged `"verified": false`. Render them regardless; verification is an owner task.
- Entry `stationId` may be a string **or an array** (entries shared between nearby stations). The loader fans arrays out. Tolerate `stationId`s that don't exist in `stations.json` yet (skip silently) — content batches can precede station registry updates.
- Tags must come from `data/tags.json`. If an entry uses an unknown tag, log a console warning; don't crash, don't silently add it to the vocabulary.

## Conventions

- ES2020+, no modules-via-bundler tricks; either one `app.js` or native ES modules — keep it boring.
- localStorage keys namespaced: `tsg.userEntries`, `tsg.prefs`.
- All data fetches append `?v=<dataVersion>` from `config.json` (GitHub Pages CDN cache-busting). Bump `dataVersion` on any data commit.
- Line colours: use the official TfL palette constants defined in SPEC.md §5.
- Accessibility: real `<button>`s, visible focus states, expanded/collapsed cards use `aria-expanded`.

## What not to do

- No localStorage schema migrations without an export path first — user entries are irreplaceable.
- Don't alter the GitHub issue body format in the Suggest flow (SPEC.md §8); the owner machine-parses it later.
- Don't add features not in SPEC.md without asking. The owner iterates on this app with Claude in chat; scope creep makes those sessions harder.

## Owner task backlog (not for autonomous completion)

1. Fill `lat`/`lon` for remaining Bakerloo stations from a reliable source.
2. Verify `borough`/`zone` fields flagged `"verified": false`.
3. Entries flagged `"verify": true` contain one unconfirmed claim each — owner will check on site or in a research session.

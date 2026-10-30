---
name: add-parcel-state
description: 'Evaluate and add a new U.S. state to the multistate parcel tax modeler, or reject it as impractical. Use when: adding a state; onboarding a statewide parcel dataset or ArcGIS FeatureServer/MapServer; writing a state adapter in js/states/; mapping land, improvement, and total assessed value fields; finding state legislative, congressional, county, and municipal boundary services; deciding feasibility when parcel data lacks land, improvement, or total value, lacks server statistics, or only links values through a separate table.'
argument-hint: 'State name and parcel service URL(s), e.g. "Ohio https://.../FeatureServer/0 (points: https://...)"'
---

# Add (or reject) a state

The app's core (`js/app.js`) is state-neutral. Each state is one adapter file in `js/states/` that maps that state's schema onto the contract in [js/states/registry.js](../../../js/states/registry.js). Adding a state should never require editing another state's file, and should rarely require editing the core.

**Never modify the original Maryland app (`../tax-predictor`).**

## Resources

| File | Use |
|------|-----|
| [scripts/probe-parcel-service.js](./scripts/probe-parcel-service.js) | Inspect a parcel layer: fields, role guesses, capabilities, CORS, value coverage, statistics support, timings, and a gate verdict |
| [scripts/smoke-test-adapter.js](./scripts/smoke-test-adapter.js) | Run a finished adapter against live services and check its contract, geographies, statistics, and that each property type's `where` and `matches` agree |
| [assets/state-template.js](./assets/state-template.js) | Adapter skeleton with TODOs |
| [references/adapter-guide.md](./references/adapter-guide.md) | Data patterns (points vs. polygons), contract details, tax-rate strategies, boundary sources, service quirks learned so far |

Node is available after `conda activate power-web`.

## Feasibility gates

Run these checks before writing any code. Evaluate the complete data path, not whether a state matches Maryland's schema. A **hard** failure means reject the state, or ask the user before continuing. A **soft** failure means implement it and add a caveat. For related tables, verify value year, join key, duplicate/missing-key behavior, and query limits.

| # | Gate | Hard / soft | Why |
|---|------|-------------|-----|
| 1 | Per-parcel **land value** plus **total** or **improvement** value (any two of the three; the third is derived, as in Florida where improvements = JV − LND_VAL) | **Hard** | Split-rate tax and every underutilized definition need land and improvements separately. Total value alone is not enough. |
| 2 | Values are populated for most parcels statewide (probe "coverage" ≥ ~80% of parcels with total > 0) | **Hard** if most counties are missing, otherwise soft (list the missing counties) | A modeler with large holes misleads. |
| 3 | Public, unauthenticated REST query with **CORS** for browser origins (or JSONP) | **Hard** | The app is a static site with no proxy. |
| 4 | A scalable **geography-aware aggregation path** for values | **Hard**, but not necessarily server-side | Prefer server `outStatistics`. A separate table can still work when parcel keys can be selected spatially and matching rows can be queried in bounded batches and aggregated locally. Estimate request, network, and memory costs for county, district, and statewide scopes; a dynamic join's field list does not prove pagination or statistics support. |
| 5 | A reliable path from value records to parcel geometry | **Hard**, but values need not share the geometry layer | Accept a related table when a shared key, ArcGIS relationship, dynamic-layer join, or reproducible client join has verified coverage and cardinality. District analysis needs spatial selection of geometry keys followed by value lookup/aggregation. Reject only when no scalable, verifiable join path exists. |
| 6 | A **jurisdiction attribute** (county code or name) on each parcel | Soft | Needed to group tax rates. Without it, every geography uses one rate, or you need per-county spatial queries (slow). |
| 7 | Pagination (`resultOffset`) and `outSR=4326` GeoJSON | Soft | Needed for drawing shapes and for exports. |
| 8 | Point layer, or polygons with centroid coordinates or `returnCentroid` | Soft | Determines which data pattern applies (guide §1). |
| 9 | MapServer `export` for low-zoom images | Soft | Without it, parcels draw only at zoom 14+ and lower zooms use click-to-inspect. |
| 10 | Land use or class, building type, owner occupancy or homestead, exemption flag | Soft | Each missing field lowers the quality of property types, the SFH benchmark, the occupancy breakdown, or the taxable filter. Document the proxies you use. |
| 11 | Statistics on a typical county finish within ~60 s | Soft | Note slow services in the README. |

## Procedure

### 1. Intake
Collect the state name, parcel geometry URL(s), value-bearing URL(s), and related tables. If the user gave only a portal page, find the REST layer URL (`.../FeatureServer/N` or `.../MapServer/N`). Inspect service relationships, dynamic layers, downloadable geodatabases, county splits, field aliases, and shared parcel/account identifiers. ArcGIS Online search works: `https://www.arcgis.com/sharing/rest/search?f=json&q=<state> parcels type:"Feature Service"`.

### 2. Probe
```powershell
conda activate power-web
node .github/skills/add-parcel-state/scripts/probe-parcel-service.js <layerUrl> --where "<one mid-size county filter>"
```
If the role guesses are wrong, re-run with `--land`, `--improvement`, `--total`, `--county`, or `--municipality`. Probe geometry and value layers separately when they differ; tables need table-specific checks for tax year, coverage, key uniqueness, grouped statistics, and pagination. Read metadata/data dictionaries to learn what each value means: assessed, market/just, equalized, or taxable. Test every relevant endpoint from a browser origin, not only Node.

### 3. Decide
Write a short feasibility report for the user **before** implementing:

```
State: <name>          Verdict: IMPLEMENT | IMPLEMENT WITH CAVEATS | REJECT
Parcel source(s): <urls>
Gates: 1 PASS (LNDVALUE/IMPVALUE/CNTASSDVALUE) · 2 WARN (Dane, Kenosha missing tax bills) · ...
Pattern: A/B/C/D (guide §1)
Tax rates: static table | derived from bills | placeholder (needs user input)
Caveats for reports: ...
```
- **REJECT** only when a hard gate still fails after checking alternate layers, related tables, joins, and a bounded client-side strategy. Say which gate failed, show field, coverage/key/cardinality, or query-limit evidence, and say what would unblock it. Do not reject solely because geometry and values are stored separately. Add a genuinely unsupported state to "States evaluated but not supported" in the README with date, URL, and reason.
- If the decision is borderline (for example, values exist in only half the counties), ask the user before continuing.

### 4. Choose the data pattern
See guide §1: **A** points plus shapes joined by location (MD), **B** polygons carrying their own attributes (WI), **C** points plus shapes joined by key (FL), or **D** geometry joined to a non-spatial value/account table (West Virginia). Choose the path that gives correct geography membership and minimizes transfer. For D, use a supported dynamic/relationship join only if its actual query capabilities are verified; otherwise spatially select geometry keys, fetch matching rows in bounded batches, and aggregate the selected rows. Preserve one-to-many rows deliberately; never silently multiply or discard values.

### 5. Find boundaries
You need four geography types: **state legislative** (both chambers if they're separate plans), **U.S. congressional**, **counties**, and **municipalities**. Councilmanic districts are out of scope unless asked. Prefer the official state source (legislature or GIS office), then state DOT or DNR, then Census TIGERweb as a fallback. For each layer, record its value field, its count, CORS support, and whether it supports pagination. Use `maxAllowableOffset` (~0.00003° for districts, ~0.0002° for counties and municipalities) to keep geometry light. Guide §4 lists sources already in use.

Make counties, and municipalities where possible, **attribute filters** on the parcel layer (exact and fast). Check that the names match the parcel roll. If some don't, set `verifyAttributeFilter: true` so a filter that matches nothing falls back to the boundary.

### 6. Tax rates
Choose a strategy from guide §3. Don't invent rates. If no reliable source is found, use a clearly labeled placeholder, put it in `tax.rateNote` and the report caveats, and tell the user which table to fill in.

### 7. Write the adapter
Copy [assets/state-template.js](./assets/state-template.js) to `js/states/<state>.js` and fill in every TODO. Rules:
- Each property type's `where` and `matches` must describe the **same rule**, and the types must **partition** the taxable set: every parcel matches exactly one type, the first that applies, and the last type is a catch-all. Keep the shared keys `agricultural`, `vacant`, `sfh`, `other`. The report's owner-occupied headline uses `sfh`.
- `values()` returns `improvement: null` when unknown (not 0), so the "vacant" test can fall back to land === total.
- Use `sqlString()` for any value placed in SQL. Build `acknowledgementsHtml` only from static strings; never from service data.
- Set `percentileExpressions: false` if the probe shows that PERCENTILE_CONT on an expression fails.
- `fields.improvementCount` must name a real field. Use the land field when improvement is an expression.
- If appraisal records are in a related table, describe the relationship in an optional state-neutral core contract, document the join key and year/filter, spatially select matching geometry for district membership, and attach value rows to map/export records. Do not assume one-to-one without testing. If the service cannot aggregate joined statistics, implement a bounded, cached local aggregation path and disclose its scope/performance limits.

### 8. Register
Add `<script src="js/states/<state>.js"></script>` to `index.html` after the other state scripts and **before** `js/app.js`. The state selector fills itself from the registry.

### 9. Smoke test
```powershell
node .github/skills/add-parcel-state/scripts/smoke-test-adapter.js --state XX --where "<county filter>"
```
Fix every FAIL. Explain or fix every WARN, especially property-type gaps or overlaps and `where`/`matches` mismatches. For related-table adapters, query the value table (not the geometry layer) and verify sample key matches, one-to-many behavior, tax-year/value coverage, and aggregation. Compare a local joined result with a table or county server aggregate where possible.

### 10. Browser check
Serve the folder (`python -m http.server 8765`), open `/?state=XX`, and check:
- One county and one district load, with plausible metrics and no console errors.
- At zoom 16, shapes draw and a popup opens.
- An underutilized view highlights parcels.
- All three downloads work.
- Switching between states works both ways.

### 11. Document
Update `README.md` with a state section (sources, pattern, membership, rates, limits) and the data-sources list in the adapter's `acknowledgementsHtml`. Then report to the user what is approximate and what they need to supply (for example, rate tables).

## Changing the core
Only change the core when a pattern can't be expressed through the contract (for example, related-table joins and client-side grouped statistics). Keep the change state-neutral and driven by an optional adapter property. Document the property in `registry.js` and the guide, and re-run the smoke test for **all** states.

# Adapter guide

Reference for [SKILL.md](../SKILL.md). The authoritative contract is the header comment of `js/states/registry.js`. The three existing adapters (`maryland.js`, `wisconsin.js`, `florida.js`) are worked examples.

## 1. Data patterns

| Pattern | When | Adapter settings | Example |
|---|---|---|---|
| **A. Points + shapes, location join** | One point per tax account; shapes carry no reliable account key (condos stack several accounts on one shape) | `analysisGeometry: "point"`, `analysisUrl` = points, `shapesUrl` = polygons, `shapeOutFields: "OBJECTID"`, no `shapeJoin`. The core attaches each point to the smallest shape containing it. | Maryland |
| **B. Polygons only** | No point layer; polygons carry the values | `analysisGeometry: "polygon"`, `shapesCarryAttributes: true`, `analysisUrl = shapesUrl`, `generalizeShapes: true`, and `center(props)` from centroid coordinate fields if the layer has them (otherwise the core uses `returnCentroid`). District membership uses a boundary correction: polygons that touch the district outline but whose centroid is outside are excluded by `OBJECTID`. | Wisconsin |
| **C. Points + shapes, key join** | Both layers share an ID | Like A, plus `shapeOutFields` = key fields and `shapeJoin: { shapeKey, pointKey }`. Shapes download only their keys, and attributes come once from the points. | Florida |
| **D. Geometry + non-spatial value table** | Parcel boundaries and account/appraisal rows are separate services but share a stable key | Optional `parcels.relatedTable` describes the table URL, key fields, tax-year/taxable filter, output fields, and local statistic-expression evaluator. The core spatially selects boundary keys, checks parcel centers, fetches table rows in bounded batches, preserves one-to-many accounts, and attaches records to polygon popups/exports. If the joined service cannot page or aggregate, compute the selected-geography statistics locally from cached table rows. | West Virginia |
| **E. Geometry + local geography file** | A public value file is county/geography-scoped and unsuitable for direct browser retrieval (for example, CORS-blocked ZIPs) | `parcels.relatedTable.loadRecords(geography, signal)` returns parsed assessment records for only the selected geography; use the county geometry filter and key fields to attach records to shapes. Local statistics run over those records, while map features require a matching geometry key. Cache only the active file/geography so repeated county navigation does not retain statewide datasets. Document the bundled asset size, hosting exposure, source year, unmatched records, and browser memory. | Indiana |

Prefer points for statistics, because counting points inside a boundary is exact and cheap. When there are only polygons, pattern B is the fallback.

**Do not reject a separate value table by default.** First test direct ArcGIS relationships, dynamic joined layers, query IDs, pagination, statistics, and county splits. If joined service queries are capped or non-aggregating, a bounded client join can still support districts: select geometry keys within the requested boundary, filter centers for exact membership, fetch only matching-year value rows by indexed key in batches, then aggregate/cache those rows locally. Assess statewide/large-geography transfer and memory explicitly; cap unsafe requests with a clear error. Verify value-year coverage, unmatched keys in both directions, duplicate-key cardinality, and whether multiple table rows are distinct accounts or must be deduplicated. Never sum a raw one-to-many join as if it were one record per polygon.

## 2. Contract notes and pitfalls

- **Multiple parcel services**: if a state publishes one value-bearing layer per county, set optional `parcels.analysisSources` to `[{ key, url, countyName?, where? }, ...]`. Keep `analysisUrl` and `shapesUrl` pointing to one source for compatibility with the required adapter contract. `key` must be unique; ArcGIS object IDs are only unique within one layer. `countyNames` supports one regional service covering several counties, and `strictCountySources` can reject unsupported county choices instead of silently querying every service. A source may override `taxableWhere`, `whereForGeography`, `outFields`, `objectIdField`, `pageSize`, `downloadBatchSize`, and `normalizeProperties`. `fieldMap` maps canonical adapter SQL identifiers to that source's field names or SQL expressions; `statisticScales` scales selected grouped AVG outputs after the service response (for example, converting market-value averages to a common assessed-value ratio). Keep source fields, filters, and parcel normalizers consistent. The core fans queries across sources, combines counts and sums, and computes weighted averages. Multi-source percentile statistics are not mergeable, so set `percentileExpressions: false` to use the additive land-share bins. County names let the app restrict county and municipality queries to the relevant source. Optional `shapeSources` supports separately published shape layers when `shapesCarryAttributes` is false.
- **Multi-source statistics**: every service must support the same fields, filters, and grouped statistics. Validate actual grouped queries on representative layers and compare the combined count/sums with the individual source results. Do not average per-layer averages without weighting by their counts.

- **`taxableWhere`**: total > 0 and not exempt. Use the state's exemption field (MD `EXCLASS IS NULL`; WI `AUXCLASS NOT LIKE '%X%'`; FL `TV_NSD > 0 OR JV_HMSTD > 0`). Exclude placeholder IDs (MD `ROW/UNK/GCE`).
- **`fields`**: SQL fields or expressions used inside `outStatistics`, for example `"JV - LND_VAL"`. The core builds `CAST(land AS FLOAT) / total` and `CASE WHEN ...` expressions from them, so the service must support SQL expressions in statistics (the probe tests this).
- **`fields.totalFromComponents`**: optional boolean for a total defined as `land + improvement` when a service rejects grouped `AVG(total expression)`. The core then derives jurisdiction totals from grouped land and improvement sums; the total expression must still work in counts and ratio/CASE expressions.
- **`fields.improvementFromTotalMinusLand`**: optional boolean for services that reject grouped `AVG(total - land)`. The core groups average total and land, then derives each jurisdiction's improvement sum as total minus land. Keep `fields.improvement` and `fields.improvementCount` mapped to real source fields for the adapter contract.
- **`parcels.downloadBatchSize`**: optional maximum object-ID batch size for detailed parcel exports. The core defaults to 500; lower it when a service silently truncates larger object-ID requests to its `maxRecordCount`.
- **Local `relatedTable.loadRecords`**: use only for a bounded, selected geography such as one county. Return records in the same shape expected by `fields`, `propertyTypes`, and `values`; local statistics consume that selected file, and map popups/CSV attach records to geometry by `keyField`/`geometryKeyField`. Do not cache every county's full record array in the core. Static assets remain directly downloadable, so confirm that bundling public files (especially records with personal information) is acceptable for the deployment.
- **`jurisdictionGroupBy`**: the fields that decide the tax rate. `taxJurisdictionDetails(attributes)` receives **only these fields** (statistics rows), so it must not depend on other fields.
- **`taxJurisdictionDetails`** returns `{ county, municipality | null, rate | null, jurisdiction }`. `jurisdiction` must be unique per rate unit, for example `"Dane County — City of Madison"`. Return `municipality: null` when the rate equals the county rate, so the UI doesn't show a pointless breakdown.
- **`prepare(signal)`**: optional async setup, run once before the first load. Cache the promise, and clear it if it fails.
- **Property types** must partition the taxable set; the smoke test checks the counts add up. Note that `PROPCLASS LIKE '%1%'` also matches `'1,4'`, so exclude earlier types explicitly in later `where` clauses (see `wisconsin.js`).
- **Occupancy**: use `field` when one coded field exists (MD `OOI`), or `groups` with `where`/`matches` (FL homestead). When the state has no such field, use a single `{ key: "", label: "Not reported" }` group; the report then hides the occupancy section.
- **Geography loaders** return features from `loadArcgisGeography(config, signal)` (in `js/core/helpers.js`). The config supplies `value`, `label`, an optional `county` (a county display name used for per-county district matching), and an optional `expand` (extra combined values, as in MD's 12A/12B → 12).
- **`attributeFilter(feature)`** returns SQL against the parcel layer using `feature.properties.raw`. It is exact and much faster than a spatial query. Use `verifyAttributeFilter: true` when names may not match.
- **`exportDistricts`** lists the district columns in the parcel CSV. `perCounty: true` is for county-level district sets loaded with `{ counties }`.
- **`urban.load(signal, geography)`**: MD uses its own state layer. Other states use `loadTigerUrbanAreas(signal, geography)`, which is limited to the geography's bounding box. Cache per geography.
- **Popups** receive raw attributes. Show values, the land/improvement share, and the state's useful identifiers. The core appends the tax rate and the predicted and hypothetical bills.
- **CSV**: `row(props)` must return exactly as many values as `headers`.

## 3. Tax-rate strategies

| Strategy | Use when | Example |
|---|---|---|
| Static table (county base + municipal overrides) | Published county or municipal rates are available and stable | Maryland `COUNTY_TAX_RATES` |
| Derived effective rate = Σ tax bills ÷ Σ value, grouped by jurisdiction, in `prepare()` | The parcel layer has a reported tax bill field | Wisconsin `GRSPRPTA / CNTASSDVALUE` (covers all levies, so say so in `scopeLabel`) |
| Placeholder plus a flagged `rateNote` | No reliable statewide source was found yet | Florida (6.5 mills) |

Always state which levies are covered (county only, or all levies) in `tax.scopeLabel`, `tax.shortLabel`, and the report caveats. If values are market or just values rather than assessed values, or are not equalized, add a caveat.

## 4. Boundary sources already in use

| State | Legislative | Congressional | Counties | Municipalities |
|---|---|---|---|---|
| MD | iMAP `MD_ElectionBoundaries/1` | iMAP `MD_ElectionBoundaries/0` | iMAP `MD_PoliticalBoundaries/1` | iMAP `MD_PoliticalBoundaries/5` |
| WI | LTSB `WI_Senate_Districts_2024`, `WI_Assembly_Districts_2024` | LTSB `WI_Congressional_Districts_(2022)` | DNR `WI_County_Bnd_24K_WGS` | LTSB `WI_Cities_Towns_and_Villages_Current` |
| FL | Leon County GIS copies of the 2022 enacted House and Senate plans | FGIO `FL_Congressional_Districts_May_2026` | FDOT `Admin_Boundaries/5` | FDOT `Admin_Boundaries/7` (`CLASSFP LIKE 'C%'`) |

Good places to search: the state legislature's GIS or LTSB, the state GIS office or geodata portal, the state DOT `Admin_Boundaries`, and ArcGIS Online (`owner:<org> type:"Feature Service"`). Census TIGERweb (`tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Legislative/MapServer`, `.../State_County/MapServer`, `.../Places_CouSub_ConCity_SubMCD/MapServer`) works everywhere as a fallback and supports CORS and GeoJSON.

## 5. Service quirks learned so far

- **Hosted FeatureServers** (`services*.arcgis.com`) have no `export`, so there's no low-zoom image. Omit `exportMapUrl`.
- **PERCENTILE_CONT on expressions** can fail or time out on large hosted layers (Florida's centroid layer returns "Unable to perform query"; Wisconsin's works). Rely on the probe result. When it fails, set `percentileExpressions: false`, and the core estimates the median from 2% step counts. Wisconsin currently sets it to `false` as a precaution, and could switch to the exact median.
- **Statistic output names** may come back in a different case. The core's `statAttribute()` handles this, so don't rely on exact case.
- **Unindexed value filters are slow.** On the FL centroid layer, `CO_NO = 47` returns a count in 0.1 s, but `sum(JV)` takes 20–50 s. The server caches repeated queries. Report slow services, and keep the number of statistics queries low.
- **`returnCentroid=true`** works on hosted polygon layers and is used by pattern B's boundary correction when the layer has no lat/lon fields.
- **Name mismatches between boundary and parcel layers** (Saint vs. St, municipalities in more than one county, "Town of" prefixes): normalize in `attributeFilter` and turn on `verifyAttributeFilter`.
- **Values coded as strings** (for example FL `DOR_UC` "001"): compare as strings in both `where` and `matches`.
- **A service may be down.** A failing boundary source should log a warning and be skipped, not block the other sources (see Maryland's `loadCountyCouncilChoices`).

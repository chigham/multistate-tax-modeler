# Parcel Analysis — Multistate Tax Modeler

A multistate version of the Maryland parcel analysis app (`../tax-predictor`, unchanged). Choose a **state**, then a **geographic subset**, to model split-rate (land vs. improvement) property tax scenarios, highlight underutilized parcels, and download reports.

Supported states: **Maryland**, **Wisconsin**, **Florida**, **Montana**, **North Carolina**, **Washington**, **Arkansas**, **Vermont**, **District of Columbia**, **Massachusetts**, **New Jersey**, **Utah**, **West Virginia**, **Indiana**, **Ohio** (selected-county pilot), and **Virginia** (Essex County pilot). Open with `?state=WI` (or `MD`, `FL`, `MT`, `NC`, `WA`, `AR`, `VT`, `DC`, `MA`, `NJ`, `UT`, `WV`, `IN`, `OH`, `VA`) to start in a given state.

## Run locally

```
npx serve .
```

Open the local URL. Opening `index.html` directly also works (plain scripts, no modules), but some browsers restrict remote GIS requests from `file://`.

## Architecture

```
index.html             UI shell (state selector replaces the old "Tax model analyzer" card)
styles.css             original styles + state-selector additions
js/core/helpers.js     geometry, ArcGIS REST paging, boundary normalization, TIGERweb urban areas
js/states/registry.js  adapter registry and the adapter contract (documented in the file header)
js/states/maryland.js  Maryland adapter
js/states/wisconsin.js Wisconsin adapter
js/states/florida.js   Florida adapter
js/states/montana.js   Montana adapter
js/states/north-carolina.js North Carolina adapter
js/states/washington.js Washington adapter
js/states/arkansas.js Arkansas adapter
js/states/vermont.js Vermont adapter
js/states/district-of-columbia.js District of Columbia adapter
js/states/massachusetts.js Massachusetts adapter
js/states/new-jersey.js New Jersey adapter
js/states/utah.js       Utah adapter (29 county parcel sources)
js/states/west-virginia.js West Virginia adapter (polygon-to-assessment-table join)
js/states/indiana.js   Indiana adapter (county Gateway files joined to statewide polygons)
js/states/ohio.js      Ohio adapter (four live parcel services; selected counties)
js/states/virginia.js  Virginia adapter (Essex County-only live parcel service)
js/app.js              state-neutral core: map, selection, statistics, scenarios, popups, downloads
```

The core never references a state's field names. Multi-source adapters query each service independently, add counts and sums, and combine averages using each source's count; source field maps and optional average scaling allow feeds with different schemas/value bases to share one adapter. IDs and centroid exclusions remain scoped to their source. Related-table adapters can join records to geometry by a shared key, preserve one-to-many records, and locally aggregate a selected geography when ArcGIS cannot aggregate the joined layer. Each adapter supplies:

- **Parcel sources**: the analysis layer (points when available), the drawn shape layer, optional multiple county sources, how shapes and points are joined, and an optional MapServer for low-zoom images.
- **Value fields** as SQL fields/expressions for server statistics, plus a `values()` function for the same values per parcel.
- **Tax jurisdictions**: the `groupBy` fields that determine a rate and a `taxJurisdictionDetails()` function. An optional async `prepare()` builds rate tables from data.
- **Classification**: taxable filter, SFH benchmark rule, property types (`where` + `matches` that describe the same rule), and occupancy groups (a grouping field or `where` clauses).
- **Geographies**: loaders that return normalized boundary features, with optional attribute filters (exact, fast) and an optional check that falls back to the boundary when a name-based filter matches nothing.
- **Popups, CSV columns, report text, caveats, and acknowledgements.**

To add a state: create `js/states/<state>.js` that calls `ParcelStates.register({...})`, and add its `<script>` tag before `js/app.js`. The `add-parcel-state` skill (`.github/skills/add-parcel-state/`) walks through the feasibility check, service probe, adapter template, and smoke test.

### Shared analysis logic

The taxable filter, underutilized definitions (vacant, land > improvements, high-value urban, land:total above mean/median SFH), split-rate scenarios, revenue-neutral presets, report estimation (5-point land-share bands), and downloads are identical across states. Membership is always "parcel center inside the selected geography".

## State data notes

### Maryland

Same services and rules as the original app: iMAP account points drive statistics and popups, parcel shapes are drawn at zoom 14+, and zoomed-out views use the iMAP MapServer image export. County council districts use the original county services.

### Wisconsin

- **Parcels**: Wisconsin Statewide Parcels (V12) — **polygons only**. There is no statewide parcel point layer, so shapes carry their own attributes and are drawn directly (one request per view, simplified to screen resolution).
- **No low-zoom image**: the service is a hosted FeatureServer with no map export, so parcels are drawn at zoom 14+; at lower zooms, click the map to inspect a parcel.
- **Membership**: counties use `CONAME` and municipalities use `CONAME` + `PLACENAME` (exact). If a municipality name doesn't match the parcel roll (≈2% of municipalities, mostly multi-county cities), the boundary is used instead. Districts use polygon intersection plus a boundary correction: parcels touching the outline whose centroid (`LONGITUDE`/`LATITUDE`) falls outside are excluded by `OBJECTID`.
- **Tax rates**: effective rates derived from reported gross tax bills (`GRSPRPTA / CNTASSDVALUE`) per municipality. This covers **all levies** (school, municipal, county, technical college), not county tax alone. Counties that don't report bills (currently Chippewa, Dane, Green, Kenosha, Pierce) use the statewide effective rate.
- **Limits**: no building type (the SFH benchmark is a class-1 residential proxy) and no owner occupancy.
- **Boundaries**: LTSB 2024 Senate/Assembly, 2022 congressional, current cities/towns/villages; DNR County Boundaries 24K; Census 2020 urban areas (TIGERweb).

### Florida

- **Parcels**: FDOR statewide cadastral **centroids** drive statistics and membership; **polygons** are drawn at zoom 14+ with only their join key (`CO_NO` + `PARCEL_ID`), and centroid attributes are attached by key, so attributes download once.
- **No low-zoom image**: hosted FeatureServers have no map export.
- **Values**: just value (`JV`), land (`LND_VAL`), improvements = `JV − LND_VAL` (FDOR has no improvement field). Taxable = `JV > 0` and not fully exempt (`TV_NSD > 0` or homestead).
- **Tax rates**: **not configured yet** — every county uses a placeholder 6.5 mills, flagged in the panel and reports. Enter certified county millage in `COUNTY_TAX_RATES` in `js/states/florida.js`.
- **Occupancy**: homestead (`JV_HMSTD > 0`) vs. non-homestead.
- **Performance**: the statewide centroid service is slow for aggregate statistics (roughly 20–60 s for a mid-size county; longer for Miami-Dade or Broward). Report breakdowns run 20 statistics queries.
- **Boundaries**: FL Legislature 2022 House/Senate plans (via Leon County GIS), FGIO congressional districts (May 2026 plan), FDOT counties and incorporated cities, Census 2020 urban areas.

Hosted layers (WI, FL) reject `PERCENTILE_CONT` on expressions, so the median SFH land share is estimated from cumulative counts at 2% steps.

### Montana

- **Parcels**: Montana State Library's statewide OwnerParcel polygons carry selected Montana Department of Revenue parcel attributes and source-reported `TotalLandValue`, `TotalBuildingValue`, and `TotalValue`. Polygons drive analysis and rendering; district membership uses the parcel centroid. The layer has no low-zoom map image, so parcels draw at zoom 14+.
- **Classification**: the source has no detached-home/building-type field or occupancy field. The SFH benchmark is a broad `PropType = Improved Property` proxy; agricultural parcels are approximated from reported crop, fallow, farmsite, forest, grazing, wild-hay, or irrigated acres. Partial exemptions are not adjusted.
- **Tax rates**: not configured — every county currently uses an illustrative 6.5-mill placeholder. The source does not supply parcel tax bills or a verified taxable-value base; replace the placeholder with certified local rates before citing dollar estimates.
- **Boundaries**: Census TIGERweb January 2026 congressional and state legislative districts; 2020 county and incorporated-place boundaries; 2020 urban areas.

### North Carolina

- **Parcels**: NC OneMap's statewide point layer drives statistics and membership; polygons are drawn at high zoom and joined by state-county FIPS plus local parcel number. Its MapServer supports low-zoom parcel images.
- **Values**: `landval`, `improvval`, and `parval` are source-reported land, improvement, and parcel values. The `parvaltype` field is mixed across the statewide feed (observed values include Assessed, Market, Appraised, Taxable, and blank); no equalization or conversion is applied. Statewide value comparisons can therefore mix different bases.
- **Coverage**: the live layer has parcel rows in all counties, but Alleghany, Camden, Chowan, Hoke, and Yancey currently have no rows passing the model's positive parcel-value and land-value filter. Those county selections return no modeled parcels until usable values are published.
- **Classification and tax**: county-contributed use descriptions are heterogeneous, so agricultural and SFH categories are text-based proxies. Owner occupancy, parcel tax bills, and an exemption flag are not provided. Tax rates are not configured — each county uses an illustrative 6.5-mill placeholder; replace it with certified rates before citing dollar estimates.
- **Boundaries**: Census TIGERweb January 2026 congressional and state legislative districts; 2020 county and incorporated-place boundaries; 2020 urban areas.

### Washington

- **Parcels**: Washington State Parcels Project statewide polygons drive analysis and rendering. The source covers counties that currently have digital tax parcels; county membership is matched using the parcel's three-digit county FIPS code. Polygon centroids are returned by the service for geography membership.
- **Values**: `VALUE_LAND` and `VALUE_BLDG` are source-reported market values; total value is derived as their sum. About 95.0% of records have a positive derived total and a county FIPS code. The current feed has no records for Asotin County and records without a county code are excluded.
- **Classification**: Washington DOR `LANDUSE_CD` 11 is the single-family proxy. Codes 81, 82, 83, 88, 94, and 95 form an agriculture/resource-land proxy. These are land-use classifications, not exemption or occupancy determinations.
- **Tax rates**: not configured — every county currently uses an illustrative 6.5-mill placeholder. The source has no parcel tax bills, exemption flag, or owner-occupancy/homestead field. Market values are not adjusted to a certified taxable base; replace the placeholder before citing dollar estimates.
- **Rendering and boundaries**: no low-zoom parcel image is available, so shapes draw at zoom 14+. Boundaries use Census TIGERweb January 2026 congressional and state legislative districts, 2020 county and incorporated-place boundaries, and 2020 urban areas.

### Arkansas

- **Parcels**: Arkansas GIS Office (AGISO) statewide CAMA parcel points drive statistics and membership; polygons are drawn at high zoom and joined by `countyid` + `parcelid`. Both layers currently contain about 2.15 million records. The hosted FeatureServer has no low-zoom map image and caps responses at 200 features; detailed exports use matching 200-ID batches to avoid truncation.
- **Values and coverage**: the model uses source-reported `landvalue`, `impvalue`, and `totalvalue`; about 95.1% of point records have positive total value, and positive-value groups appear in all 75 counties. AGISO explicitly warns that county coverage may be partial (such as only rural, urban, or part-county areas), so this is not a complete statewide assessment roll. The separate `assessvalue` field is positive for only 68.6% of records with positive total value, spans 46 county groups, and varies relative to `totalvalue`; it is not used as a uniform model base.
- **Classification and tax**: `ParcelType` codes beginning with A are an agricultural proxy, and RI is a broad residential-improved/SFH proxy; vacant and other improved groups use the reported improvement value. These are not validated statewide land-use or detached-home categories. No parcel tax bills, exemption flag, or owner-occupancy field are provided. Every county uses an illustrative 6.5-mill placeholder applied to `totalvalue`; replace it with certified local rates and a validated taxable base before citing dollar estimates.
- **Boundaries**: Census TIGERweb 2026-vintage congressional and state legislative districts; 2020 county, incorporated-place, and urban-area boundaries.

### Vermont

- **Parcels**: VCGI's standardized statewide Grand List parcel polygons drive analysis and rendering. The model includes `PROPTYPE = PARCEL` features with positive `REAL_FLV` and a reported `LAND_LV`; the source layer has about 344,000 features, and roughly 325,600 are positive-value parcel records before the land-field filter. Polygon centers determine geography membership, and shapes draw at zoom 14+.
- **Values and coverage**: `LAND_LV`, `IMPRV_LV`, and `REAL_FLV` are listed land, improvement, and full real values. They are Grand List values, not verified market values or a uniform taxable base. Some Grand List records can produce identical stacked polygons (including parcels, buildings, and mobile homes), so modeled record counts and sums are not de-duplicated ownership accounts.
- **Classification and occupancy**: `CAT = F` is used as a farm-category proxy and `CAT = R1` with positive improvements as a broad residential/SFH proxy; neither establishes a legal agricultural exemption or detached-home status. `HSDECL` identifies a reported homestead declaration, not verified owner occupancy.
- **Tax rates**: certified town rates are not configured. Every town currently uses an illustrative 6.5-mill placeholder on `REAL_FLV`; replace it with verified local rates and a validated tax base before citing dollar results.
- **Boundaries**: VCGI BNDHASH town and county boundaries are used for local geography and reporting; the town code is matched to its boundary because parcel features do not carry a county field. VCGI describes BNDHASH as best-available general mapping geography, not a legally definitive boundary. 2022 VCGI House/Senate reapportionment layers and Census TIGERweb 119th Congress/2020 urban areas supply the other geographies.

### District of Columbia

- **Parcels**: DC GIS Owner Polygons (Common Ownership Layer 40) carries polygon geometry and selected assessment attributes; the same polygons drive analysis and rendering. The service has about 137,400 records. Positive current land value occurs on about 96.2% and positive current building value on about 87.9% of records. Polygon centers determine geography membership; shapes draw at zoom 14+.
- **Values**: the model uses `PHASELAND` (Current Land Value), `PHASEBUILD` (Current Build Value), and `ASSESSMENT`. These current fields reconciled on the sampled records; `OLD*`, `NEW*`, and `ANNUALTAX` are retained in parcel exports for transparency but are not used in modeled totals or rates. Confirm the source's assessment-stage definitions and reconcile them against official tax bills before operational use.
- **Coverage and classification**: this is a mixed common-ownership polygon layer, not a clean one-feature-per-tax-account parcel roll. Shared/overlapping geometries and one-to-many SSL relationships can affect sums. Positive assessment is not a legal taxability determination. The field `PROPTYPE` identifies a detached single-family category for the SFH benchmark, but there is no verified owner-occupancy field or separately identified agricultural class.
- **Tax rates**: a certified DC tax-rate schedule is not configured. The model uses a single illustrative 6.5-mill placeholder, not actual bills; the source `ANNUALTAX` is not used because its calculation and coverage have not been independently validated.
- **Boundaries**: DC GIS 2022 Council wards are available as local council geography (not state legislative districts), and its administrative boundary is treated as the county equivalent. Census TIGERweb's 119th Congress layer returns DC's at-large, non-voting U.S. House delegate district; it is not a voting congressional seat. Census 2020 urban areas supply the urban filter.

### Massachusetts

- **Parcels**: MassGIS Level 3 Property Tax Parcels carries assessor records stacked on parcel polygons. The model includes the source-documented `FEE` and `TAX` polygon types and preserves separate condominium records even when they share a location or polygon. Parcel vectors draw at zoom 14+; the MassGIS cached tiles are not used because they cannot follow the active geography filter.
- **Values and coverage**: the model uses `LAND_VAL` and `TOTAL_VAL`, with modeled improvements as `TOTAL_VAL − LAND_VAL`. MassGIS explicitly notes that `TOTAL_VAL` may not equal `LAND_VAL + BLDG_VAL + OTHER_VAL`; the source building and other-improvement components remain visible in popups and downloads. Records with total below land are excluded. Assessment fiscal year (`FY`) varies by municipality, and assessor extracts are published as-is.
- **Classification and tax**: assessor `USE_DESC` text containing agriculture, horticulture, farm, or forest terms is a broad resource/agriculture proxy; descriptions can vary and mixed uses can be included. A description beginning “Single Family Residential” is the SFH benchmark proxy. Owner occupancy is not reported. Parcel tax bills are unavailable, so every town currently uses an illustrative 6.5-mill rate; replace it with certified town rates before citing tax-dollar estimates.
- **Boundaries**: MassGIS municipality polygons and town IDs support town and county membership; Census TIGERweb supplies county, 2026-vintage legislative, 119th Congress, and 2020 urban-area boundaries. Parcel maps are for analysis, not legal surveys.

### New Jersey

- **Parcels**: NJGIN's statewide normalized parcel composite carries MOD-IV assessment and tax attributes on polygons. The service has about 3.48 million records; roughly 3.05 million have positive `NET_VALUE`. The statewide composite was normalized between 2008 and 2014 and is updated as local submissions arrive; completeness and currency vary.
- **Values**: `LAND_VAL` and `NET_VALUE` define land and total assessed value. Modeled improvements are derived as `NET_VALUE − LAND_VAL` so the model's components reconcile; source `IMPRVT_VAL` is retained for comparison. Records with total below land are excluded. The parcel map is not survey data or an authoritative boundary source.
- **Tax rates**: municipality-level effective estimates are derived from grouped `LAST_YR_TX / NET_VALUE` totals. These are reported prior-year tax ratios, not a certified current rate schedule or independently reconciled bills. Missing municipal rates fall back to county and then statewide ratios. Rates and estimates should be reviewed against official tax data before operational use.
- **Classification and rendering**: MOD-IV classes 3A/3B are a farm-assessment proxy; class 2 with one reported dwelling and no commercial dwelling is the SFH benchmark proxy. There is no verified statewide exemption or owner-occupancy field. NJGIN redacts protected owner names under Daniel's Law. The FeatureServer has no low-zoom parcel image, so polygons draw at zoom 14+.
- **Boundaries**: Census TIGERweb 2026-vintage Senate and Assembly districts, 119th Congress districts, counties, 2020 county subdivisions, and urban areas are used. Municipal parcel-name filters are checked and fall back to spatial membership when source naming differs.

### Utah

- **Parcels**: UGRC publishes separate polygon LIR services for each of Utah's 29 counties; the statewide basic parcel layer intentionally omits assessor values. The model queries the county LIR services as a multi-source dataset, preserving county-scoped `OBJECTID`s.
- **Values and coverage**: the model uses `LAND_MKT_VALUE` and `TOTAL_MKT_VALUE`, with improvements derived as total minus land. In the October 2026 live audit, 1,480,414 of 1,525,742 positive-total records (97.03%) had a non-null, nonnegative land value not exceeding total. Rich County had 0 usable land values among 16,464 positive-total records; Summit County had 23,560 of 33,522 (70.3%). Other counties exceeded 80%. Coverage and record dates change as county feeds update.
- **Taxability and classes**: the LIR values are market values, not verified taxable assessments. `TAXEXEMPT_TYPE` and `PROP_CLASS` coding varies by county, so positive, internally consistent values are an analysis filter rather than a legal taxability determination. Agricultural labels containing “Agricultural” and residential/primary-residence/one-house attributes are broad class proxies; `PRIMARY_RES` is not verified owner occupancy.
- **Tax rates**: parcel tax bills are not supplied. All 1,641 features in the official Tax Areas 2024 layer returned a null `Rate`; the 2025 Tax Entities layer has component rates, but the model does not treat these as a verified parcel-level composite schedule. Current tax and scenarios use an illustrative 6.5-mill placeholder on market value, not official tax estimates. Replace the placeholder and validate taxable-value adjustments before citing dollar results.
- **Boundaries and rendering**: UGRC county and municipal boundaries, Utah House/Senate districts (2022–2032), and the current U.S. congressional plan (2026–2032) are used; Census TIGERweb supplies 2020 urban areas. Polygon centroid membership is used, and the hosted LIR layers have no low-zoom map image, so parcels draw at zoom 14+.
- **Performance**: district analyses fan out to up to 29 county services; county and municipality selections are narrowed to their source county. Aggregated averages are weighted by server-side counts, and median benchmarks use additive bins rather than merging service percentiles.

### West Virginia

- **Parcels and join**: WVGISTC parcel polygons (MapServer/0) provide geometry and `CleanParcelID`; the non-spatial `ParcelSummary` table (MapServer/11) provides Tax Year 2026 account records and appraisal values. The core selects polygons intersecting the chosen Census boundary, checks polygon centers for district membership, and queries matching table keys in batches. It does not rely on the service's dynamic join, which reports no pagination and no statistics support.
- **One-to-many behavior**: each matching 2026 table row is retained as an assessment record. Multiple records linked to one `CleanParcelID` appear stacked on that polygon and remain separate in statistics and exports; these are source-record counts, not deduplicated ownership counts. Table-only keys without geometry and geometry without a matching taxable table row are excluded.
- **Values and limits**: `LandAppraisal`, `BuildingAppraisal`, and `TotalAppraisal` are the modeled values. In a live 2026 table query, 1,415,197 of 1,503,439 rows have positive total appraisal; 1,415,171 of those have nonnegative land and building appraisals (99.998%) before the geometry-key match. The geometry service describes itself as updated for 2023, while the value table includes 2026 records, so current key coverage and source timing should be checked when the data refreshes. The app aggregates selected-geography table records in the browser because the joined layer cannot run grouped statistics. This is most suitable for county and individual district selections; very large selections can require substantial network transfer and browser memory.
- **Classification and tax**: `PropertyClassCode = F` is a farm proxy and `LandUseCode = 101` with positive building appraisal is a residential one-family/SFH proxy. Neither establishes legal tax treatment, detached-home status, or owner occupancy. All counties currently use an illustrative 6.5-mill placeholder, not official rates or bills.
- **Boundaries**: Census TIGERweb 2026-vintage Senate, House of Delegates, and 119th Congress boundaries, plus 2020 counties, incorporated places, and urban areas.

### Indiana

- **Parcels and values**: The app includes 92 Indiana Gateway Real Property ZIPs under `assets/indiana/` for assessment year 2025 / taxes paid 2026. Each county file is parsed in the browser as a 50 IAC 26 positional fixed-width file; the 25-column Gateway Parcel Number joins to IGIO Data Harvest `state_parcel_id` in the current statewide parcel polygon service. The browser loads only the selected county's ZIP and matching county parcel geometries; there is no statewide all-county option.
- **Assessment fields**: Gateway record positions 469–480 contain current AV total land; 481–492 contain current AV total improvements; 1275–1286 contain gross AV total land and improvements. The model uses land and gross total directly, deriving modeled improvements as total minus land so values reconcile. The Gateway-reported improvements are retained for transparency because 7,438 statewide records show a mismatch between reported land + improvements and gross total.
- **Coverage and limits**: bundled county files contain about 3.60 million assessment records; a deterministic sample of up to 100 parcel keys per county matched current IGIO geometry at 97% overall (some counties have gaps such as Vigo and Brown). County metrics and detailed exports include valid positive-value assessment records from the selected Gateway county file; only records with matching IGIO geometry appear on the map or in map popups. The 92 ZIP archives total roughly 392 MB compressed, are public-record files containing owner/address data, and are included as directly downloadable static assets. Do not deploy the site publicly with these archives unless that data exposure is intentionally accepted. Very large counties can require significant browser memory/time.
- **Classification and tax**: DLGF property class codes 100–199 are treated as an agricultural/resource proxy; codes 510–515 as residential one-family proxy. These do not independently establish legal taxability, detached-home status, or owner occupancy. A uniform illustrative 6.5-mill rate is used; county rates and tax credits are not modeled.
- **Geography**: county selection only, using current IGIO county boundaries. Legislative/congressional and municipality selections are intentionally omitted for this county-file implementation. TIGERweb 2020 urban areas support high-value urban highlights.

### Ohio

- **Coverage**: this is a live-service pilot for six counties, not a statewide Ohio parcel roll: Franklin, Cuyahoga, Hamilton, Delaware, Fairfield, and Licking. The app does not download and bundle parcel files.
- **Sources**: Franklin County Auditor parcels; Cuyahoga County Fiscal Office Parcel Fabric; Hamilton County CAGIS/Auditor parcel polygons; and the Central Ohio regional parcel layer restricted to Delaware, Fairfield, and Licking. Franklin is excluded from the regional source to prevent double counting. All four services are queried directly by the browser and expose parcel attributes with their geometries.
- **Value basis**: Franklin, Central Ohio, and Hamilton publish base/market appraisal components. The model scales those components to an approximate assessed base at Ohio's 35% assessment ratio. Cuyahoga's reported assessed land and total values are used directly; modeled improvements are derived as total minus land. This makes the units more comparable but is not a county-roll reconciliation, especially for CAUV parcels, partial exemptions, abatements, and credits. The current Hamilton source has usable positive total/land values on about 79% of its parcel records; Cuyahoga's current feed has about 477,000 positive-assessment records.
- **Rates and taxability**: no certified composite parcel or jurisdiction rates are configured; a clearly labeled 6.5-mill illustrative placeholder is used. Explicitly labeled exempt property classes are filtered out in Franklin, Central Ohio, and Cuyahoga, but a positive-value filter is not a legal determination of taxability. Exemptions and parcel-specific adjustments are not reconciled uniformly across all four feeds.
- **Classification**: agricultural, vacant, and single-family categories are proxies built from county-specific class, CAUV, and land-use fields. Their coding and reliability vary by county; homestead/occupancy is not consistently reported.
- **Geography and rendering**: Census TIGERweb supplies 2026-vintage Ohio legislative districts, 119th Congress districts, selected-county boundaries, incorporated places, and 2020 urban areas. District and place statistics include only the portions with parcel-source coverage. Parcel membership uses polygon centroids. Cuyahoga is a hosted FeatureServer without low-zoom map export, so parcel shapes render at zoom 14+.
- **Limits**: services may update independently, change schema, or be unavailable. County selections are restricted to the six covered counties; statewide district/place selections are partial and must not be interpreted as statewide totals. See [js/states/ohio.js](js/states/ohio.js) for current endpoints and field mappings.

### Virginia

- **Coverage**: the supplied live parcel layer is for Essex County only, not a statewide Virginia parcel roll. The current service has 10,255 features; 10,057 (98.1%) have positive `TotalParc`. County analysis is restricted to Essex County, and the municipality choice is Tappahannock. District choices are limited to the Essex-overlapping Virginia Senate 25, House of Delegates 67/68, and 119th Congress districts 1/7; district totals therefore include only the Essex County parcel subset.
- **Values**: `TotalLand`, `TotalImp`, and `TotalParc` are described by the publisher as values appraised by the Commissioner of the Revenue. They reconcile on all positive-total records in the live audit. The layer name references 2023, while the ArcGIS item title indicates a 2026 update; the service does not identify an explicit assessment/tax year or certified taxable/equalized value basis.
- **Classification and tax**: `PrimaryUse` provides broad Residential, Vacant, Commercial, and Mobile Home codes plus a relative-size component. A code ending in R is only a residential-improved/SFH benchmark proxy; agricultural use, detached-home status, owner occupancy, exemptions, and parcel tax bills are not separately reported. A clearly labeled 6.5-mill illustrative placeholder is used instead of certified county or municipal rates. Owner names and mailing addresses are omitted from app queries, popups, and exports.
- **Boundaries and rendering**: Census TIGERweb 2026 state legislative districts, 119th Congress districts, county/place boundaries, and 2020 urban areas are used. Parcel polygons determine membership by their centers. The hosted FeatureServer has no low-zoom image, so parcels draw at zoom 14+. This is a county pilot only; statewide Virginia analysis requires additional locality assessment feeds.


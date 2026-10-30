"use strict";

// Core app: map, geography selection, tax analysis, scenarios, popups, and downloads.
// Every state-specific schema detail is read from the active state adapter (js/states/*.js).

const VECTOR_MIN_ZOOM = 14;
// Land-share distributions are requested as counts at 5-point bands (0%, 5%, … 95%, below 100%).
const LAND_SHARE_BANDS = 20;
// Bills that change by less than this fraction either way count as "about the same".
const ABOUT_THE_SAME_THRESHOLD = 0.01;
const REST_OF_COUNTY_LABEL = "Rest of county";
const NOT_AVAILABLE_TEXT = "n/a";
const PARCEL_COLOR = "#9b721e";
const PARCEL_FILL_COLOR = "#e5be72";

const TAX_CONFIG = {
  kicker: "Assessment signals",
  title: "Tax model analyzer",
  metrics: [
    { label: "Land value", format: (s) => (s.landValue === null ? "—" : formatCompactCurrency(s.landValue)) },
    { label: "Overall value", format: (s) => (s.totalValue === null ? "—" : formatCompactCurrency(s.totalValue)) },
    { label: "Land / total", format: (s) => (s.landValueRatio === null ? "—" : formatPercent(s.landValueRatio)) },
    { label: "Current tax", format: (s) => (s.currentTaxRevenue === null ? "—" : formatCompactCurrency(s.currentTaxRevenue)) },
    { label: "SFH homes (n)", format: (s) => (s.sfhCount === null || s.sfhCount === undefined ? "—" : s.sfhCount.toLocaleString()) },
    { label: "SFH land / total (mean)", format: (s) => (s.meanSfhLandRatio === null || s.meanSfhLandRatio === undefined ? "—" : formatPercent(s.meanSfhLandRatio * 100)) },
    { label: "SFH land / total (median)", format: (s) => (s.medianSfhLandRatio === null || s.medianSfhLandRatio === undefined ? "—" : formatPercent(s.medianSfhLandRatio * 100)) },
  ],
};

const temporarilyDisabledStates = new Set(["IN"]);

let state = (() => {
  const requestedId = new URLSearchParams(window.location.search).get("state")?.toUpperCase();
  const requestedState = requestedId ? window.ParcelStates.get(requestedId) : null;
  return requestedState && !temporarilyDisabledStates.has(requestedState.id)
    ? requestedState
    : window.ParcelStates.get(window.ParcelStates.defaultId);
})();

const map = L.map("map", { zoomControl: false, preferCanvas: true }).setView(state.center, state.zoom);
const zoomControl = L.control.zoom({ position: "bottomright" }).addTo(map);
const zoomLevelIndicator = L.DomUtil.create("span", "leaflet-control-zoom-level", zoomControl.getContainer());
zoomLevelIndicator.setAttribute("role", "status");
zoomLevelIndicator.setAttribute("aria-live", "polite");

const updateZoomLevel = () => {
  const zoomLevel = map.getZoom();
  zoomLevelIndicator.textContent = `Zoom ${zoomLevel}`;
  zoomLevelIndicator.setAttribute("aria-label", `Map zoom level ${zoomLevel}`);
};
map.on("zoomend", updateZoomLevel);
updateZoomLevel();

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const $ = (selector) => document.querySelector(selector);
const elements = {
  stateSelect: $("#state-select"),
  brandMark: $("#brand-mark"),
  appEyebrow: $("#app-eyebrow"),
  dataNoteText: $("#data-note-text"),
  acknowledgementsList: $("#acknowledgements-list"),
  toolPanel: $("#tool-panel"),
  toolKicker: $("#tool-kicker"),
  toolTitle: $("#tool-title"),
  toolDescription: $("#tool-description"),
  toolRateNote: $("#tool-rate-note"),
  statusIndicator: $("#status-indicator"),
  statusMessage: $("#status-message"),
  parcelLoadProgress: $("#parcel-load-progress"),
  parcelLoadProgressLabel: $("#parcel-load-progress-label"),
  parcelLoadProgressCount: $("#parcel-load-progress-count"),
  parcelLoadProgressBar: $("#parcel-load-progress-bar"),
  parcelCountLabel: $("#parcel-count-label"),
  parcelCount: $("#parcel-count"),
  analysisMetrics: $("#analysis-metrics"),
  taxModelControls: $("#tax-model-controls"),
  taxScopeControl: $("#tax-scope-control"),
  taxScopeSelect: $("#tax-scope-select"),
  neutralModeInputs: document.querySelectorAll('input[name="neutral-mode"]'),
  neutralRatio: $("#neutral-ratio"),
  neutralRatioGroup: $("#neutral-ratio-group"),
  neutralLandOnlyNote: $("#neutral-land-only-note"),
  neutralHint: $("#neutral-hint"),
  applyNeutralRatio: $("#apply-neutral-ratio"),
  resetTaxModel: $("#reset-tax-model"),
  taxModelResult: $("#tax-model-result"),
  hypotheticalTaxValue: $("#hypothetical-tax-value"),
  hypotheticalTaxDelta: $("#hypothetical-tax-delta"),
  taxCurrentCountyResults: $("#tax-current-county-results"),
  taxCurrentHeading: $("#tax-current-heading"),
  taxModelHeading: $("#tax-model-heading"),
  taxModelCountyResults: $("#tax-model-county-results"),
  taxDownloadControls: $("#tax-download-controls"),
  downloadSummary: $("#download-summary"),
  downloadParcels: $("#download-parcels"),
  downloadMetadata: $("#download-metadata"),
  mapStatus: $("#map-status-text"),
  refreshParcels: $("#refresh-parcels"),
  geographyToggle: $("#geography-toggle"),
  geographyMenu: $("#geography-menu"),
  geographySelection: $("#geography-selection"),
  geographyTypeSelect: $("#geography-type-select"),
  geographyChoiceLabel: $("#geography-choice-label"),
  geographyChoiceSelect: $("#geography-choice-select"),
  underutilizedControl: $("#underutilized-control"),
  underutilizedSelect: $("#underutilized-select"),
  underutilizedDescription: $("#underutilized-description"),
  underutilizedDescriptionText: $("#underutilized-description-text"),
  underutilizedZoomHint: $("#underutilized-zoom-hint"),
  underutilizedZoomHintText: $("#underutilized-zoom-hint-text"),
  underutilizedZoomButton: $("#underutilized-zoom-button"),
  selectedGeography: $("#selected-geography"),
  acknowledgements: $(".acknowledgements"),
  acknowledgementsTrigger: $(".acknowledgements-trigger"),
  acknowledgementsPopover: $("#acknowledgements-popover"),
};

zoomControl.getContainer().append(elements.mapStatus.closest(".map-status"));

let parcelLayer = null;
let geographyLayer = null;
let geographyFeatures = [];
let selectedGeography = null;
let geographyLoadRequest = null;
let currentRequest = null;
let taxScenarioModel = null;
let taxScenarioFrame = 0;
let downloadRequest = null;
let openParcelPopup = null;
let latestTaxSummary = null;
let underutilizedMode = "";
let underutilizedUpdateId = 0;
let underutilizedContext = null;
let parcelLoadingMarker = null;
const geographyCache = new Map();

// ---------- Status and formatting ----------

function setStatus(message, status = "ready") {
  elements.statusMessage.textContent = message;
  elements.statusIndicator.className = "status-indicator";
  if (status !== "ready") elements.statusIndicator.classList.add(`is-${status}`);
}

function updateMapStatus(message) {
  elements.mapStatus.textContent = message;
}

function showParcelLoadProgress(label, loaded = 0, total = null, indeterminate = false) {
  elements.parcelLoadProgress.hidden = false;
  elements.parcelLoadProgress.classList.toggle("is-indeterminate", indeterminate);
  elements.parcelLoadProgressLabel.textContent = label;
  elements.parcelLoadProgressCount.textContent = total === null
    ? "Working…"
    : `${loaded.toLocaleString()} / ${total.toLocaleString()}`;
  elements.parcelLoadProgressBar.style.width = total && !indeterminate ? `${Math.min(100, (loaded / total) * 100)}%` : "0%";
}

function hideParcelLoadProgress() {
  elements.parcelLoadProgress.hidden = true;
  elements.parcelLoadProgress.classList.remove("is-indeterminate");
  elements.parcelLoadProgressBar.style.width = "0%";
}

function formatPercent(value) {
  return Number.isFinite(value)
    ? `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value)}%`
    : "Not available";
}

function formatCurrency(value) {
  const number = value === null || value === undefined || value === "" ? Number.NaN : Number(value);
  return Number.isFinite(number)
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(number)
    : "Not available";
}

function formatCompactCurrency(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "Not available";
  const absolute = Math.abs(number);
  if (absolute >= 1e9) return `$${(number / 1e9).toFixed(2)}B`;
  if (absolute >= 1e6) return `$${(number / 1e6).toFixed(2)}M`;
  if (absolute >= 1e3) return `$${(number / 1e3).toFixed(2)}K`;
  return formatCurrency(number);
}

function formatTaxRate(value) {
  const number = value === null || value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(number)
    ? `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(number * 100)}%`
    : "Not available";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function updateAnalysisMetrics(summary = null) {
  elements.analysisMetrics.replaceChildren(...TAX_CONFIG.metrics.map((metric) => {
    const card = document.createElement("div");
    card.className = "metric-card";
    const label = document.createElement("span");
    label.className = "metric-label";
    label.textContent = metric.label;
    const value = document.createElement("strong");
    value.textContent = summary ? metric.format(summary) : "—";
    card.append(label, value);
    return card;
  }));
}

// ---------- Parcel values (state-neutral) ----------

function parcelValues(properties) {
  return state.values(properties || {});
}

function isImproved(properties) {
  const { improvement } = parcelValues(properties);
  return improvement !== null && Number.isFinite(improvement) && improvement > 0;
}

function propertyTypeFor(properties) {
  const facts = { properties, improved: isImproved(properties) };
  return state.propertyTypes.find((type) => type.matches(facts));
}

function occupancyGroupFor(properties) {
  const { field, groups } = state.occupancy;
  if (field) {
    const code = String(properties[field] || "").trim().toUpperCase();
    return groups.find((group) => group.key === code) || groups.at(-1);
  }
  return groups.find((group) => !group.matches || group.matches(properties)) || groups.at(-1);
}

function taxJurisdictionDetails(properties) {
  return state.taxJurisdictionDetails(properties || {});
}

function parcelCenter(feature) {
  return state.parcels.center?.(feature.properties || {}) || geometryCenter(feature.geometry);
}

// ---------- Geography selection ----------

function geographyConfig(type = elements.geographyTypeSelect.value) {
  return state.geographies[type];
}

function formatGeographyName(feature = selectedGeography) {
  return feature ? feature.properties.GEOGRAPHY_LABEL : `All ${state.name}`;
}

function loadGeographyFeatures(type, signal, options) {
  const key = `${state.id}:${type}`;
  if (options) return state.geographies[type].load(signal, options);
  if (!geographyCache.has(key)) {
    const promise = state.geographies[type].load(signal).then((features) => {
      features.forEach((feature) => { feature.properties.GEOGRAPHY_TYPE = type; });
      return features;
    });
    geographyCache.set(key, promise);
    promise.catch(() => geographyCache.delete(key));
  }
  return geographyCache.get(key);
}

async function loadGeographyChoices(type) {
  const config = geographyConfig(type);
  if (geographyLoadRequest) geographyLoadRequest.abort();
  const request = new AbortController();
  geographyLoadRequest = request;
  const stateAtRequest = state;
  elements.geographyChoiceLabel.textContent = `Choose a ${config.choiceLabel.toLowerCase()}`;
  elements.geographyChoiceSelect.disabled = true;
  elements.geographyChoiceSelect.replaceChildren(new Option("Loading choices…", ""));

  try {
    const features = await loadGeographyFeatures(type, request.signal);
    if (geographyLoadRequest !== request || state !== stateAtRequest) return;
    geographyFeatures = features;
    const allowAllGeographies = state.parcels.allowAllGeographies !== false;
    elements.geographyChoiceSelect.replaceChildren(
      ...(allowAllGeographies ? [new Option(`All ${state.name}`, "")] : []),
    );
    geographyFeatures.forEach((feature) => {
      elements.geographyChoiceSelect.add(new Option(feature.properties.GEOGRAPHY_LABEL, feature.properties.GEOGRAPHY_VALUE));
    });
    elements.geographyChoiceSelect.disabled = false;
    if (!allowAllGeographies && geographyFeatures.length) {
      selectedGeography = geographyFeatures[0];
      elements.geographyChoiceSelect.value = String(selectedGeography.properties.GEOGRAPHY_VALUE);
      elements.geographySelection.textContent = formatGeographyName();
      elements.selectedGeography.textContent = formatGeographyName();
      elements.geographyMenu.classList.toggle("selection-menu--county-districts", Boolean(config.wideMenu));
      showSelectedGeography();
      loadParcels();
    }
  } catch (error) {
    if (error.name === "AbortError" || geographyLoadRequest !== request) return;
    console.error(error);
    elements.geographyChoiceSelect.replaceChildren(new Option("Choices unavailable", ""));
    updateMapStatus(`Could not load ${config.label.toLowerCase()}`);
  }
}

function showSelectedGeography() {
  if (geographyLayer) {
    map.removeLayer(geographyLayer);
    geographyLayer = null;
  }
  if (!selectedGeography) {
    map.setView(state.center, state.zoom);
    return;
  }
  geographyLayer = L.geoJSON(selectedGeography, {
    style: { color: "#0f4d40", weight: 2, opacity: 0.9, fillColor: "#8ed1b4", fillOpacity: 0.1, interactive: false },
  }).addTo(map);
  geographyLayer.bringToFront();
  map.fitBounds(geographyLayer.getBounds(), { padding: [42, 42] });
}

function geographyAttributeFilter(geography, source = null) {
  if (!geography || geography.attributeFilterFailed) return null;
  return state.geographies[geography.properties.GEOGRAPHY_TYPE]?.attributeFilter?.(geography, source) || null;
}

function isSpatialGeography(geography) {
  return Boolean(geography) && !geographyAttributeFilter(geography);
}

function analysisSourcesForGeography(geography = null) {
  const sources = state.parcels.analysisSources?.length
    ? state.parcels.analysisSources.map((source, index) => ({ ...source, key: source.key || `source-${index}` }))
    : [{ key: "primary", url: state.parcels.analysisUrl }];
  const selectedCounty = String(geography?.properties?.COUNTY || "").replace(/\s+County$/i, "").trim().toUpperCase();
  if (!selectedCounty || !state.parcels.analysisSources) return sources;
  const matching = sources.filter((source) => {
    const counties = source.countyNames || (source.countyName ? [source.countyName] : []);
    return counties.some((county) => String(county).replace(/\s+County$/i, "").trim().toUpperCase() === selectedCounty);
  });
  if (matching.length || state.parcels.strictCountySources) return matching;
  return sources;
}

function mapSourceExpression(expression, source) {
  if (!expression || !source?.fieldMap) return expression;
  return Object.entries(source.fieldMap).reduce((result, [canonical, actual]) =>
    result.replace(new RegExp(`\\b${canonical}\\b`, "g"), String(actual)), String(expression));
}

function sourceScopedWhere(geography, source = null, extraWhere = null) {
  const parts = [
    source?.taxableWhere || mapSourceExpression(state.parcels.taxableWhere, source),
    source?.where,
    source?.whereForGeography?.(geography),
    geographyAttributeFilter(geography, source),
    mapSourceExpression(extraWhere, source),
  ];
  return combinedWhere(parts);
}

function sourceOutFields(source) {
  return source?.outFields || state.parcels.outFields;
}

function sourceObjectIdField(source) {
  return source?.objectIdField || state.parcels.objectIdField;
}

function normalizeSourceProperties(source, properties) {
  const raw = properties || {};
  return source?.normalizeProperties ? source.normalizeProperties(raw) : raw;
}

function sourceStatistics(source, statistics) {
  return statistics.map((statistic) => ({
    ...statistic,
    onStatisticField: mapSourceExpression(statistic.onStatisticField, source),
  }));
}

const relatedRecordsByGeography = new WeakMap();

function relatedGeometryParams(geography) {
  if (!isSpatialGeography(geography)) return {};
  return {
    geometry: JSON.stringify(esriPolygonFromGeometry(geography.geometry, 3857)),
    geometryType: "esriGeometryPolygon",
    inSR: "3857",
    spatialRel: "esriSpatialRelIntersects",
  };
}

async function relatedGeometryByKey(geography, signal) {
  const config = state.parcels.relatedTable;
  const byKey = new Map();
  const pageSize = state.parcels.pageSize || 1000;
  const maxFeatures = config.maxGeometryFeatures || 500000;
  for (let offset = 0; offset < maxFeatures; offset += pageSize) {
    const payload = await arcgisQuery(state.parcels.analysisUrl, {
      where: config.geometryWhere || "1=1",
      ...relatedGeometryParams(geography),
      outFields: config.geometryOutFields,
      returnGeometry: "true",
      outSR: "4326",
      resultOffset: String(offset),
      resultRecordCount: String(pageSize),
      orderByFields: state.parcels.objectIdField,
      f: "geojson",
    }, signal);
    if (payload.type !== "FeatureCollection") throw new Error("The parcel geometry service did not return GeoJSON for the value-table join.");
    const features = payload.features || [];
    features.forEach((feature) => {
      if (!feature.geometry) return;
      const center = geometryCenter(feature.geometry);
      if (!center || (isSpatialGeography(geography) && !geometryContains(geography.geometry, center))) return;
      const key = String(feature.properties?.[config.geometryKeyField] ?? "").trim();
      if (!key || byKey.has(key)) return;
      byKey.set(key, { geometry: feature.geometry, center, properties: feature.properties || {} });
    });
    const more = payload.exceededTransferLimit || payload.properties?.exceededTransferLimit;
    if (!more || !features.length) return byKey;
  }
  throw new Error(`The parcel boundary query exceeded the ${maxFeatures.toLocaleString()} feature safety limit for this geography.`);
}

async function relatedRowsForKeys(keys, geometryByKey, signal) {
  const config = state.parcels.relatedTable;
  const uniqueKeys = [...new Set(keys.map((key) => String(key || "").trim()).filter(Boolean))];
  if (!uniqueKeys.length) return [];
  const chunkSize = config.keysPerRequest || 1000;
  const chunks = [];
  for (let index = 0; index < uniqueKeys.length; index += chunkSize) chunks.push(uniqueKeys.slice(index, index + chunkSize));
  const groups = await mapWithConcurrency(chunks, config.queryConcurrency || 5, async (chunk) => {
    const keyWhere = `${config.keyField} IN (${chunk.map(sqlString).join(",")})`;
    const maxRows = config.maxRowsPerChunk || 20000;
    const features = await queryAllJson(config.url, {
      where: combinedWhere([config.where, keyWhere]),
      outFields: config.outFields,
      returnGeometry: "false",
      orderByFields: config.orderBy || "ID",
    }, signal, config.tablePageSize || 2000, maxRows);
    if (features.length >= maxRows) throw new Error(`The related value-table query reached its ${maxRows.toLocaleString()}-row per-batch safety limit.`);
    return features.map((feature) => {
      const attributes = feature.attributes || {};
      const key = String(attributes[config.keyField] ?? "").trim();
      const geometry = geometryByKey.get(key);
      return geometry ? {
        ...geometry.properties,
        ...attributes,
        __parcelCenter: geometry.center,
        __parcelGeometryKey: key,
      } : null;
    }).filter(Boolean);
  });
  return groups.flat();
}

async function relatedRecordsForGeography(geography, signal) {
  if (!geography) throw new Error("Select a geography before loading joined parcel records.");
  const config = state.parcels.relatedTable;
  if (config.loadRecords) {
    return config.loadRecords(geography, signal);
  }
  let promise = relatedRecordsByGeography.get(geography);
  if (!promise) {
    promise = (async () => {
      const geometryByKey = await relatedGeometryByKey(geography, signal);
      return relatedRowsForKeys([...geometryByKey.keys()], geometryByKey, signal);
    })();
    relatedRecordsByGeography.set(geography, promise);
    promise.catch(() => relatedRecordsByGeography.delete(geography));
  }
  return promise;
}

function relatedStatisticValue(properties, field) {
  const config = state.parcels.relatedTable;
  if (config.statisticValue) return config.statisticValue(properties, field);
  const value = properties[field];
  return value === null || value === undefined || value === "" ? null : Number(value);
}

async function runRelatedTableStatistics(geography, statistics, { matches = null, groupBy = null } = {}, signal) {
  const records = await relatedRecordsForGeography(geography, signal);
  const groupFields = groupBy ? groupBy.split(",").map((field) => field.trim()) : [];
  const groups = new Map();
  records.forEach((properties) => {
    if (matches && !matches(properties)) return;
    const values = groupFields.map((field) => properties[field] ?? null);
    const key = JSON.stringify(values);
    if (!groups.has(key)) groups.set(key, { attributes: Object.fromEntries(groupFields.map((field, index) => [field, values[index]])), values: new Map() });
    const group = groups.get(key);
    statistics.forEach((statistic, index) => {
      const kind = String(statistic.statisticType).toLowerCase();
      if (kind === "percentile_cont") throw new Error("Client-side joined-table statistics do not support percentile queries; configure additive bins instead.");
      const raw = relatedStatisticValue(properties, statistic.onStatisticField);
      if (raw === null || raw === undefined || !Number.isFinite(Number(raw))) return;
      const current = group.values.get(index) || { sum: 0, count: 0, min: Infinity, max: -Infinity };
      const number = Number(raw);
      current.sum += number;
      current.count += 1;
      current.min = Math.min(current.min, number);
      current.max = Math.max(current.max, number);
      group.values.set(index, current);
    });
  });
  return [...groups.values()].map(({ attributes, values }) => {
    statistics.forEach((statistic, index) => {
      const kind = String(statistic.statisticType).toLowerCase();
      const result = values.get(index);
      attributes[statistic.outStatisticFieldName] = kind === "count" ? (result?.count || 0)
        : kind === "avg" ? (result?.count ? result.sum / result.count : null)
          : kind === "sum" ? (result?.sum || 0)
            : kind === "min" ? (result?.count ? result.min : null)
              : kind === "max" ? (result?.count ? result.max : null) : null;
    });
    return { attributes };
  });
}

function combinedWhere(parts) {
  return parts.filter(Boolean).map((part) => `(${part})`).join(" AND ");
}

// Name-matched attribute filters (e.g. municipality names) can miss when the parcel roll spells a
// place differently. If the filter matches no taxable parcels, the boundary is used spatially instead.
async function verifyAttributeFilter(geography, signal) {
  if (state.parcels.relatedTable) return;
  const config = geography && state.geographies[geography.properties.GEOGRAPHY_TYPE];
  if (!config?.verifyAttributeFilter || geography.attributeFilterChecked) return;
  const sources = analysisSourcesForGeography(geography);
  if (!sources.length) return;
  const filters = sources.map((source) => geographyAttributeFilter(geography, source)).filter(Boolean);
  if (!filters.length) return;
  const counts = await mapWithConcurrency(sources, 6, async (source) => {
    const { count } = await arcgisQuery(source.url, {
      where: sourceScopedWhere(geography, source),
      returnCountOnly: "true",
      f: "json",
    }, signal);
    return Number(count) || 0;
  });
  const count = counts.reduce((sum, value) => sum + value, 0);
  geography.attributeFilterChecked = true;
  if (!count) {
    console.warn(`No parcels matched the configured attribute filter; using the boundary instead.`);
    geography.attributeFilterFailed = true;
  }
}

// Polygon analysis layers (no parcel points) are assigned to a district by centroid.
// The server counts every polygon that intersects the district, so parcels that touch the
// district outline but whose centroid lies outside are found once and excluded by object ID.
async function ensureGeographyMembership(geography, signal) {
  if (state.parcels.relatedTable) return;
  const isMultiSource = Boolean(state.parcels.analysisSources?.length);
  if (!geography || (isMultiSource ? geography.excludedIdsBySource : geography.excludedIds)
    || state.parcels.analysisGeometry !== "polygon" || !isSpatialGeography(geography)) return;
  const rings = polygonsOf(geography.geometry).flatMap((polygon) => polygon);
  const outline = JSON.stringify({ paths: rings, spatialReference: { wkid: 4326 } });
  const contains = createPointInGeometryTester(geography.geometry);
  const sources = analysisSourcesForGeography(geography);
  if (!sources.length) {
    geography.excludedIdsBySource = {};
    geography.excludedIdsSetBySource = {};
    return;
  }
  const exclusions = await mapWithConcurrency(sources, 6, async (source) => {
    const objectIdField = sourceObjectIdField(source);
    const features = await queryAllJson(source.url, {
      where: sourceScopedWhere(geography, source),
      geometry: outline,
      geometryType: "esriGeometryPolyline",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: [objectIdField, ...(source?.centerOutFields || [])].join(","),
      returnGeometry: "false",
      returnCentroid: "true",
      outSR: "4326",
      orderByFields: objectIdField,
    }, signal, source.pageSize || state.parcels.pageSize || 2000);
    const excludedIds = features
      .filter((feature) => {
        const attributes = normalizeSourceProperties(source, feature.attributes || {});
        const center = state.parcels.center?.(attributes)
          || (feature.centroid ? [feature.centroid.x, feature.centroid.y] : null);
        return center && !contains(center);
      })
      .map((feature) => feature.attributes?.[objectIdField] ?? feature.attributes?.[objectIdField.toLowerCase()]);
    return { key: source.key, excludedIds };
  });
  if (isMultiSource) {
    geography.excludedIdsBySource = Object.fromEntries(exclusions.map(({ key, excludedIds }) => [key, excludedIds]));
    geography.excludedIdsSetBySource = Object.fromEntries(exclusions.map(({ key, excludedIds }) => [key, new Set(excludedIds)]));
  } else {
    geography.excludedIds = exclusions[0]?.excludedIds || [];
  }
}

function parcelWhere(geography, { exclusions = true, source = null } = {}) {
  const parts = [sourceScopedWhere(geography, source)];
  const sourceExcludedIds = source && state.parcels.analysisSources?.length
    ? geography?.excludedIdsBySource?.[source.key]
    : geography?.excludedIds;
  if (exclusions && sourceExcludedIds?.length) {
    parts.push(`${sourceObjectIdField(source)} NOT IN (${sourceExcludedIds.join(",")})`);
  }
  return combinedWhere(parts);
}

function geographySpatialParams(geography) {
  if (!isSpatialGeography(geography)) return {};
  return {
    geometry: JSON.stringify(esriPolygonFromGeometry(geography.geometry, 3857)),
    geometryType: "esriGeometryPolygon",
    inSR: "3857",
    spatialRel: "esriSpatialRelIntersects",
  };
}

// Membership test for features drawn or clicked on the map (statistics use the server query instead).
function featureInGeography(feature, geography) {
  if (!isSpatialGeography(geography)) return true;
  const source = state.parcels.analysisSources?.find((item) => item.key === feature.__analysisSourceKey);
  if (state.parcels.analysisSources?.length && geography?.excludedIdsSetBySource) {
    const excludedIds = geography.excludedIdsSetBySource[feature.__analysisSourceKey];
    const objectIdField = sourceObjectIdField(source);
    const objectId = feature.properties?.[objectIdField] ?? feature.properties?.[objectIdField.toLowerCase()];
    if (excludedIds?.has(objectId)) return false;
  }
  return geometryContains(geography.geometry, parcelCenter(feature));
}

// ---------- Statistics ----------

function analysisQueryParams(geography, extraWhere = null, source = null) {
  const where = parcelWhere(geography, { source });
  return {
    where: extraWhere ? `${where} AND (${extraWhere})` : where,
    returnGeometry: "false",
    ...geographySpatialParams(geography),
  };
}

async function runStatistics(geography, statistics, { where = null, whereForSource = null, groupBy = null, matches = null } = {}, signal) {
  if (state.parcels.relatedTable) {
    return runRelatedTableStatistics(geography, statistics, { matches, groupBy }, signal);
  }
  if (state.parcels.analysisSources?.length) {
    return arcgisStatisticsAcrossSources(
      analysisSourcesForGeography(geography),
      (source) => analysisQueryParams(geography, whereForSource ? whereForSource(source) : mapSourceExpression(where, source), source),
      statistics,
      groupBy,
      signal,
      (source) => sourceStatistics(source, statistics),
    );
  }
  const params = {
    ...analysisQueryParams(geography, where),
    outStatistics: JSON.stringify(statistics),
    f: "json",
  };
  if (groupBy) {
    params.outFields = groupBy;
    params.groupByFieldsForStatistics = groupBy;
  }
  const payload = await arcgisQuery(state.parcels.analysisUrl, params, signal);
  return payload.features || [];
}

function landRatioExpression() {
  return `CAST(${state.fields.land} AS FLOAT) / ${state.fields.total}`;
}

// Hosted feature layers reject PERCENTILE_CONT on expressions, so those states estimate the
// median from cumulative counts at 2% land-share steps, interpolated within the step.
const SFH_MEDIAN_BINS = 50;

async function loadSfhBenchmarks(geography, signal) {
  const ratio = landRatioExpression();
  const { land, total } = state.fields;
  const usePercentile = state.parcels.percentileExpressions !== false;
  const statistics = [
    { statisticType: "count", onStatisticField: land, outStatisticFieldName: "sfhCount" },
    { statisticType: "avg", onStatisticField: ratio, outStatisticFieldName: "meanRatio", countStatisticField: "sfhCount" },
  ];
  if (usePercentile) {
    statistics.push({ statisticType: "PERCENTILE_CONT", statisticParameters: { value: 0.5 }, onStatisticField: ratio, outStatisticFieldName: "medianRatio" });
  } else {
    for (let bin = 0; bin < SFH_MEDIAN_BINS; bin += 1) {
      statistics.push({
        statisticType: "sum",
        onStatisticField: `CASE WHEN ${land} <= ${total} * ${(bin / SFH_MEDIAN_BINS).toFixed(4)} THEN 1 ELSE 0 END`,
        outStatisticFieldName: `atMost${bin}`,
      });
    }
  }
  const features = await runStatistics(geography, statistics, {
    where: state.sfh.where,
    whereForSource: (source) => source.sfhWhere || mapSourceExpression(state.sfh.where, source),
    matches: state.sfh.matches,
  }, signal);
  const attributes = features[0]?.attributes || {};
  const read = (field) => {
    const value = statAttribute(attributes, field);
    return value === null || value === undefined ? null : Number(value);
  };
  const sfhCount = read("sfhCount") ?? 0;
  let medianSfhLandRatio = usePercentile ? read("medianRatio") : null;
  if (!usePercentile && sfhCount > 0) {
    const cumulative = [...Array.from({ length: SFH_MEDIAN_BINS }, (_, bin) => read(`atMost${bin}`) ?? 0), sfhCount];
    const target = sfhCount / 2;
    const bin = cumulative.findIndex((count) => count >= target);
    if (bin <= 0) {
      medianSfhLandRatio = 0;
    } else {
      const lower = cumulative[bin - 1];
      const fraction = cumulative[bin] > lower ? (target - lower) / (cumulative[bin] - lower) : 0;
      medianSfhLandRatio = (bin - 1 + fraction) / SFH_MEDIAN_BINS;
    }
  }
  return { sfhCount, meanSfhLandRatio: read("meanRatio"), medianSfhLandRatio };
}

function valueStatistics() {
  const { land, improvement, improvementCount, total } = state.fields;
  return [
    ...(!state.fields.totalFromComponents
      ? [{ statisticType: "avg", onStatisticField: total, outStatisticFieldName: "averageTotal" }]
      : []),
    { statisticType: "count", onStatisticField: total, outStatisticFieldName: "totalCount" },
    // Land and improvement totals let split-rate scenarios be recalculated locally.
    { statisticType: "avg", onStatisticField: land, outStatisticFieldName: "averageLand" },
    { statisticType: "count", onStatisticField: land, outStatisticFieldName: "landCount" },
    ...(!state.fields.improvementFromTotalMinusLand
      ? [
        { statisticType: "avg", onStatisticField: improvement, outStatisticFieldName: "averageImprovement" },
        { statisticType: "count", onStatisticField: improvementCount, outStatisticFieldName: "improvementCount" },
      ]
      : []),
  ];
}

// Statistic output names are case-insensitive on some servers.
function statAttribute(attributes, name) {
  if (name in attributes) return attributes[name];
  const lower = name.toLowerCase();
  const key = Object.keys(attributes).find((candidate) => candidate.toLowerCase() === lower);
  return key ? attributes[key] : undefined;
}

function groupSum(attributes, average, count) {
  const value = Number(statAttribute(attributes, average)) * Number(statAttribute(attributes, count));
  return Number.isFinite(value) ? value : 0;
}

async function loadCurrentTaxRevenue(geography, signal) {
  const features = await runStatistics(geography, valueStatistics(), { groupBy: state.jurisdictionGroupBy }, signal);
  let revenue = 0;
  let ratedCount = 0;
  const byCounty = new Map();
  const byJurisdiction = new Map();
  features.forEach(({ attributes = {} }) => {
    const details = taxJurisdictionDetails(attributes);
    const { county, rate, jurisdiction } = details;
    const count = Number(statAttribute(attributes, "totalCount"));
    const total = state.fields.totalFromComponents
      ? groupSum(attributes, "averageLand", "landCount") + groupSum(attributes, "averageImprovement", "improvementCount")
      : groupSum(attributes, "averageTotal", "totalCount");
    const landValue = groupSum(attributes, "averageLand", "landCount");
    const improvementValue = state.fields.improvementFromTotalMinusLand
      ? total - landValue
      : groupSum(attributes, "averageImprovement", "improvementCount");
    if (!Number.isFinite(rate) || !Number.isFinite(count) || !count) return;
    const countyRevenue = total * rate;
    revenue += countyRevenue;
    byCounty.set(county, (byCounty.get(county) || 0) + countyRevenue);
    const existing = byJurisdiction.get(jurisdiction) || {
      ...details, parcelCount: 0, totalValue: 0, landValue: 0, improvementValue: 0, currentTax: 0,
    };
    existing.parcelCount += count;
    existing.totalValue += total;
    existing.landValue += landValue;
    existing.improvementValue += improvementValue;
    existing.currentTax += countyRevenue;
    byJurisdiction.set(jurisdiction, existing);
    ratedCount += count;
  });
  return { revenue: ratedCount ? revenue : null, byCounty, byJurisdiction };
}

function taxBreakdownRow(tagName, className, label, amount) {
  const row = document.createElement(tagName);
  row.className = className;
  const name = document.createElement("span");
  name.textContent = label;
  const value = document.createElement("strong");
  value.textContent = formatCompactCurrency(amount);
  row.append(name, value);
  return row;
}

// Groups jurisdiction totals into counties. Each county lists its distinct-rate
// municipalities (largest current tax first) followed by its rest-of-county entry.
function groupJurisdictionsByCounty(byJurisdiction) {
  const counties = new Map();
  byJurisdiction.forEach((details) => {
    const county = counties.get(details.county) || {
      name: details.county, currentTax: 0, landValue: 0, improvementValue: 0, municipalities: [], rest: null,
    };
    county.currentTax += details.currentTax;
    county.landValue += details.landValue || 0;
    county.improvementValue += details.improvementValue || 0;
    if (details.municipality) county.municipalities.push(details);
    else county.rest = details;
    counties.set(details.county, county);
  });
  return [...counties.values()]
    .map((county) => {
      county.municipalities.sort((a, b) => b.currentTax - a.currentTax);
      county.jurisdictions = [...county.municipalities, county.rest].filter(Boolean);
      return county;
    })
    .sort((a, b) => b.currentTax - a.currentTax);
}

function resetTaxCountyResults(container) {
  container.replaceChildren(container.querySelector(".tax-model-breakdown-heading"));
}

function updateCurrentTaxCountyResults(byJurisdiction) {
  const container = elements.taxCurrentCountyResults;
  resetTaxCountyResults(container);
  if (!byJurisdiction?.size) {
    container.hidden = true;
    return;
  }
  const countyRowClass = "tax-model-county-row tax-model-county-row--county";
  const subRowClass = "tax-model-county-row tax-model-county-row--sub";
  groupJurisdictionsByCounty(byJurisdiction).forEach((county) => {
    if (!county.municipalities.length) {
      container.append(taxBreakdownRow("div", countyRowClass, county.name, county.currentTax));
      return;
    }
    const breakdown = document.createElement("ul");
    breakdown.className = "tax-county-breakdown";
    breakdown.setAttribute("aria-label", `${county.name} breakdown by tax rate`);
    county.jurisdictions.forEach((details) => breakdown.append(taxBreakdownRow(
      "li", subRowClass, `${details.municipality || REST_OF_COUNTY_LABEL} (${formatTaxRate(details.rate)})`, details.currentTax,
    )));
    const group = document.createElement("details");
    group.className = "tax-county-group";
    group.open = true;
    group.append(taxBreakdownRow("summary", countyRowClass, county.name, county.currentTax), breakdown);
    container.append(group);
  });
  container.hidden = false;
}

// All metrics come from server statistics requests on the analysis layer.
async function loadTaxMetrics(geography, signal, onPartial) {
  const summary = {
    landValue: null, totalValue: null, landValueRatio: null, currentTaxRevenue: null,
    sfhCount: null, meanSfhLandRatio: null, medianSfhLandRatio: null,
  };
  const sfhPromise = loadSfhBenchmarks(geography, signal)
    .then((benchmarks) => {
      Object.assign(summary, benchmarks);
      onPartial(summary);
    })
    .catch((error) => {
      if (error.name === "AbortError") throw error;
      console.warn("Could not calculate SFH benchmarks:", error);
    });

  const currentTax = await loadCurrentTaxRevenue(geography, signal);
  const jurisdictions = [...currentTax.byJurisdiction.values()];
  const sum = (field) => jurisdictions.reduce((total, details) => total + (details[field] || 0), 0);
  Object.assign(summary, {
    landValue: sum("landValue"),
    totalValue: sum("totalValue"),
    parcelCount: sum("parcelCount"),
    currentTaxRevenue: currentTax.revenue,
    currentTaxByCounty: currentTax.byCounty,
    currentTaxByJurisdiction: currentTax.byJurisdiction,
  });
  summary.landValueRatio = summary.totalValue > 0 ? (summary.landValue / summary.totalValue) * 100 : null;
  onPartial(summary);
  await sfhPromise;
  return summary;
}

// ---------- Parcel map layer ----------

function getMapExtent() {
  const bounds = map.getBounds();
  return { xmin: bounds.getWest(), ymin: bounds.getSouth(), xmax: bounds.getEast(), ymax: bounds.getNorth() };
}

function viewEnvelopeFilter() {
  const extent = getMapExtent();
  return {
    geometry: `${extent.xmin},${extent.ymin},${extent.xmax},${extent.ymax}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
  };
}

// Simplifies drawn shapes to a quarter pixel at the current zoom.
function shapeGeneralization() {
  if (!state.parcels.generalizeShapes) return {};
  const degreesPerPixel = 360 / (256 * 2 ** map.getZoom());
  return { maxAllowableOffset: String(degreesPerPixel / 4), geometryPrecision: "7" };
}

function serverParcelExportRequest(geography) {
  const bounds = map.getBounds();
  const southwest = webMercatorPoint([bounds.getWest(), bounds.getSouth()]);
  const northeast = webMercatorPoint([bounds.getEast(), bounds.getNorth()]);
  const size = map.getSize();
  // Scale uniformly: ArcGIS widens the bbox to match the image aspect ratio, which would misalign the overlay.
  const scale = Math.min(1, 2048 / Math.max(size.x, size.y));
  const layerId = state.parcels.exportLayerId ?? 0;
  const params = new URLSearchParams({
    bbox: `${southwest[0]},${southwest[1]},${northeast[0]},${northeast[1]}`,
    bboxSR: "3857",
    imageSR: "3857",
    size: `${Math.max(1, Math.round(size.x * scale))},${Math.max(1, Math.round(size.y * scale))}`,
    format: "png32",
    transparent: "true",
    dpi: "96",
    layers: `show:${layerId}`,
    layerDefs: JSON.stringify({ [layerId]: parcelWhere(geography, { exclusions: false }) }),
    f: "image",
  });
  if (isSpatialGeography(geography)) {
    const polygonFilter = { geometryType: "esriGeometryPolygon", geometry: esriPolygonFromGeometry(geography.geometry, 4326) };
    params.set("spatialFilter", JSON.stringify({ ...polygonFilter, spatialRel: "esriSpatialRelIntersects" }));
    params.set("clipping", JSON.stringify(polygonFilter));
  }
  return { url: `${state.parcels.exportMapUrl}/export`, options: { method: "POST", body: params } };
}

// Analysis features (points, or attributed polygons) inside the selected geography.
async function loadAnalysisFeatures(geography, spatialFilter, signal, extraParams = {}) {
  const parcels = state.parcels;
  if (parcels.relatedTable) {
    const config = parcels.relatedTable;
    if (config.loadRecords) {
      const [features, records] = await Promise.all([
        queryAllGeojson(parcels.analysisUrl, {
          where: combinedWhere([
            typeof config.geometryWhere === "function" ? config.geometryWhere(geography) : config.geometryWhere,
            geographyAttributeFilter(geography),
          ]),
          ...spatialFilter,
          outFields: config.geometryOutFields,
          returnGeometry: "true",
          outSR: "4326",
          ...extraParams,
        }, signal, parcels.pageSize || 1000, 20000, parcels.objectIdField),
        relatedRecordsForGeography(geography, signal),
      ]);
      const rowsByKey = new Map();
      records.forEach((record) => {
        const key = String(record[config.keyField] ?? "").trim();
        if (!key) return;
        if (!rowsByKey.has(key)) rowsByKey.set(key, []);
        rowsByKey.get(key).push(record);
      });
      const joined = [];
      features.filter((feature) => feature.geometry).forEach((feature) => {
        const center = geometryCenter(feature.geometry);
        if (!center || (isSpatialGeography(geography) && !geometryContains(geography.geometry, center))) return;
        const key = String(feature.properties?.[config.geometryKeyField] ?? "").trim();
        (rowsByKey.get(key) || []).forEach((record) => joined.push({
            type: "Feature",
            geometry: feature.geometry,
            properties: {
              ...feature.properties,
              ...record,
              [parcels.objectIdField]: feature.properties?.[parcels.objectIdField],
              __parcelCenter: center,
              __parcelGeometryKey: key,
            },
          }));
      });
      return joined;
    }
    const features = await queryAllGeojson(parcels.analysisUrl, {
      where: config.geometryWhere || "1=1",
      ...spatialFilter,
      outFields: config.geometryOutFields,
      returnGeometry: "true",
      outSR: "4326",
      ...extraParams,
    }, signal, parcels.pageSize || 1000, 20000, parcels.objectIdField);
    const geometryByKey = new Map();
    features.filter((feature) => feature.geometry).forEach((feature) => {
      const center = geometryCenter(feature.geometry);
      if (!center || (isSpatialGeography(geography) && !geometryContains(geography.geometry, center))) return;
      const key = String(feature.properties?.[config.geometryKeyField] ?? "").trim();
      if (key && !geometryByKey.has(key)) {
        geometryByKey.set(key, { geometry: feature.geometry, center, properties: feature.properties || {} });
      }
    });
    const records = await relatedRowsForKeys([...geometryByKey.keys()], geometryByKey, signal);
    return records.map((properties) => {
      const geometry = geometryByKey.get(properties.__parcelGeometryKey);
      return {
        type: "Feature",
        geometry: geometry.geometry,
        properties,
      };
    });
  }
  const sources = analysisSourcesForGeography(geography);
  const featureGroups = await mapWithConcurrency(sources, 6, async (source) => {
    const features = await queryAllGeojson(source.url, {
      where: parcelWhere(geography, { exclusions: false, source }),
      ...spatialFilter,
      outFields: sourceOutFields(source),
      returnGeometry: "true",
      outSR: "4326",
      ...extraParams,
    }, signal, source.pageSize || parcels.pointPageSize || parcels.pageSize || 1000, source.maxFeatures || 20000, sourceObjectIdField(source));
    return features.map((feature) => ({
      ...feature,
      properties: normalizeSourceProperties(source, feature.properties),
      __analysisSourceKey: source.key,
    }));
  });
  const features = featureGroups.flat();
  return features.filter((feature) => feature.geometry && featureInGeography(feature, geography));
}

async function loadShapes(spatialFilter, signal) {
  const parcels = state.parcels;
  const sources = parcels.shapeSources?.length
    ? parcels.shapeSources
    : [{ url: parcels.shapesUrl, where: parcels.shapeWhere || "1=1" }];
  const featureGroups = await mapWithConcurrency(sources, 6, (source) => queryAllGeojson(source.url, {
    where: source.where || parcels.shapeWhere || "1=1",
    ...spatialFilter,
    outFields: parcels.shapeOutFields || parcels.objectIdField,
    returnGeometry: "true",
    outSR: "4326",
    ...shapeGeneralization(),
  }, signal, parcels.pageSize || 1000, 20000, parcels.objectIdField));
  return featureGroups.flat();
}

function attachPointsToShapes(shapes, points) {
  const join = state.parcels.shapeJoin;
  if (join) {
    const shapesByKey = new Map();
    shapes.filter((shape) => shape.geometry).forEach((shape) => {
      const key = join.shapeKey(shape.properties || {});
      if (!shapesByKey.has(key)) shapesByKey.set(key, []);
      shapesByKey.get(key).push({ shape, accounts: [] });
    });
    const orphans = [];
    points.forEach((point) => {
      const owners = shapesByKey.get(join.pointKey(point.properties || {}));
      if (owners) owners.forEach((owner) => owner.accounts.push(point.properties || {}));
      else orphans.push(point);
    });
    const parcels = [...shapesByKey.values()].flat()
      .filter((candidate) => candidate.accounts.length)
      .map(({ shape, accounts }) => ({ type: "Feature", geometry: shape.geometry, properties: { accounts } }));
    return { parcels, orphans };
  }

  const candidates = shapes
    .filter((shape) => shape.geometry)
    .map((shape) => ({ shape, area: geometryArea(shape.geometry), contains: createPointInGeometryTester(shape.geometry), accounts: [] }))
    .sort((a, b) => a.area - b.area);
  const orphans = [];
  points.forEach((point) => {
    const owner = candidates.find((candidate) => candidate.contains(point.geometry.coordinates));
    if (owner) owner.accounts.push(point.properties || {});
    else orphans.push(point);
  });
  const parcels = candidates
    .filter((candidate) => candidate.accounts.length)
    .sort((a, b) => b.area - a.area)
    .map(({ shape, accounts }) => ({ type: "Feature", geometry: shape.geometry, properties: { accounts } }));
  return { parcels, orphans };
}

// Parcels in view, as shapes with their accounts plus any accounts without a shape.
async function loadViewParcels(geography, spatialFilter, signal) {
  if (state.parcels.shapesCarryAttributes) {
    const features = await loadAnalysisFeatures(geography, spatialFilter, signal, shapeGeneralization());
    if (state.parcels.relatedTable) {
      const groups = new Map();
      features.forEach((feature) => {
        const key = feature.properties.__parcelGeometryKey;
        if (!groups.has(key)) groups.set(key, { geometry: feature.geometry, accounts: [], center: feature.properties.__parcelCenter });
        groups.get(key).accounts.push(feature.properties || {});
      });
      return {
        parcels: [...groups.values()].map(({ geometry, accounts, center }) => ({
          type: "Feature",
          geometry,
          properties: { accounts, center },
        })),
        orphans: [],
      };
    }
    return {
      parcels: features.map((feature) => ({
        type: "Feature",
        geometry: feature.geometry,
        properties: { accounts: [feature.properties || {}], center: parcelCenter(feature) },
      })),
      orphans: [],
    };
  }
  const [shapes, points] = await Promise.all([
    loadShapes(spatialFilter, signal),
    loadAnalysisFeatures(geography, spatialFilter, signal),
  ]);
  return attachPointsToShapes(shapes, points);
}

async function loadAccountsAtPoint(latlng, geography, signal) {
  const clickFilter = {
    geometry: `${latlng.lng},${latlng.lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
  };
  if (state.parcels.shapesCarryAttributes) {
    const features = await loadAnalysisFeatures(geography, clickFilter, signal);
    if (state.parcels.relatedTable) return features.map((feature) => feature.properties || {});
    const smallest = features.sort((a, b) => geometryArea(a.geometry) - geometryArea(b.geometry))[0];
    return smallest ? [smallest.properties || {}] : [];
  }
  const shape = (await loadShapes(clickFilter, signal))
    .filter((feature) => feature.geometry)
    .sort((a, b) => geometryArea(a.geometry) - geometryArea(b.geometry))[0];
  if (shape) {
    const points = await loadAnalysisFeatures(geography, {
      geometry: JSON.stringify(esriPolygonFromGeometry(shape.geometry, 4326)),
      geometryType: "esriGeometryPolygon",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
    }, signal);
    if (points.length) return points.map((point) => point.properties || {});
  }
  const nearby = await loadAnalysisFeatures(geography, { ...clickFilter, distance: "8", units: "esriSRUnit_Meter" }, signal);
  return nearby.map((point) => point.properties || {});
}

function openAccountsPopup(latlng, accounts) {
  const popup = L.popup({ className: "parcel-tooltip", maxWidth: 300 }).setLatLng(latlng).setContent(stackedPopupMarkup(accounts));
  openParcelPopup = { popup, accounts };
  popup.once("remove", () => {
    if (openParcelPopup?.popup === popup) openParcelPopup = null;
  });
  popup.openOn(map);
}

function removeParcelLoadingMarker() {
  if (parcelLoadingMarker) {
    map.removeLayer(parcelLoadingMarker);
    parcelLoadingMarker = null;
  }
}

function showParcelLoadingMarker(latlng) {
  removeParcelLoadingMarker();
  parcelLoadingMarker = L.marker(latlng, {
    interactive: false,
    icon: L.divIcon({
      className: "parcel-loading-marker-container",
      html: '<span class="parcel-loading-marker" aria-hidden="true"></span>',
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    }),
    zIndexOffset: 1000,
  }).addTo(map);
}

function createParcelStyle() {
  return { color: PARCEL_COLOR, weight: 1, opacity: 0.8, fillColor: PARCEL_FILL_COLOR, fillOpacity: 0.25 };
}

function underutilizedStyle(style) {
  return { ...style, color: "#e56b2f", fillColor: "#f4a261", weight: 2.5, fillOpacity: 0.58 };
}

// Zoomed out: a server image (when the state has a map service) and click-to-query.
// Zoomed in: shapes in view drawn as vectors with their accounts attached.
function createParcelMapLayer(geography) {
  const layer = L.layerGroup();
  let refreshTimer = null;
  let refreshRequest = null;
  let parcelClickRequest = null;
  let pendingRefreshResolve = null;
  let imageOverlay = null;
  let vectorLayer = null;

  const removeImage = () => {
    if (imageOverlay) layer.removeLayer(imageOverlay);
    imageOverlay = null;
  };
  const removeVectors = () => {
    if (vectorLayer) layer.removeLayer(vectorLayer);
    vectorLayer = null;
  };

  const shapeStyle = (feature) => {
    const center = feature.properties.center || geometryCenter(feature.geometry);
    return feature.properties.accounts.some((account) => isUnderutilized(account, center))
      ? underutilizedStyle(createParcelStyle())
      : createParcelStyle();
  };
  const orphanStyle = (points) => {
    const base = { radius: 5, color: PARCEL_COLOR, weight: 1.5, fill: false };
    return points.some((point) => isUnderutilized(point.properties || {}, point.geometry.coordinates))
      ? { ...base, color: "#e56b2f", weight: 2.5 }
      : base;
  };

  layer.restyle = () => {
    if (!vectorLayer) return;
    vectorLayer.shapes.eachLayer((child) => child.setStyle(shapeStyle(child.feature)));
    vectorLayer.orphans.forEach((marker) => marker.setStyle(orphanStyle(marker.points)));
  };

  const showImage = async (signal) => {
    removeVectors();
    if (!state.parcels.exportMapUrl) {
      removeImage();
      updateMapStatus(`Zoom to ${VECTOR_MIN_ZOOM}+ to draw parcels, or click the map to inspect one`);
      return;
    }
    const bounds = map.getBounds();
    const exportRequest = serverParcelExportRequest(geography);
    const response = await fetch(exportRequest.url, { ...exportRequest.options, signal, headers: { Accept: "image/png" } });
    if (!response.ok) throw new Error(`Parcel map service returned ${response.status}.`);
    const imageUrl = URL.createObjectURL(await response.blob());
    if (signal.aborted || !map.hasLayer(layer)) {
      URL.revokeObjectURL(imageUrl);
      return;
    }
    removeImage();
    imageOverlay = L.imageOverlay(imageUrl, bounds, { opacity: 0.78, interactive: false }).addTo(layer);
    imageOverlay.once("remove", () => URL.revokeObjectURL(imageUrl));
  };

  const showVectors = async (signal) => {
    const { parcels, orphans } = await loadViewParcels(geography, viewEnvelopeFilter(), signal);
    if (signal.aborted || !map.hasLayer(layer)) return;
    const shapesLayer = L.geoJSON({ type: "FeatureCollection", features: parcels }, {
      style: shapeStyle,
      onEachFeature: (feature, child) => {
        child.on({
          click: (event) => openAccountsPopup(event.latlng, feature.properties.accounts),
          mouseover: () => child.setStyle({ weight: 2.5, fillOpacity: 0.48 }),
          mouseout: () => child.setStyle(shapeStyle(feature)),
        });
      },
    });
    // Accounts that share a location (e.g. condo units) without a containing shape share one marker.
    const orphansByLocation = new Map();
    orphans.forEach((point) => {
      const key = point.geometry.coordinates.join(",");
      if (!orphansByLocation.has(key)) orphansByLocation.set(key, []);
      orphansByLocation.get(key).push(point);
    });
    const orphanMarkers = [...orphansByLocation.values()].map((points) => {
      const [lng, lat] = points[0].geometry.coordinates;
      const marker = L.circleMarker([lat, lng], orphanStyle(points));
      marker.points = points;
      marker.on("click", (event) => openAccountsPopup(event.latlng, points.map((point) => point.properties || {})));
      return marker;
    });
    removeImage();
    removeVectors();
    vectorLayer = L.featureGroup([shapesLayer, ...orphanMarkers]).addTo(layer);
    vectorLayer.shapes = shapesLayer;
    vectorLayer.orphans = orphanMarkers;
    updateMapStatus(parcels.length || orphans.length
      ? "Parcel outlines shown; click a parcel to inspect its assessment"
      : "No matching parcels in the current map view");
  };

  const handleMapClick = async (event) => {
    if (map.getZoom() >= VECTOR_MIN_ZOOM) return;
    if (isSpatialGeography(geography) && !pointInGeometry([event.latlng.lng, event.latlng.lat], geography.geometry)) {
      removeParcelLoadingMarker();
      return;
    }
    if (parcelClickRequest) parcelClickRequest.abort();
    showParcelLoadingMarker(event.latlng);
    const request = new AbortController();
    parcelClickRequest = request;
    try {
      const accounts = await loadAccountsAtPoint(event.latlng, geography, request.signal);
      if (!accounts.length || parcelClickRequest !== request || !map.hasLayer(layer)) return;
      openAccountsPopup(event.latlng, accounts);
    } catch (error) {
      if (error.name !== "AbortError") console.warn("Could not load the selected parcel:", error);
    } finally {
      if (parcelClickRequest === request) {
        removeParcelLoadingMarker();
        parcelClickRequest = null;
      }
    }
  };

  layer.refresh = () => new Promise((resolve, reject) => {
    if (pendingRefreshResolve) pendingRefreshResolve();
    pendingRefreshResolve = resolve;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      if (refreshRequest) refreshRequest.abort();
      const request = new AbortController();
      refreshRequest = request;
      try {
        if (map.getZoom() >= VECTOR_MIN_ZOOM) await showVectors(request.signal);
        else await showImage(request.signal);
        resolve();
      } catch (error) {
        if (error.name === "AbortError") {
          resolve();
          return;
        }
        reject(error);
      } finally {
        if (pendingRefreshResolve === resolve) pendingRefreshResolve = null;
        if (refreshRequest === request) refreshRequest = null;
      }
    }, 100);
  });

  const refreshQuietly = () => {
    if (state.parcels.analysisSources?.length && isSpatialGeography(geography) && !geography.excludedIdsSetBySource) return;
    layer.refresh().catch((error) => console.warn("Could not render parcels:", error));
  };
  layer.on("add", () => {
    map.on("moveend", refreshQuietly);
    map.on("click", handleMapClick);
  });
  layer.on("remove", () => {
    if (pendingRefreshResolve) pendingRefreshResolve();
    pendingRefreshResolve = null;
    clearTimeout(refreshTimer);
    if (refreshRequest) refreshRequest.abort();
    if (parcelClickRequest) parcelClickRequest.abort();
    removeParcelLoadingMarker();
    map.off("moveend", refreshQuietly);
    map.off("click", handleMapClick);
    removeImage();
    removeVectors();
  });
  return layer;
}

// ---------- Popups ----------

function taxPopupDetails(properties) {
  const { land, improvement, total } = parcelValues(properties);
  const details = taxJurisdictionDetails(properties);
  const currentRate = details.rate;
  const currentTax = Number.isFinite(total) && Number.isFinite(currentRate) ? total * currentRate : null;
  const scenarioRates = taxScenarioModel ? scenarioRatesFor(details) : null;
  const hypotheticalTax = !taxScenarioModel
    ? currentTax
    : scenarioRates
      ? (Number.isFinite(land) ? land * scenarioRates.land : 0)
        + (Number.isFinite(improvement) ? improvement * scenarioRates.improvement : 0)
      : null;
  return { currentRate, currentTax, hypotheticalTax };
}

function popupMarkup(properties) {
  const taxDetails = taxPopupDetails(properties);
  const rows = [
    ...state.popup.rows(properties, { formatCurrency }),
    ["Applicable tax rate", formatTaxRate(taxDetails.currentRate)],
    ["Predicted tax bill", formatCurrency(taxDetails.currentTax)],
    ["Hypothetical split-rate bill", formatCurrency(taxDetails.hypotheticalTax)],
  ];
  return `
    <div class="parcel-popup">
      <h3>${escapeHtml(state.popup.title(properties))}</h3>
      <dl>
        ${rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value ?? "Not available")}</dd>`).join("")}
      </dl>
    </div>`;
}

function stackedPopupMarkup(accounts) {
  if (accounts.length === 1) return popupMarkup(accounts[0]);
  const compare = (a, b) => String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true });
  const sorted = [...accounts].sort((a, b) => {
    const [a1, a2] = state.popup.sortKey(a);
    const [b1, b2] = state.popup.sortKey(b);
    return compare(a1, b1) || compare(a2, b2);
  });
  return `
    <div class="parcel-popup-stack">
      <p class="parcel-popup-count">${sorted.length.toLocaleString()} taxable ${escapeHtml(state.report.accountNoun)} at this location</p>
      <div class="parcel-popup-list">${sorted.map(popupMarkup).join("")}</div>
    </div>`;
}

function refreshOpenParcelPopup() {
  if (!openParcelPopup) return;
  openParcelPopup.popup.setContent(stackedPopupMarkup(openParcelPopup.accounts));
  openParcelPopup.popup.update();
}

// ---------- Underutilized parcels ----------

function underutilizedFlags(properties, center, context) {
  const { land, improvement, total } = parcelValues(properties);
  const valid = Number.isFinite(land) && Number.isFinite(total);
  const ratio = valid && total > 0 ? land / total : null;
  const landMajority = valid && land > total / 2;
  const vacant = improvement === null || !Number.isFinite(improvement) ? valid && land === total : improvement === 0;
  const isSfh = state.sfh.matches(properties);
  return {
    vacant,
    landMajority,
    highValueUrban: () => landMajority && land >= 1000000 && Boolean(center)
      && context.urbanFeatures.some((urban) => urban.geometry && geometryContains(urban.geometry, center)),
    aboveMeanSfh: !isSfh && ratio !== null && context.meanSfhLandRatio !== null && ratio > context.meanSfhLandRatio,
    aboveMedianSfh: !isSfh && ratio !== null && context.medianSfhLandRatio !== null && ratio > context.medianSfhLandRatio,
  };
}

function isUnderutilized(properties, center) {
  const context = underutilizedContext;
  if (!context?.mode) return false;
  const flags = underutilizedFlags(properties, center, context);
  switch (context.mode) {
    case "vacant": return flags.vacant;
    case "land-majority": return flags.landMajority;
    case "high-value-urban": return flags.highValueUrban();
    case "above-mean-sfh": return flags.aboveMeanSfh;
    case "above-median-sfh": return flags.aboveMedianSfh;
    default: return false;
  }
}

function ensureUrbanFeatures(signal) {
  return state.urban.load(signal, selectedGeography);
}

async function updateUnderutilizedHighlights(updateId = underutilizedUpdateId) {
  const urbanFeatures = underutilizedMode === "high-value-urban" ? await ensureUrbanFeatures() : [];
  if (updateId !== underutilizedUpdateId) return;
  underutilizedContext = {
    mode: underutilizedMode,
    urbanFeatures,
    meanSfhLandRatio: latestTaxSummary?.meanSfhLandRatio ?? null,
    medianSfhLandRatio: latestTaxSummary?.medianSfhLandRatio ?? null,
  };
  parcelLayer?.restyle();
}

const UNDERUTILIZED_DEFINITIONS = () => ({
  vacant: "No assessed value for improvements, or improvements=$0.",
  "land-majority": "Land value is greater than improvements value.",
  "high-value-urban": `Land value is at least $1M and greater than improvements value. The parcel is also in an ${state.urban.definition}.`,
  "above-mean-sfh": `Non-single-family-home (SFH) parcels whose land-to-total assessment ratio is strictly greater than the mean ratio for SFH parcels in the selected geography. SFH = ${state.sfh.definition}.`,
  "above-median-sfh": "Non-SFH parcels whose land-to-total assessment ratio is strictly greater than the median ratio for SFH parcels in the selected geography. SFH is defined as above.",
});

function applyUnderutilizedDefinitions() {
  const definitions = UNDERUTILIZED_DEFINITIONS();
  elements.underutilizedControl.querySelectorAll("[data-definition-for]").forEach((element) => {
    element.textContent = definitions[element.dataset.definitionFor] || "";
  });
}

function updateUnderutilizedDescription() {
  const selectedOption = elements.underutilizedSelect.selectedOptions[0];
  const definition = [...elements.underutilizedControl.querySelectorAll("[data-definition-for]")]
    .find((candidate) => candidate.dataset.definitionFor === selectedOption?.value);
  const description = definition?.textContent.trim() || "";
  elements.underutilizedDescriptionText.textContent = description;
  elements.underutilizedDescription.hidden = !description;
  updateUnderutilizedZoomHint();
}

function updateUnderutilizedZoomHint() {
  const zoom = map.getZoom();
  const belowMinZoom = zoom < VECTOR_MIN_ZOOM;
  const highlightsHidden = belowMinZoom && Boolean(elements.underutilizedSelect.value);
  elements.underutilizedZoomHint.classList.toggle("is-warning", highlightsHidden);
  elements.underutilizedZoomHint.classList.toggle("is-ready", !belowMinZoom);
  elements.underutilizedZoomHintText.textContent = belowMinZoom
    ? `Highlights only appear at zoom ${VECTOR_MIN_ZOOM} or closer. Current zoom: ${zoom}.`
    : `Zoom ${zoom}: underutilized parcels are highlighted on the map.`;
  elements.underutilizedZoomButton.textContent = `Zoom to ${VECTOR_MIN_ZOOM}`;
  elements.underutilizedZoomButton.hidden = !belowMinZoom;
  zoomLevelIndicator.classList.toggle("is-below-highlight-zoom", highlightsHidden);
}

// ---------- Downloads ----------

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function rowsToCsv(headers, rows) {
  return [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n") + "\r\n";
}

function downloadTextFile(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function downloadBaseName(suffix) {
  const geography = formatGeographyName().replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
  return `parcelanalysis-${state.id.toLowerCase()}-${geography || "selected-area"}-${suffix}`;
}

function scenarioSnapshot() {
  const model = taxScenarioModel;
  if (!model) return null;
  const snapshot = { scope: model.scope, rates: structuredClone(model.rates) };
  const unitPairs = revenueNeutralUnits(model);
  const units = unitPairs.map(([key, unit]) => {
    const entry = snapshot.rates[snapshot.scope][key];
    const jurisdictions = unit.counties
      ? unit.counties.flatMap((county) => county.jurisdictions)
      : unit.jurisdictions || [unit];
    const restOfCounty = snapshot.scope === "jurisdiction" && !unit.municipality
      && unitPairs.some(([, other]) => other.municipality && other.county === unit.county);
    return {
      label: snapshot.scope === "all" ? "All counties" : `${key}${restOfCounty ? ` (${REST_OF_COUNTY_LABEL.toLowerCase()})` : ""}`,
      currentRates: [...new Set(jurisdictions.map((details) => details.rate))].sort((a, b) => a - b),
      land: parseRatePercent(entry?.land),
      improvement: parseRatePercent(entry?.improvement),
    };
  });
  return {
    model,
    scopeLabel: taxScenarioScopeLabel(snapshot.scope, model),
    units,
    missing: units.filter((unit) => !Number.isFinite(unit.land) || !Number.isFinite(unit.improvement)).map((unit) => unit.label),
    ratesFor: (details) => scenarioRatesFor(details, snapshot),
  };
}

function landShareStatistics() {
  const { land, improvement, improvementCount, total } = state.fields;
  const statistics = [
    ...(!state.fields.totalFromComponents
      ? [{ statisticType: "avg", onStatisticField: total, outStatisticFieldName: "avg_total" }]
      : []),
    { statisticType: "count", onStatisticField: total, outStatisticFieldName: "count_total" },
    { statisticType: "avg", onStatisticField: land, outStatisticFieldName: "avg_land" },
    { statisticType: "count", onStatisticField: land, outStatisticFieldName: "count_land" },
    ...(!state.fields.improvementFromTotalMinusLand
      ? [
        { statisticType: "avg", onStatisticField: improvement, outStatisticFieldName: "avg_improvement" },
        { statisticType: "count", onStatisticField: improvementCount, outStatisticFieldName: "count_improvement" },
      ]
      : []),
  ];
  for (let band = 0; band < LAND_SHARE_BANDS; band += 1) {
    const condition = band === 0 ? `${land} = 0` : `${land} <= ${total} * ${(band / LAND_SHARE_BANDS).toFixed(4)}`;
    statistics.push({
      statisticType: "sum",
      onStatisticField: `CASE WHEN ${land} IS NULL OR ${condition} THEN 1 ELSE 0 END`,
      outStatisticFieldName: `landShareAtMost${band}`,
    });
  }
  statistics.push({
    statisticType: "sum",
    onStatisticField: `CASE WHEN ${land} IS NULL OR ${land} < ${total} THEN 1 ELSE 0 END`,
    outStatisticFieldName: "landShareBelowOne",
  });
  return statistics;
}

function breakdownCell(propertyType, occupancyKey, attributes) {
  const count = Number(statAttribute(attributes, "count_total")) || 0;
  const share = (value) => (count ? (Number(value) || 0) / count : 0);
  const landValue = groupSum(attributes, "avg_land", "count_land");
  const improvementValue = state.fields.improvementFromTotalMinusLand
    ? groupSum(attributes, "avg_total", "count_total") - landValue
    : groupSum(attributes, "avg_improvement", "count_improvement");
  const totalValue = state.fields.totalFromComponents
    ? landValue + improvementValue
    : groupSum(attributes, "avg_total", "count_total");
  const occupancy = state.occupancy.field
    ? occupancyGroupFor({ [state.occupancy.field]: attributes[state.occupancy.field] }).key
    : occupancyKey;
  return {
    propertyType: propertyType.key,
    occupancy,
    details: taxJurisdictionDetails(attributes),
    count,
    totalValue,
    landValue,
    improvementValue,
    landShareAtMost: Array.from({ length: LAND_SHARE_BANDS }, (_, band) => share(statAttribute(attributes, `landShareAtMost${band}`))),
    landShareBelowOne: share(statAttribute(attributes, "landShareBelowOne")),
  };
}

// One cell per property type × tax jurisdiction × occupancy group.
async function loadTaxBreakdownCells(geography, signal) {
  const statistics = landShareStatistics();
  const { field, groups } = state.occupancy;
  const occupancyQueries = field
    ? [{
      key: null,
      where: null,
      groupBy: `${state.jurisdictionGroupBy},${field}`,
      matches: () => true,
    }]
    : groups.map((group) => ({
      key: group.key,
      where: group.where || null,
      groupBy: state.jurisdictionGroupBy,
      matches: group.matches || (() => true),
    }));
  const tasks = state.propertyTypes.flatMap((propertyType) => occupancyQueries.map((query) => ({ propertyType, query })));
  const message = "Calculating who pays more and who pays less…";
  let completed = 0;
  showParcelLoadProgress(message, completed, tasks.length);
  const groupsOfCells = await Promise.all(tasks.map(async ({ propertyType, query }) => {
    const where = query.where ? `(${propertyType.where}) AND (${query.where})` : propertyType.where;
    const features = await runStatistics(geography, statistics, {
      where,
      whereForSource: (source) => combinedWhere([
        propertyType.whereBySource?.[source.key] || mapSourceExpression(propertyType.where, source),
        mapSourceExpression(query.where, source),
      ]),
      groupBy: query.groupBy,
      matches: (properties) => propertyType.matches({ properties, improved: isImproved(properties) })
        && (!query.matches || query.matches(properties)),
    }, signal);
    completed += 1;
    showParcelLoadProgress(message, completed, tasks.length);
    return features.map(({ attributes = {} }) => breakdownCell(propertyType, query.key, attributes));
  }));
  return groupsOfCells.flat().filter((cell) => cell.count > 0);
}

// Within a tax jurisdiction, a bill's fractional change is base + slope × land share.
function cellScenario(cell, ratesFor) {
  const rates = ratesFor(cell.details);
  const currentRate = cell.details.rate;
  if (!rates || !Number.isFinite(currentRate) || currentRate <= 0) return null;
  return {
    currentTax: cell.totalValue * currentRate,
    hypotheticalTax: cell.landValue * rates.land + cell.improvementValue * rates.improvement,
    base: rates.improvement / currentRate - 1,
    slope: (rates.land - rates.improvement) / currentRate,
  };
}

// Share of a cell's accounts with land share ≤ x, interpolated linearly within each band.
function landShareAtMost(cell, x) {
  if (x < 0) return 0;
  if (x >= 1) return 1;
  const position = x * LAND_SHARE_BANDS;
  const band = Math.floor(position);
  const lower = cell.landShareAtMost[band];
  const upper = band + 1 < LAND_SHARE_BANDS ? cell.landShareAtMost[band + 1] : cell.landShareBelowOne;
  return lower + (upper - lower) * (position - band);
}

// Share with land share < x. Differs from landShareAtMost only at the 0% and 100% atoms.
function landShareBelow(cell, x) {
  if (x <= 0) return 0;
  if (x === 1) return cell.landShareBelowOne;
  return landShareAtMost(cell, x);
}

function changeShareAtMost(cell, change) {
  const { base, slope } = cell.scenario;
  if (Math.abs(slope) < 1e-9) return change >= base ? 1 : 0;
  const x = (change - base) / slope;
  return slope > 0 ? landShareAtMost(cell, x) : 1 - landShareBelow(cell, x);
}

function changeShareBelow(cell, change) {
  const { base, slope } = cell.scenario;
  if (Math.abs(slope) < 1e-9) return change > base ? 1 : 0;
  const x = (change - base) / slope;
  return slope > 0 ? landShareBelow(cell, x) : 1 - landShareAtMost(cell, x);
}

function medianChange(cells, count) {
  const shareAtMost = (change) => cells.reduce((total, cell) => total + cell.count * changeShareAtMost(cell, change), 0) / count;
  let low = Math.min(...cells.map(({ scenario }) => Math.min(scenario.base, scenario.base + scenario.slope)));
  let high = Math.max(...cells.map(({ scenario }) => Math.max(scenario.base, scenario.base + scenario.slope)));
  if (shareAtMost(low) >= 0.5) return low;
  for (let step = 0; step < 50; step += 1) {
    const middle = (low + high) / 2;
    if (shareAtMost(middle) >= 0.5) high = middle;
    else low = middle;
  }
  return high;
}

function summarizeCells(cells) {
  const priced = cells.filter((cell) => cell.scenario);
  const count = priced.reduce((total, cell) => total + cell.count, 0);
  if (!count) return null;
  const sum = (read) => priced.reduce((total, cell) => total + read(cell), 0);
  const currentTax = sum((cell) => cell.scenario.currentTax);
  const hypotheticalTax = sum((cell) => cell.scenario.hypotheticalTax);
  const payingLess = sum((cell) => cell.count * changeShareBelow(cell, -ABOUT_THE_SAME_THRESHOLD)) / count;
  const payingMore = sum((cell) => cell.count * (1 - changeShareAtMost(cell, ABOUT_THE_SAME_THRESHOLD))) / count;
  return {
    count,
    currentTax,
    hypotheticalTax,
    change: hypotheticalTax - currentTax,
    payingLess,
    payingMore,
    aboutTheSame: Math.max(0, 1 - payingLess - payingMore),
    medianChange: medianChange(priced, count),
    averageChange: (hypotheticalTax - currentTax) / count,
  };
}

function formatTextCurrency(value) {
  return Number.isFinite(value) ? formatCurrency(value) : NOT_AVAILABLE_TEXT;
}

function formatSignedCurrency(value) {
  return Number.isFinite(value)
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0, signDisplay: "exceptZero" }).format(Math.round(value))
    : NOT_AVAILABLE_TEXT;
}

function formatShare(fraction) {
  return Number.isFinite(fraction) ? formatPercent(fraction * 100) : NOT_AVAILABLE_TEXT;
}

function formatSignedShare(fraction) {
  return Number.isFinite(fraction)
    ? `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, signDisplay: "exceptZero" }).format(fraction * 100)}%`
    : NOT_AVAILABLE_TEXT;
}

function formatRatePercentText(rate) {
  return Number.isFinite(rate) ? `${formatRateInput(rate)}%` : "not entered";
}

function formatCountText(value) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : NOT_AVAILABLE_TEXT;
}

// Plain-text table: first column left-aligned, the rest right-aligned.
function textTable(headers, rows) {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => String(row[column]).length)));
  const line = (cells) => cells
    .map((cell, column) => (column === 0 ? String(cell).padEnd(widths[column]) : String(cell).padStart(widths[column])))
    .join("   ")
    .trimEnd();
  return [line(headers), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)];
}

function breakdownTables(groups, all) {
  const rows = [...groups.filter((group) => group.summary), { label: `All ${state.report.accountNoun}`, summary: all }];
  const totals = textTable(
    ["Group", "Parcels", "Current tax", "Hypothetical tax", "Change", "Change %", "Share now", "Share after"],
    rows.map(({ label, summary }) => [
      label,
      formatCountText(summary.count),
      formatTextCurrency(summary.currentTax),
      formatTextCurrency(summary.hypotheticalTax),
      formatSignedCurrency(summary.change),
      formatSignedShare(summary.currentTax ? summary.change / summary.currentTax : Number.NaN),
      formatShare(summary.currentTax / all.currentTax),
      formatShare(summary.hypotheticalTax / all.hypotheticalTax),
    ]),
  );
  const distribution = textTable(
    ["Group", "Pay less", "About the same", "Pay more", "Median change", "Avg change per parcel"],
    rows.map(({ label, summary }) => [
      label,
      formatShare(summary.payingLess),
      formatShare(summary.aboutTheSame),
      formatShare(summary.payingMore),
      formatSignedShare(summary.medianChange),
      formatSignedCurrency(summary.averageChange),
    ]),
  );
  return ["", ...totals, "", ...distribution];
}

function placeGroups(cells, model) {
  return model.counties.flatMap((county) => {
    const countyCells = cells.filter((cell) => cell.details.county === county.name);
    const countyGroup = { label: county.name, summary: summarizeCells(countyCells) };
    if (!county.municipalities.length) return [countyGroup];
    return [
      countyGroup,
      ...county.jurisdictions.map((details) => ({
        label: `  ${details.municipality || REST_OF_COUNTY_LABEL}`,
        summary: summarizeCells(countyCells.filter((cell) => cell.details.jurisdiction === details.jurisdiction)),
      })),
    ];
  });
}

async function summaryText(signal) {
  const summary = latestTaxSummary || {};
  const scenario = scenarioSnapshot();
  const scenarioComplete = Boolean(scenario && !scenario.missing.length);
  let cells = [];
  if (scenarioComplete) {
    cells = (await loadTaxBreakdownCells(selectedGeography, signal)).map((cell) => ({ ...cell, scenario: cellScenario(cell, scenario.ratesFor) }));
  }
  const all = summarizeCells(cells);
  const unpricedCount = cells.filter((cell) => !cell.scenario).reduce((total, cell) => total + cell.count, 0);
  const report = state.report;

  const lines = [];
  const heading = (title) => lines.push("", "", title.toUpperCase(), "=".repeat(title.length));
  const subheading = (title) => lines.push("", title, "-".repeat(title.length));
  const field = (label, value) => lines.push(`${`${label}:`.padEnd(36)}${value}`);

  lines.push(report.title, "");
  field("State", state.name);
  field("Geography", formatGeographyName());
  field("Geography type", summary.geographyTypeLabel || NOT_AVAILABLE_TEXT);
  field("Parcel data loaded", summary.loadedAt || NOT_AVAILABLE_TEXT);
  field("Report generated", new Date().toISOString());
  field("Tax modeled", state.tax.scopeLabel);
  lines.push("", "Read CAVEATS before citing these figures.");

  heading("Scenario settings");
  if (!scenario) {
    lines.push("No split-rate scenario is available for this selection.");
  } else {
    field("Rate settings", scenario.scopeLabel);
    lines.push("", ...textTable(
      ["Applies to", "Current rate", "Land rate", "Improvement rate", "Land : improvement"],
      scenario.units.map((unit) => [
        unit.label,
        unit.currentRates.length === 1
          ? formatRatePercentText(unit.currentRates[0])
          : `${formatRatePercentText(unit.currentRates[0])} to ${formatRatePercentText(unit.currentRates.at(-1))}`,
        formatRatePercentText(unit.land),
        formatRatePercentText(unit.improvement),
        !Number.isFinite(unit.land) || !Number.isFinite(unit.improvement) ? NOT_AVAILABLE_TEXT
          : unit.improvement > 0 ? `${Number((unit.land / unit.improvement).toFixed(2))} : 1`
            : unit.land > 0 ? "land only" : NOT_AVAILABLE_TEXT,
      ]),
    ));
    lines.push("", report.rateDefinition);
    if (scenario.missing.length) {
      lines.push("", `Hypothetical results are omitted because land and improvement rates have not been entered for: ${scenario.missing.join("; ")}.`);
    }
  }

  heading("Headline");
  if (all) {
    field("Current property tax", formatTextCurrency(all.currentTax));
    field("Hypothetical split-rate tax", formatTextCurrency(all.hypotheticalTax));
    field("Change", `${formatSignedCurrency(all.change)} (${formatSignedShare(all.change / all.currentTax)})`);
    field("Parcels paying less", `${formatShare(all.payingLess)} (about ${formatCountText(all.payingLess * all.count)})`);
    field("Parcels paying about the same", `${formatShare(all.aboutTheSame)} (about ${formatCountText(all.aboutTheSame * all.count)})`);
    field("Parcels paying more", `${formatShare(all.payingMore)} (about ${formatCountText(all.payingMore * all.count)})`);
    const ownerKey = state.occupancy.ownerOccupiedKey;
    const homes = ownerKey ? summarizeCells(cells.filter((cell) => cell.propertyType === "sfh" && cell.occupancy === ownerKey)) : null;
    if (homes) {
      lines.push("", `Owner-occupied single-family homes (${formatCountText(homes.count)}): median bill change ${formatSignedShare(homes.medianChange)}, average change ${formatSignedCurrency(homes.averageChange)} per home, ${formatShare(homes.payingLess)} pay less.`);
    }
    if (unpricedCount) {
      lines.push("", `${formatCountText(unpricedCount)} ${report.accountNoun} without a known tax rate are excluded from the hypothetical results.`);
    }
  } else {
    field("Current property tax", formatTextCurrency(summary.currentTaxRevenue));
    lines.push("", "Hypothetical results are not available for these scenario settings.");
  }

  heading("Key metrics");
  field(`Taxable ${report.accountNoun}`, formatCountText(summary.parcelCount));
  field("Total land value", formatTextCurrency(summary.landValue));
  field("Total assessed value", formatTextCurrency(summary.totalValue));
  field("Land share of assessed value", Number.isFinite(summary.landValueRatio) ? formatPercent(summary.landValueRatio) : NOT_AVAILABLE_TEXT);
  field("Qualifying single-family homes", formatCountText(summary.sfhCount));
  field("Mean SFH land share", formatShare(summary.meanSfhLandRatio));
  field("Median SFH land share", formatShare(summary.medianSfhLandRatio));

  if (all) {
    heading("Who pays more and who pays less");
    lines.push("Change = hypothetical split-rate bill minus current bill. Pay less / more and median change are estimates (see DEFINITIONS).");
    subheading("By property type");
    lines.push(...breakdownTables(state.propertyTypes.map((type) => ({
      label: type.label,
      summary: summarizeCells(cells.filter((cell) => cell.propertyType === type.key)),
    })), all));
    if (state.occupancy.groups.length > 1) {
      subheading("By owner occupancy");
      lines.push(...breakdownTables(state.occupancy.groups.map((group) => ({
        label: group.label,
        summary: summarizeCells(cells.filter((cell) => cell.occupancy === group.key)),
      })), all));
    }
    subheading("By place (tax jurisdiction)");
    lines.push(...breakdownTables(placeGroups(cells, scenario.model), all));
  }

  heading("Caveats");
  [
    ...report.caveats,
    "Pay less / about the same / pay more shares and median changes are estimated from parcel counts in 5-point land-share bands. Tax totals, changes, shares of tax, and averages are exact sums.",
  ].forEach((text) => lines.push(`- ${text}`));

  heading("Definitions");
  [
    "Current bill: assessed value x current rate.",
    "Hypothetical bill: land value x land rate + improvement value x improvement rate, using the rates for the parcel's tax jurisdiction.",
    "Change / Change %: hypothetical minus current tax, in dollars and as a percent of current tax.",
    "Share now / Share after: the group's share of all current / hypothetical tax in the selection.",
    `Pay less / Pay more: the bill falls / rises by more than ${formatPercent(ABOUT_THE_SAME_THRESHOLD * 100)}. About the same: within ${formatPercent(ABOUT_THE_SAME_THRESHOLD * 100)} either way.`,
    "Median change: the middle percent change in bills among the group's parcels.",
    "Avg change per parcel: total change divided by the number of parcels.",
    "Land share: land value / total assessed value. Within a tax jurisdiction, a bill's percent change depends only on its land share, so shares and medians are estimated from counts at each 5-point land-share step (0%, 5%, ..., 95%, 100%), interpolated within each step.",
    `Owner occupancy: ${state.occupancy.definition}`,
    `Qualifying single-family homes: ${report.sfhNotes}`,
    "Property types (each parcel counts in the first type it matches, in this order):",
  ].forEach((text) => lines.push(`- ${text}`));
  state.propertyTypes.forEach((type) => lines.push(`    ${type.label}: ${type.definition}`));

  heading("Source");
  report.sourceLines.forEach((line) => lines.push(line));
  lines.push(`Base filter: ${state.parcels.taxableWhere}`);
  return `${lines.join("\r\n")}\r\n`;
}

function metadataText() {
  const accessed = latestTaxSummary?.loadedAt || new Date().toISOString();
  const threshold = formatPercent(ABOUT_THE_SAME_THRESHOLD * 100);
  const report = state.report;
  return `Parcel Analysis (${state.name}) tax analysis export metadata

All exports cover taxable ${report.accountNoun} only: ${state.parcels.taxableWhere}
${report.unitDescription}
Tax modeled: ${state.tax.scopeLabel}.
${state.tax.rateNote ? `${state.tax.rateNote}\n` : ""}
SUMMARY STATISTICS (TXT)
Plain-text report with these sections:
- Header: state, geography, geography type, when parcel data was loaded, and when the report was generated.
- Scenario settings: the rate-setting mode and, for each editable row, current rate, land rate, improvement rate, and land : improvement ratio. Hypothetical sections are omitted when any rate is not entered.
- Headline: current and hypothetical tax, the change, and the share of parcels paying less, about the same, and more.
- Key metrics: taxable ${report.accountNoun}, land and assessed value totals, land share, and SFH benchmark values.
- Who pays more and who pays less: by property type, by owner occupancy (when reported), and by place. For each group:
  - Parcels, Current tax, Hypothetical tax, Change, Change % (of current tax).
  - Share now / Share after: the group's share of all current / hypothetical tax in the selection.
  - Pay less / Pay more: bill falls / rises by more than ${threshold}. About the same: within ${threshold}.
  - Median change: middle percent change in bills. Avg change per parcel: total change / parcels.
- Caveats, definitions, and source.

Property types (each parcel counts in the first type it matches, in this order):
${state.propertyTypes.map((type) => `- ${type.label}: ${type.definition}`).join("\n")}

Owner occupancy: ${state.occupancy.definition}

SFH benchmarks:
- ${report.sfhNotes}
- Mean / Median SFH land share: arithmetic mean / median of qualifying SFH land-to-total ratios.

DETAILED PARCEL CSV
Source columns:
${report.csvColumnNotes.map((note) => `- ${note}`).join("\n")}
Derived columns:
- PROPERTY_TYPE: report property type (see Property types above).
- OWNER_OCCUPANCY: report owner-occupancy group.
- COUNTY: county of the tax jurisdiction.
- TAX_MUNICIPALITY: municipality whose rate is applied; blank for the rest of the county.
${state.exportDistricts.map((district) => `- ${district.header}: ${district.description}`).join("\n")}
  District columns are blank when the parcel falls outside every boundary or a boundary service could not be loaded.
- APPLICABLE_TAX_RATE_PERCENT: current rate applied to the parcel.
- PREDICTED_TAX_BILL: total value x applicable rate.
- SPLIT_LAND_RATE_PERCENT / SPLIT_IMPROVEMENT_RATE_PERCENT: scenario rates for the parcel's tax jurisdiction at export time.
- HYPOTHETICAL_SPLIT_RATE_BILL: land value x split land rate + improvement value x split improvement rate.
- BILL_CHANGE: HYPOTHETICAL_SPLIT_RATE_BILL - PREDICTED_TAX_BILL.
- BILL_CHANGE_PERCENT: BILL_CHANGE as a percent of PREDICTED_TAX_BILL.
  Split-rate, hypothetical, and change columns are blank when a rate is not entered or not known.
- UNDERUTILIZED_VACANT: 1 when there is no assessed value for improvements, or improvements = $0.
- UNDERUTILIZED_LAND_MAJORITY: 1 when land value is greater than improvements value.
- UNDERUTILIZED_HIGH_VALUE_URBAN: 1 when land value is at least $1M and greater than improvements value, and the parcel is in an ${state.urban.definition}.
- UNDERUTILIZED_ABOVE_MEAN_SFH_LAND_RATIO: 1 when a non-SFH parcel's land-to-total ratio is greater than the mean for qualifying SFH parcels in the selection.
- UNDERUTILIZED_ABOVE_MEDIAN_SFH_LAND_RATIO: 1 when a non-SFH parcel's land-to-total ratio is greater than the median for qualifying SFH parcels in the selection.

Sources (accessed ${accessed}):
${report.sourceLines.join("\n")}
`;
}

async function loadParcelDistricts(counties, signal) {
  const results = await Promise.allSettled(state.exportDistricts.map(async (district) => {
    const features = district.perCounty
      ? await loadGeographyFeatures(district.type, signal, { counties })
      : await loadGeographyFeatures(district.type, signal);
    return features
      .filter((feature) => !feature.properties.COMBINED)
      .map((feature) => ({
        county: feature.properties.COUNTY,
        value: feature.properties.TAG ?? feature.properties.GEOGRAPHY_VALUE,
        contains: createPointInGeometryTester(feature.geometry),
      }));
  }));
  if (signal.aborted) throw new DOMException("The request was aborted.", "AbortError");
  return results.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    console.warn(`Could not load ${state.exportDistricts[index].header} boundaries for the parcel export:`, result.reason);
    return [];
  });
}

function findDistrict(districts, point) {
  return point ? districts.find((district) => district.contains(point))?.value ?? "" : "";
}

function roundCents(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : "";
}

async function loadTaxRecordsForDownload(signal) {
  if (!selectedGeography) throw new Error("No parcel selection is available to export.");
  setStatus("Loading parcel attributes for export…", "loading");
  const parcels = state.parcels;
  if (parcels.relatedTable) {
    const records = await relatedRecordsForGeography(selectedGeography, signal);
    return records.map((properties) => ({ properties, center: properties.__parcelCenter }));
  }
  const sources = analysisSourcesForGeography(selectedGeography);
  const sourceIdGroups = await mapWithConcurrency(sources, 6, async (source) => {
    const idPayload = await arcgisQuery(source.url, {
      ...analysisQueryParams(selectedGeography, null, source),
      returnIdsOnly: "true",
      f: "json",
    }, signal);
    return { source, parcelIds: idPayload.objectIds || [] };
  });
  const parcelCount = sourceIdGroups.reduce((sum, group) => sum + group.parcelIds.length, 0);
  // Polygon layers with centroid attributes skip geometry to keep the export lean.
  const needsGeometry = !parcels.center;
  const batchSize = parcels.downloadBatchSize || 500;
  let loaded = 0;
  const recordGroups = await mapWithConcurrency(sourceIdGroups, 4, async ({ source, parcelIds }) => {
    const records = [];
    const sourceBatchSize = source.downloadBatchSize || batchSize;
    for (let start = 0; start < parcelIds.length; start += sourceBatchSize) {
      const payload = await arcgisQuery(source.url, {
        where: sourceScopedWhere(selectedGeography, source),
        objectIds: parcelIds.slice(start, start + sourceBatchSize).join(","),
        outFields: sourceOutFields(source),
        returnGeometry: String(needsGeometry),
        outSR: "4326",
        f: needsGeometry ? "geojson" : "json",
      }, signal);
      const features = needsGeometry
        ? (payload.features || []).map((feature) => ({ properties: normalizeSourceProperties(source, feature.properties), center: geometryCenter(feature.geometry) }))
        : (payload.features || []).map((feature) => {
          const properties = normalizeSourceProperties(source, feature.attributes);
          return { properties, center: parcels.center?.(properties) || null };
        });
      records.push(...features);
      loaded += features.length;
      showParcelLoadProgress("Preparing parcel export…", loaded, parcelCount);
    }
    return records;
  });
  return recordGroups.flat();
}

async function detailedParcelCsv(signal) {
  const scenario = scenarioSnapshot();
  const records = await loadTaxRecordsForDownload(signal);
  setStatus("Matching parcels to districts and urban areas…", "loading");
  const counties = new Set(records.map(({ properties }) => taxJurisdictionDetails(properties).county));
  const [urbanFeatures, districts] = await Promise.all([ensureUrbanFeatures(signal), loadParcelDistricts(counties, signal)]);
  const context = {
    urbanFeatures,
    meanSfhLandRatio: latestTaxSummary?.meanSfhLandRatio ?? null,
    medianSfhLandRatio: latestTaxSummary?.medianSfhLandRatio ?? null,
  };
  const headers = [
    ...state.csv.headers,
    "PROPERTY_TYPE", "OWNER_OCCUPANCY", "COUNTY", "TAX_MUNICIPALITY",
    ...state.exportDistricts.map((district) => district.header),
    "APPLICABLE_TAX_RATE_PERCENT", "PREDICTED_TAX_BILL", "SPLIT_LAND_RATE_PERCENT", "SPLIT_IMPROVEMENT_RATE_PERCENT",
    "HYPOTHETICAL_SPLIT_RATE_BILL", "BILL_CHANGE", "BILL_CHANGE_PERCENT",
    "UNDERUTILIZED_VACANT", "UNDERUTILIZED_LAND_MAJORITY", "UNDERUTILIZED_HIGH_VALUE_URBAN",
    "UNDERUTILIZED_ABOVE_MEAN_SFH_LAND_RATIO", "UNDERUTILIZED_ABOVE_MEDIAN_SFH_LAND_RATIO",
  ];
  const rows = records.map(({ center, properties }) => {
    const { land, improvement: rawImprovement, total } = parcelValues(properties);
    const improvement = rawImprovement === null || !Number.isFinite(rawImprovement) ? 0 : rawImprovement;
    const flags = underutilizedFlags(properties, center, context);
    const details = taxJurisdictionDetails(properties);
    const actualRate = details.rate;
    const predictedTax = Number.isFinite(total) && Number.isFinite(actualRate) ? total * actualRate : null;
    const rates = scenario && Number.isFinite(actualRate) ? scenario.ratesFor(details) : null;
    const hypotheticalTax = rates ? (Number.isFinite(land) ? land * rates.land : 0) + improvement * rates.improvement : null;
    const change = predictedTax !== null && hypotheticalTax !== null ? hypotheticalTax - predictedTax : null;
    return [
      ...state.csv.row(properties),
      propertyTypeFor(properties).label,
      occupancyGroupFor(properties).label,
      details.county,
      details.municipality ?? "",
      ...state.exportDistricts.map((district, index) => findDistrict(
        district.perCounty ? districts[index].filter((candidate) => candidate.county === details.county) : districts[index],
        center,
      )),
      Number.isFinite(actualRate) ? formatRateInput(actualRate) : "",
      roundCents(predictedTax),
      rates ? formatRateInput(rates.land) : "",
      rates ? formatRateInput(rates.improvement) : "",
      roundCents(hypotheticalTax),
      roundCents(change),
      change !== null && predictedTax > 0 ? Number(((change / predictedTax) * 100).toFixed(2)) : "",
      flags.vacant ? 1 : 0,
      flags.landMajority ? 1 : 0,
      flags.highValueUrban() ? 1 : 0,
      flags.aboveMeanSfh ? 1 : 0,
      flags.aboveMedianSfh ? 1 : 0,
    ];
  });
  return rowsToCsv(headers, rows);
}

function setDownloadButtonsDisabled(disabled) {
  [elements.downloadSummary, elements.downloadParcels, elements.downloadMetadata].forEach((button) => {
    button.disabled = disabled;
  });
}

async function runDownload(task, successMessage) {
  if (downloadRequest) return;
  const controller = new AbortController();
  downloadRequest = controller;
  setDownloadButtonsDisabled(true);
  try {
    await task(controller.signal);
    setStatus(successMessage, "success");
  } catch (error) {
    if (error.name !== "AbortError") {
      console.error(error);
      setStatus(`Could not create the download. ${error.message}`, "error");
    }
  } finally {
    if (downloadRequest === controller) {
      downloadRequest = null;
      setDownloadButtonsDisabled(false);
      hideParcelLoadProgress();
    }
  }
}

// ---------- Split-rate scenario ----------
// All inputs are recalculated locally from the per-jurisdiction land and improvement totals.
// Rates are stored per scope as the percent text shown in each input:
//   all          — one rate set for every parcel
//   county       — one rate set per county, applied to its municipalities too
//   jurisdiction — one rate set per county remainder and per distinct-rate municipality

function isValidRateText(text) {
  const value = String(text ?? "").trim();
  const decimalPlaces = value.includes(".") ? value.split(".")[1].length : 0;
  return /^(?:\d+\.?\d*|\.\d+)$/.test(value) && decimalPlaces <= 6;
}

function validateTaxRateInput(input) {
  const isValid = isValidRateText(input.value);
  input.setCustomValidity(isValid ? "" : "Enter a non-negative rate with no more than 6 decimal places.");
  return isValid;
}

function formatRateInput(rate) {
  return String(Number((rate * 100).toFixed(6)));
}

function parseRatePercent(text) {
  return isValidRateText(text) ? Number(text) / 100 : Number.NaN;
}

function defaultScenarioRate(jurisdictions) {
  return new Set(jurisdictions.map((details) => details.rate)).size === 1 ? formatRateInput(jurisdictions[0].rate) : "";
}

function scenarioRateEntry(rate) {
  return { land: rate, improvement: rate };
}

function defaultTaxScenarioRates(model) {
  const jurisdictions = model.counties.flatMap((county) => county.jurisdictions);
  return {
    all: { all: scenarioRateEntry(defaultScenarioRate(jurisdictions)) },
    county: Object.fromEntries(model.counties.map((county) => [county.name, scenarioRateEntry(defaultScenarioRate(county.jurisdictions))])),
    jurisdiction: Object.fromEntries(jurisdictions.map((details) => [details.jurisdiction, scenarioRateEntry(formatRateInput(details.rate))])),
  };
}

function buildTaxScenarioModel(byJurisdiction) {
  if (!byJurisdiction?.size) return null;
  const counties = groupJurisdictionsByCounty(byJurisdiction);
  const sum = (field) => counties.reduce((total, county) => total + county[field], 0);
  const scopes = [
    ...(counties.some((county) => county.municipalities.length) ? ["jurisdiction"] : []),
    "county",
    ...(counties.length > 1 ? ["all"] : []),
  ];
  const model = {
    counties,
    currentTax: sum("currentTax"),
    landValue: sum("landValue"),
    improvementValue: sum("improvementValue"),
    scopes,
    scope: scopes[0],
    rows: [],
  };
  model.rates = defaultTaxScenarioRates(model);
  return model;
}

function taxScenarioScopeLabel(scope, model) {
  if (scope === "all") return "One rate set for all counties";
  if (scope === "jurisdiction") return "By county and municipality";
  const label = model.counties.length > 1 ? "By county" : `One rate set for ${model.counties[0].name}`;
  return model.counties.some((county) => county.municipalities.length) ? `${label} (municipalities included)` : label;
}

function scenarioRateKey(details, scope = taxScenarioModel.scope) {
  if (scope === "all") return "all";
  return scope === "county" ? details.county : details.jurisdiction;
}

function scenarioRatesFor(details, { scope, rates } = taxScenarioModel) {
  const entry = rates[scope][scenarioRateKey(details, scope)];
  const land = parseRatePercent(entry?.land);
  const improvement = parseRatePercent(entry?.improvement);
  return Number.isFinite(land) && Number.isFinite(improvement) ? { land, improvement } : null;
}

function computeTaxScenario() {
  const byCounty = new Map();
  const byJurisdiction = new Map();
  let total = 0;
  taxScenarioModel.counties.forEach((county) => {
    let countyTotal = 0;
    county.jurisdictions.forEach((details) => {
      const rates = scenarioRatesFor(details);
      const tax = rates ? details.landValue * rates.land + details.improvementValue * rates.improvement : Number.NaN;
      byJurisdiction.set(details.jurisdiction, tax);
      countyTotal += tax;
    });
    byCounty.set(county.name, countyTotal);
    total += countyTotal;
  });
  return { total, byCounty, byJurisdiction };
}

function formatTaxChange(value, current) {
  if (!Number.isFinite(value)) return "Enter rates";
  const change = value - current;
  // Ignore differences from rounding default rates to 6 decimal places.
  if (Math.abs(change) <= Math.max(1, Math.abs(current) * 1e-6)) return "No change";
  const sign = change > 0 ? "+" : "−";
  const percent = current ? ` (${sign}${formatPercent(Math.abs(change / current) * 100)})` : "";
  return `${sign}${formatCompactCurrency(Math.abs(change))}${percent}`;
}

function setScenarioValue(amountElement, changeElement, value, current) {
  amountElement.textContent = Number.isFinite(value) ? formatCompactCurrency(value) : "—";
  changeElement.textContent = formatTaxChange(value, current);
}

function updateTaxScenarioResults() {
  if (!taxScenarioModel) return;
  const results = computeTaxScenario();
  setScenarioValue(elements.hypotheticalTaxValue, elements.hypotheticalTaxDelta, results.total, taxScenarioModel.currentTax);
  taxScenarioModel.rows.forEach((row) => setScenarioValue(row.amount, row.change, row.read(results), row.current));
  refreshOpenParcelPopup();
}

function scheduleTaxScenarioUpdate() {
  if (taxScenarioFrame) return;
  taxScenarioFrame = requestAnimationFrame(() => {
    taxScenarioFrame = 0;
    updateTaxScenarioResults();
  });
}

function scenarioRateInputs(label, rateKey) {
  const rates = taxScenarioModel.rates[taxScenarioModel.scope][rateKey];
  const wrapper = document.createElement("div");
  wrapper.className = "tax-scenario-inputs";
  [["land", "Land %"], ["improvement", "Impr. %"]].forEach(([field, caption]) => {
    const fieldLabel = document.createElement("label");
    const text = document.createElement("span");
    text.textContent = caption;
    const input = document.createElement("input");
    Object.assign(input, { type: "number", min: "0", step: "0.000001", inputMode: "decimal", value: rates[field] });
    input.setAttribute("aria-label", `${caption} — ${label}`);
    input.dataset.rateKey = rateKey;
    input.dataset.rateField = field;
    fieldLabel.append(text, input);
    wrapper.append(fieldLabel);
  });
  return wrapper;
}

function scenarioRow({ tagName = "div", modifier, label, inputLabel = label, current, read, rateKey = null, toggleTarget = null }) {
  const row = document.createElement(tagName);
  row.className = `tax-model-county-row tax-scenario-row ${modifier}`;
  let name;
  if (toggleTarget) {
    name = document.createElement("button");
    name.type = "button";
    name.className = "tax-county-toggle";
    name.setAttribute("aria-expanded", "true");
    name.setAttribute("aria-controls", toggleTarget);
  } else {
    name = document.createElement("span");
  }
  name.textContent = label;
  const value = document.createElement("span");
  value.className = "tax-scenario-value";
  const amount = document.createElement("strong");
  const change = document.createElement("small");
  change.className = "tax-scenario-delta";
  value.append(amount, change);
  row.append(name, value);
  if (rateKey) row.append(scenarioRateInputs(inputLabel, rateKey));
  taxScenarioModel.rows.push({ amount, change, current, read });
  return row;
}

function renderTaxScenario() {
  const model = taxScenarioModel;
  const { scope } = model;
  const container = elements.taxModelCountyResults;
  resetTaxCountyResults(container);
  model.rows = [];

  elements.taxModelResult.querySelector(".tax-scenario-inputs")?.remove();
  if (scope === "all") elements.taxModelResult.append(scenarioRateInputs("All counties", "all"));

  model.counties.forEach((county, index) => {
    const hasBreakdown = county.municipalities.length > 0;
    const countyEditable = scope === "county" || (scope === "jurisdiction" && !hasBreakdown);
    const breakdownId = `tax-scenario-breakdown-${index}`;
    const countyGroup = document.createElement("section");
    countyGroup.className = "tax-scenario-county";
    countyGroup.append(scenarioRow({
      modifier: "tax-model-county-row--county",
      label: county.name,
      current: county.currentTax,
      read: (results) => results.byCounty.get(county.name),
      rateKey: countyEditable ? scenarioRateKey(county.rest || { county: county.name }) : null,
      toggleTarget: hasBreakdown ? breakdownId : null,
    }));
    if (!hasBreakdown) {
      container.append(countyGroup);
      return;
    }
    const breakdown = document.createElement("ul");
    breakdown.id = breakdownId;
    breakdown.className = "tax-county-breakdown";
    breakdown.setAttribute("aria-label", `${county.name} breakdown by tax rate`);
    county.jurisdictions.forEach((details) => {
      const label = details.municipality || REST_OF_COUNTY_LABEL;
      breakdown.append(scenarioRow({
        tagName: "li",
        modifier: "tax-model-county-row--sub",
        label,
        inputLabel: `${county.name}, ${label}`,
        current: details.currentTax,
        read: (results) => results.byJurisdiction.get(details.jurisdiction),
        rateKey: scope === "jurisdiction" ? details.jurisdiction : null,
      }));
    });
    countyGroup.append(breakdown);
    container.append(countyGroup);
  });
  container.hidden = false;
  updateTaxScenarioResults();
}

function revenueNeutralUnits(model) {
  if (model.scope === "all") return [["all", model]];
  if (model.scope === "county") return model.counties.map((county) => [county.name, county]);
  return model.counties.flatMap((county) => county.jurisdictions.map((details) => [details.jurisdiction, details]));
}

function neutralMode() {
  return document.querySelector('input[name="neutral-mode"]:checked')?.value ?? "ratio";
}

function updateNeutralModeControls() {
  const landOnly = neutralMode() === "land-only";
  elements.neutralRatioGroup.hidden = landOnly;
  elements.neutralLandOnlyNote.hidden = !landOnly;
  elements.neutralRatio.setCustomValidity("");
  elements.neutralHint.textContent = landOnly
    ? "Taxes land only. Sets each editable row's land rate so its revenue matches current tax."
    : "Land : improvement rate ratio. Sets each editable row's rates so its revenue matches current tax.";
}

// Land-only: land rate = current tax ÷ land value, improvements untaxed.
function applyRevenueNeutralLandOnly(model) {
  revenueNeutralUnits(model).forEach(([key, unit]) => {
    if (unit.landValue <= 0) return;
    model.rates[model.scope][key] = { land: formatRateInput(unit.currentTax / unit.landValue), improvement: "0" };
  });
  renderTaxScenario();
  setStatus("Applied revenue-neutral land-only rates (improvements untaxed).", "success");
}

// For land:improvement ratio k, solves improvement rate r so that
// r × (k × land + improvements) equals each editable row's current tax.
function applyRevenueNeutralRatio() {
  const model = taxScenarioModel;
  if (!model) return;
  if (neutralMode() === "land-only") {
    applyRevenueNeutralLandOnly(model);
    return;
  }
  const input = elements.neutralRatio;
  const ratio = Number(input.value);
  if (input.value.trim() === "" || !Number.isFinite(ratio) || ratio < 0) {
    input.setCustomValidity("Enter a non-negative ratio.");
    input.reportValidity();
    return;
  }
  input.setCustomValidity("");
  revenueNeutralUnits(model).forEach(([key, unit]) => {
    const base = ratio * unit.landValue + unit.improvementValue;
    if (base <= 0) return;
    const improvementRate = unit.currentTax / base;
    model.rates[model.scope][key] = { land: formatRateInput(improvementRate * ratio), improvement: formatRateInput(improvementRate) };
  });
  renderTaxScenario();
  setStatus(`Applied revenue-neutral rates with land taxed at ${ratio}× the improvement rate.`, "success");
}

function resetTaxScenario() {
  if (!taxScenarioModel) return;
  taxScenarioModel.rates = defaultTaxScenarioRates(taxScenarioModel);
  renderTaxScenario();
  setStatus("Scenario reset to current rates.", "success");
}

function prepareTaxModelControls() {
  taxScenarioModel = buildTaxScenarioModel(latestTaxSummary?.currentTaxByJurisdiction);
  elements.taxModelControls.hidden = !taxScenarioModel;
  if (taxScenarioModel) {
    elements.taxScopeSelect.replaceChildren(
      ...taxScenarioModel.scopes.map((scope) => new Option(taxScenarioScopeLabel(scope, taxScenarioModel), scope)),
    );
    elements.taxScopeSelect.value = taxScenarioModel.scope;
    elements.taxScopeControl.hidden = taxScenarioModel.scopes.length < 2;
    renderTaxScenario();
  }
  elements.underutilizedControl.hidden = false;
}

// ---------- Loading flow ----------

function resetResultsUi() {
  if (openParcelPopup) {
    openParcelPopup.popup.remove();
    openParcelPopup = null;
  }
  removeParcelLoadingMarker();
  underutilizedUpdateId += 1;
  underutilizedContext = null;
  latestTaxSummary = null;
  taxScenarioModel = null;
  hideParcelLoadProgress();
  elements.underutilizedSelect.disabled = false;
  underutilizedMode = "";
  elements.underutilizedSelect.value = "";
  updateUnderutilizedDescription();
  elements.underutilizedControl.hidden = true;
  elements.taxModelControls.hidden = true;
  elements.hypotheticalTaxValue.textContent = "—";
  elements.hypotheticalTaxDelta.textContent = "";
  resetTaxCountyResults(elements.taxModelCountyResults);
  elements.taxModelCountyResults.hidden = true;
  resetTaxCountyResults(elements.taxCurrentCountyResults);
  elements.taxCurrentCountyResults.hidden = true;
  elements.taxDownloadControls.hidden = true;
  setDownloadButtonsDisabled(false);
  elements.parcelCount.textContent = "—";
  updateAnalysisMetrics();
  elements.refreshParcels.disabled = true;
}

function clearParcelResults() {
  if (currentRequest) {
    currentRequest.abort();
    currentRequest = null;
  }
  if (downloadRequest) {
    downloadRequest.abort();
    downloadRequest = null;
  }
  if (parcelLayer) {
    map.removeLayer(parcelLayer);
    parcelLayer = null;
  }
  resetResultsUi();
}

async function loadParcels() {
  if (!selectedGeography) return;
  const geographyAtRequestStart = selectedGeography;
  const stateAtRequestStart = state;
  if (currentRequest) currentRequest.abort();
  if (downloadRequest) {
    downloadRequest.abort();
    downloadRequest = null;
  }
  const request = new AbortController();
  currentRequest = request;
  resetResultsUi();
  const geographyName = formatGeographyName(geographyAtRequestStart);
  setStatus(`Calculating tax metrics for ${geographyName}…`, "loading");
  updateMapStatus("Loading parcels…");

  try {
    if (state.prepare) {
      showParcelLoadProgress("Loading tax rates…", 0, null, true);
      await state.prepare(request.signal);
    }
    await verifyAttributeFilter(geographyAtRequestStart, request.signal);
    if (parcelLayer) map.removeLayer(parcelLayer);
    parcelLayer = createParcelMapLayer(geographyAtRequestStart).addTo(map);

    showParcelLoadProgress("Matching parcels to the boundary…", 0, null, true);
    await ensureGeographyMembership(geographyAtRequestStart, request.signal);
    const renderPromise = parcelLayer.refresh().catch((error) => console.warn("Could not render parcels:", error));
    showParcelLoadProgress("Calculating tax metrics…", 0, null, true);
    const taxSummary = await loadTaxMetrics(geographyAtRequestStart, request.signal, (partial) => {
      if (currentRequest === request) updateAnalysisMetrics(partial);
    });
    if (currentRequest !== request || selectedGeography !== geographyAtRequestStart || state !== stateAtRequestStart) return;

    taxSummary.loadedAt = new Date().toISOString();
    taxSummary.geographyTypeLabel = state.geographies[geographyAtRequestStart.properties.GEOGRAPHY_TYPE]?.label ?? null;
    latestTaxSummary = taxSummary;
    elements.parcelCount.textContent = taxSummary.parcelCount.toLocaleString();
    updateCurrentTaxCountyResults(taxSummary.currentTaxByJurisdiction);
    updateAnalysisMetrics(taxSummary);
    prepareTaxModelControls();
    elements.taxDownloadControls.hidden = false;
    hideParcelLoadProgress();
    updateMapStatus(`${taxSummary.parcelCount.toLocaleString()} taxable ${state.report.accountNoun} in ${geographyName}`);
    setStatus(`${TAX_CONFIG.title} is ready.`, "success");
    await renderPromise;
  } catch (error) {
    if (error.name === "AbortError") return;
    hideParcelLoadProgress();
    console.error(error);
    elements.parcelCount.textContent = "—";
    updateMapStatus("Parcel request failed");
    setStatus(`Could not load parcels. ${error.message}`, "error");
  } finally {
    if (currentRequest === request && selectedGeography === geographyAtRequestStart) elements.refreshParcels.disabled = false;
    if (currentRequest === request) currentRequest = null;
  }
}

// ---------- State selection ----------

function applyStateBranding() {
  document.title = `Parcel Analysis | ${state.name}`;
  elements.brandMark.innerHTML = `PA<br>${escapeHtml(state.id)}`;
  elements.appEyebrow.textContent = state.brand.eyebrow;
  elements.dataNoteText.textContent = state.brand.dataNote;
  // Adapter-authored static markup (links to data sources), not user input.
  elements.acknowledgementsList.innerHTML = `${state.brand.acknowledgementsHtml}
    <li><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a> — basemap</li>`;
  elements.toolKicker.textContent = TAX_CONFIG.kicker;
  elements.toolTitle.textContent = TAX_CONFIG.title;
  elements.toolDescription.textContent = state.tax.description;
  elements.toolRateNote.textContent = state.tax.rateNote || "";
  elements.toolRateNote.hidden = !state.tax.rateNote;
  elements.parcelCountLabel.textContent = `${state.report.accountNoun[0].toUpperCase()}${state.report.accountNoun.slice(1)} loaded (n)`;
  elements.taxCurrentHeading.textContent = `Current ${state.tax.shortLabel}`;
  elements.taxModelHeading.textContent = `Hypothetical ${state.tax.shortLabel}`;
  applyUnderutilizedDefinitions();
  updateUnderutilizedDescription();
}

function populateGeographyTypes() {
  elements.geographyTypeSelect.replaceChildren(
    ...state.geographyOrder.map((type) => new Option(state.geographies[type].label, type)),
  );
  elements.geographyTypeSelect.value = state.defaultGeography;
}

function resetGeographySelection() {
  selectedGeography = null;
  geographyFeatures = [];
  showSelectedGeography();
  clearParcelResults();
  elements.geographySelection.textContent = `All ${state.name}`;
  elements.selectedGeography.textContent = `All ${state.name}`;
  elements.geographyMenu.classList.toggle("selection-menu--county-districts", Boolean(geographyConfig()?.wideMenu));
  setStatus("Choose a geography to load tax analysis results.");
  updateMapStatus("Choose a geography to load parcels");
}

function selectState(id) {
  const nextState = window.ParcelStates.get(id);
  state = temporarilyDisabledStates.has(nextState.id) ? window.ParcelStates.get(window.ParcelStates.defaultId) : nextState;
  elements.stateSelect.value = state.id;
  const url = new URL(window.location.href);
  url.searchParams.set("state", state.id);
  window.history.replaceState(null, "", url);
  applyStateBranding();
  populateGeographyTypes();
  resetGeographySelection();
  loadGeographyChoices(elements.geographyTypeSelect.value);
}

// ---------- Welcome panel resizing ----------

const welcomePanel = document.querySelector(".welcome-panel");
const welcomePanelResizeHandle = document.querySelector(".welcome-panel-resize-handle");
const acknowledgementsElement = document.querySelector(".acknowledgements");
const stackedLayoutQuery = window.matchMedia("(max-width: 600px)");
const WELCOME_PANEL_MIN_HEIGHT = 220;
const WELCOME_PANEL_GAP = 12;

function getWelcomePanelResizeLimits() {
  const panelTop = welcomePanel.getBoundingClientRect().top;
  const acknowledgementsTop = acknowledgementsElement.getBoundingClientRect().top;
  // In the small layout the tool panel sits below this one, so it becomes the lower boundary.
  if (stackedLayoutQuery.matches && !elements.toolPanel.hidden) {
    const maximum = elements.toolPanel.getBoundingClientRect().top - panelTop - WELCOME_PANEL_GAP;
    return { minimum: Math.min(WELCOME_PANEL_MIN_HEIGHT, maximum), maximum };
  }
  // Keep the panel's bottom edge from rising above where the opened acknowledgements popover sits.
  const openPopoverTop = acknowledgementsTop - 9 - elements.acknowledgementsPopover.offsetHeight;
  const minimum = Math.max(WELCOME_PANEL_MIN_HEIGHT, openPopoverTop - panelTop - WELCOME_PANEL_GAP);
  const maximum = acknowledgementsTop - panelTop - WELCOME_PANEL_GAP;
  return { minimum: Math.min(minimum, maximum), maximum };
}

function updateWelcomePanelResizeAria(height = welcomePanel.getBoundingClientRect().height) {
  const { minimum, maximum } = getWelcomePanelResizeLimits();
  const boundedHeight = Math.max(minimum, Math.min(height, maximum));
  welcomePanelResizeHandle.setAttribute("aria-valuemin", String(Math.round(minimum)));
  welcomePanelResizeHandle.setAttribute("aria-valuemax", String(Math.round(maximum)));
  welcomePanelResizeHandle.setAttribute("aria-valuenow", String(Math.round(boundedHeight)));
}

function applyWelcomePanelBounds() {
  const { minimum, maximum } = getWelcomePanelResizeLimits();
  welcomePanel.style.minHeight = `${minimum}px`;
  welcomePanel.style.maxHeight = `${maximum}px`;
  updateWelcomePanelResizeAria();
}

function setWelcomePanelHeight(height) {
  const { minimum, maximum } = getWelcomePanelResizeLimits();
  const boundedHeight = Math.max(minimum, Math.min(height, maximum));
  welcomePanel.style.height = `${boundedHeight}px`;
  updateWelcomePanelResizeAria(boundedHeight);
}

applyWelcomePanelBounds();
new ResizeObserver(applyWelcomePanelBounds).observe(elements.toolPanel);

welcomePanelResizeHandle.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  const startY = event.clientY;
  const startHeight = welcomePanel.getBoundingClientRect().height;
  welcomePanelResizeHandle.setPointerCapture(event.pointerId);
  const resize = (pointerEvent) => setWelcomePanelHeight(startHeight + pointerEvent.clientY - startY);
  const stopResize = () => {
    welcomePanelResizeHandle.removeEventListener("pointermove", resize);
    welcomePanelResizeHandle.removeEventListener("pointerup", stopResize);
    welcomePanelResizeHandle.removeEventListener("pointercancel", stopResize);
  };
  welcomePanelResizeHandle.addEventListener("pointermove", resize);
  welcomePanelResizeHandle.addEventListener("pointerup", stopResize);
  welcomePanelResizeHandle.addEventListener("pointercancel", stopResize);
});

welcomePanelResizeHandle.addEventListener("keydown", (event) => {
  const currentHeight = welcomePanel.getBoundingClientRect().height;
  const step = event.shiftKey ? 40 : 16;
  if (event.key === "ArrowUp") setWelcomePanelHeight(currentHeight + step);
  else if (event.key === "ArrowDown") setWelcomePanelHeight(currentHeight - step);
  else return;
  event.preventDefault();
});

window.addEventListener("resize", applyWelcomePanelBounds);

// ---------- Event wiring ----------

function setAcknowledgementsOpen(isOpen) {
  elements.acknowledgements.classList.toggle("is-open", isOpen);
  elements.acknowledgementsTrigger.setAttribute("aria-expanded", String(isOpen));
  elements.acknowledgementsPopover.setAttribute("aria-hidden", String(!isOpen));
  elements.acknowledgementsPopover.toggleAttribute("inert", !isOpen);
  elements.acknowledgementsTrigger.setAttribute("aria-label", isOpen ? "Hide data sources" : "Show data sources");
}

elements.acknowledgementsTrigger.addEventListener("click", () => {
  setAcknowledgementsOpen(!elements.acknowledgements.classList.contains("is-open"));
});

document.addEventListener("click", (event) => {
  if (!elements.acknowledgements.contains(event.target)) setAcknowledgementsOpen(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && elements.acknowledgements.classList.contains("is-open")) {
    setAcknowledgementsOpen(false);
    elements.acknowledgementsTrigger.focus();
  }
});

elements.stateSelect.addEventListener("change", () => selectState(elements.stateSelect.value));

elements.geographyToggle.addEventListener("click", () => {
  const isOpen = !elements.geographyMenu.hidden;
  elements.geographyMenu.hidden = isOpen;
  elements.geographyToggle.setAttribute("aria-expanded", String(!isOpen));
});

elements.geographyTypeSelect.addEventListener("change", () => {
  resetGeographySelection();
  loadGeographyChoices(elements.geographyTypeSelect.value);
});

elements.geographyChoiceSelect.addEventListener("change", () => {
  selectedGeography = geographyFeatures.find(
    (feature) => String(feature.properties.GEOGRAPHY_VALUE) === elements.geographyChoiceSelect.value,
  ) || null;
  elements.geographySelection.textContent = formatGeographyName();
  elements.selectedGeography.textContent = formatGeographyName();
  elements.geographyMenu.hidden = true;
  elements.geographyToggle.setAttribute("aria-expanded", "false");
  showSelectedGeography();
  elements.parcelCount.textContent = "—";
  updateAnalysisMetrics();
  if (selectedGeography) {
    loadParcels();
  } else {
    clearParcelResults();
    setStatus("Choose a geography to load tax analysis results.");
    updateMapStatus("Choose a geography to load parcels");
  }
});

map.on("zoomend", updateUnderutilizedZoomHint);
elements.underutilizedZoomButton.addEventListener("click", () => map.setZoom(VECTOR_MIN_ZOOM));

elements.underutilizedSelect.addEventListener("change", () => {
  updateUnderutilizedDescription();
  underutilizedMode = elements.underutilizedSelect.value;
  const updateId = ++underutilizedUpdateId;
  if (!underutilizedMode || !parcelLayer) {
    underutilizedContext = null;
    parcelLayer?.restyle();
    setStatus("Underutilized parcel highlights cleared.", "success");
    return;
  }
  updateUnderutilizedHighlights(updateId)
    .then(() => {
      if (updateId === underutilizedUpdateId) {
        setStatus(
          map.getZoom() >= VECTOR_MIN_ZOOM
            ? "Underutilized parcel highlights applied."
            : `Underutilized view selected. Zoom to level ${VECTOR_MIN_ZOOM} or closer to see highlighted parcels.`,
          "success",
        );
      }
    })
    .catch((error) => {
      if (updateId !== underutilizedUpdateId) return;
      console.warn("Could not apply underutilized parcel highlight:", error);
      setStatus("Could not load the urban-area boundary.", "error");
    });
});

elements.refreshParcels.addEventListener("click", loadParcels);
elements.taxModelControls.addEventListener("submit", (event) => event.preventDefault());
elements.taxModelControls.addEventListener("input", (event) => {
  const input = event.target;
  const { rateKey, rateField } = input.dataset || {};
  if (!rateKey || !taxScenarioModel) return;
  validateTaxRateInput(input);
  taxScenarioModel.rates[taxScenarioModel.scope][rateKey][rateField] = input.value;
  scheduleTaxScenarioUpdate();
});
elements.taxModelControls.addEventListener("click", (event) => {
  const toggle = event.target.closest(".tax-county-toggle");
  if (!toggle) return;
  const isExpanded = toggle.getAttribute("aria-expanded") === "true";
  toggle.setAttribute("aria-expanded", String(!isExpanded));
  document.getElementById(toggle.getAttribute("aria-controls")).hidden = isExpanded;
});
elements.taxScopeSelect.addEventListener("change", () => {
  if (!taxScenarioModel) return;
  taxScenarioModel.scope = elements.taxScopeSelect.value;
  renderTaxScenario();
});
elements.applyNeutralRatio.addEventListener("click", applyRevenueNeutralRatio);
elements.neutralModeInputs.forEach((input) => input.addEventListener("change", updateNeutralModeControls));
elements.neutralRatio.addEventListener("input", () => elements.neutralRatio.setCustomValidity(""));
elements.resetTaxModel.addEventListener("click", resetTaxScenario);
elements.downloadSummary.addEventListener("click", () => {
  runDownload(
    async (signal) => downloadTextFile(downloadBaseName("summary.txt"), await summaryText(signal), "text/plain;charset=utf-8"),
    "Summary statistics downloaded.",
  );
});
elements.downloadParcels.addEventListener("click", () => {
  runDownload(
    async (signal) => downloadTextFile(downloadBaseName("parcels.csv"), await detailedParcelCsv(signal), "text/csv;charset=utf-8"),
    "Detailed parcel data downloaded.",
  );
});
elements.downloadMetadata.addEventListener("click", () => {
  runDownload(
    async () => downloadTextFile(downloadBaseName("metadata.txt"), metadataText(), "text/plain;charset=utf-8"),
    "Export metadata downloaded.",
  );
});

// ---------- Start ----------

elements.stateSelect.replaceChildren(
  ...window.ParcelStates.order
    .filter((id) => !temporarilyDisabledStates.has(id))
    .map((id) => new Option(window.ParcelStates.adapters[id].name, id)),
);
elements.toolPanel.hidden = false;
selectState(state.id);

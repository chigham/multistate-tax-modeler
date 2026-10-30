"use strict";

// Shared helpers used by the core app and every state adapter.
// Loaded before the state files, so adapters can rely on these globals.

const sqlList = (values) => values.map((value) => sqlString(value)).join(", ");

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function titleCase(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/(^|[ \-(])([a-z])/g, (_, separator, letter) => `${separator}${letter.toUpperCase()}`);
}

// ---------- Geometry ----------

function polygonsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

function ringCenter(ring) {
  let areaTwice = 0;
  let centerX = 0;
  let centerY = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[index + 1];
    const cross = x1 * y2 - x2 * y1;
    areaTwice += cross;
    centerX += (x1 + x2) * cross;
    centerY += (y1 + y2) * cross;
  }
  if (!areaTwice) {
    const points = ring.slice(0, -1);
    const total = points.reduce((center, [x, y]) => [center[0] + x, center[1] + y], [0, 0]);
    return [total[0] / points.length, total[1] / points.length];
  }
  return [centerX / (3 * areaTwice), centerY / (3 * areaTwice)];
}

function geometryCenter(geometry) {
  if (!geometry) return null;
  if (geometry.type === "Point") return geometry.coordinates;
  const polygons = polygonsOf(geometry);
  if (!polygons.length) return null;
  if (polygons.length === 1) return ringCenter(polygons[0][0]);
  const centers = polygons.map((polygon) => ringCenter(polygon[0]));
  const total = centers.reduce((center, [x, y]) => [center[0] + x, center[1] + y], [0, 0]);
  return [total[0] / centers.length, total[1] / centers.length];
}

function pointInRing(point, ring) {
  const [x, y] = point;
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [currentX, currentY] = ring[index];
    const [previousX, previousY] = ring[previous];
    const intersects =
      currentY > y !== previousY > y &&
      x < ((previousX - currentX) * (y - currentY)) / (previousY - currentY) + currentX;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInGeometry(point, geometry) {
  return polygonsOf(geometry).some(
    (polygon) => pointInRing(point, polygon[0]) && polygon.slice(1).every((hole) => !pointInRing(point, hole)),
  );
}

function createPointInGeometryTester(geometry) {
  const polygons = polygonsOf(geometry).map((polygon) => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of polygon[0]) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return { polygon, minX, minY, maxX, maxY };
  });
  return ([x, y]) => polygons.some(({ polygon, minX, minY, maxX, maxY }) =>
    x >= minX && x <= maxX && y >= minY && y <= maxY
    && pointInRing([x, y], polygon[0])
    && polygon.slice(1).every((hole) => !pointInRing([x, y], hole)));
}

// Cached tester per geometry object, so repeated checks against the same boundary stay cheap.
const geometryTesterCache = new WeakMap();
function geometryContains(geometry, point) {
  if (!geometry || !point) return false;
  let tester = geometryTesterCache.get(geometry);
  if (!tester) {
    tester = createPointInGeometryTester(geometry);
    geometryTesterCache.set(geometry, tester);
  }
  return tester(point);
}

function geometryArea(geometry) {
  return polygonsOf(geometry).reduce((total, polygon) => {
    const ring = polygon[0];
    let area = 0;
    for (let index = 0; index < ring.length - 1; index += 1) {
      area += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
    }
    return total + Math.abs(area) / 2;
  }, 0);
}

function geometryBounds(geometry) {
  let xmin = Infinity;
  let ymin = Infinity;
  let xmax = -Infinity;
  let ymax = -Infinity;
  polygonsOf(geometry).forEach((polygon) => polygon[0].forEach(([x, y]) => {
    if (x < xmin) xmin = x;
    if (x > xmax) xmax = x;
    if (y < ymin) ymin = y;
    if (y > ymax) ymax = y;
  }));
  return { xmin, ymin, xmax, ymax };
}

function webMercatorPoint([longitude, latitude]) {
  const earthRadius = 20037508.34;
  const x = (longitude * earthRadius) / 180;
  const clampedLatitude = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  const y =
    (Math.log(Math.tan(((90 + clampedLatitude) * Math.PI) / 360)) / (Math.PI / 180)) *
    (earthRadius / 180);
  return [x, y];
}

function esriPolygonFromGeometry(geometry, wkid = 4326) {
  const rings = polygonsOf(geometry).flatMap((polygon) => polygon);
  return {
    rings: wkid === 3857 ? rings.map((ring) => ring.map(webMercatorPoint)) : rings,
    spatialReference: { wkid },
  };
}

// ---------- ArcGIS REST ----------

async function fetchJson(url, options = {}, signal) {
  let requestSignal = signal;
  let removeAbortListener = () => {};
  if (signal) {
    const controller = new AbortController();
    const relayAbort = () => controller.abort(signal.reason);
    if (signal.aborted) relayAbort();
    else {
      signal.addEventListener("abort", relayAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", relayAbort);
    }
    requestSignal = controller.signal;
  }
  try {
    const response = await fetch(url, {
      ...options,
      signal: requestSignal,
      headers: { Accept: "application/geo+json, application/json", ...(options.headers || {}) },
    });
    const payload = await response.json();
    if (!response.ok || payload.error) {
      throw new Error(payload.error?.message || `Service returned ${response.status}.`);
    }
    return payload;
  } finally {
    removeAbortListener();
  }
}

async function arcgisQuery(layerUrl, params, signal) {
  return fetchJson(`${layerUrl}/query`, { method: "POST", body: new URLSearchParams(params) }, signal);
}

async function mapWithConcurrency(items, concurrency, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await callback(items[index], index);
    }
  }));
  return results;
}

function arcgisStatisticValue(attributes, name) {
  if (name in attributes) return attributes[name];
  const lower = name.toLowerCase();
  const key = Object.keys(attributes).find((candidate) => candidate.toLowerCase() === lower);
  return key ? attributes[key] : undefined;
}

// Fan one grouped-statistics query out to county layers, then combine additive stats
// and weighted averages. Percentiles must be represented by additive bins instead.
async function arcgisStatisticsAcrossSources(sources, paramsForSource, statistics, groupBy, signal, statisticsForSource = null) {
  if (!sources.length) return [];
  const baseParams = typeof paramsForSource === "function" ? paramsForSource : () => paramsForSource;
  const fields = groupBy ? groupBy.split(",").map((field) => field.trim()) : [];
  const kinds = statistics.map((statistic) => String(statistic.statisticType).toLowerCase());
  const unsupported = kinds.find((kind) => !["avg", "count", "sum", "min", "max"].includes(kind));
  if (unsupported) throw new Error(`Multi-source statistics do not support ${unsupported}; use additive statistics or bins.`);

  const countAliases = new Map();
  const hiddenCountAliases = new Set();
  statistics.forEach((statistic, index) => {
    if (kinds[index] !== "avg" || sources.length <= 1) return;
    const matchingCount = statistics.find((candidate, candidateIndex) => kinds[candidateIndex] === "count"
      && (candidate.outStatisticFieldName === statistic.countStatisticField
        || (!statistic.countStatisticField && candidate.onStatisticField === statistic.onStatisticField)));
    if (matchingCount) {
      countAliases.set(index, matchingCount.outStatisticFieldName);
    } else {
      const alias = `__multi_count_${index}`;
      countAliases.set(index, alias);
      hiddenCountAliases.add(index);
    }
  });

  const responses = await mapWithConcurrency(sources, 6, async (source, index) => {
    const sourceStatistics = statisticsForSource ? statisticsForSource(source, index) : statistics;
    if (sourceStatistics.length !== statistics.length) {
      throw new Error("Multi-source statistics must use the same number of output metrics for every source.");
    }
    const sourceKinds = sourceStatistics.map((statistic) => String(statistic.statisticType).toLowerCase());
    if (sourceKinds.some((kind, metricIndex) => kind !== kinds[metricIndex])) {
      throw new Error("Multi-source statistics must preserve metric types across sources.");
    }
    const sourceQueryStatistics = [];
    sourceStatistics.forEach((statistic, metricIndex) => {
      const { countStatisticField, ...serverStatistic } = statistic;
      sourceQueryStatistics.push(serverStatistic);
      if (kinds[metricIndex] === "avg" && hiddenCountAliases.has(metricIndex)) {
        sourceQueryStatistics.push({
          statisticType: "count",
          onStatisticField: statistic.onStatisticField,
          outStatisticFieldName: countAliases.get(metricIndex),
        });
      }
    });
    const params = {
      ...baseParams(source, index),
      outStatistics: JSON.stringify(sources.length > 1 ? sourceQueryStatistics : sourceStatistics.map(({ countStatisticField, ...statistic }) => statistic)),
      ...(groupBy ? { outFields: groupBy, groupByFieldsForStatistics: groupBy } : {}),
      f: "json",
    };
    const response = await arcgisQuery(source.url, params, signal);
    return { source, response };
  });
  if (sources.length === 1) {
    const { source, response } = responses[0];
    return (response.features || []).map((feature) => {
      const attributes = { ...(feature.attributes || {}) };
      statistics.forEach((statistic, index) => {
        if (kinds[index] !== "avg") return;
        const scale = Number(source.statisticScales?.[statistic.outStatisticFieldName] ?? 1);
        const value = Number(arcgisStatisticValue(attributes, statistic.outStatisticFieldName));
        if (Number.isFinite(value) && Number.isFinite(scale)) attributes[statistic.outStatisticFieldName] = value * scale;
      });
      return { ...feature, attributes };
    });
  }

  const groups = new Map();
  responses.flatMap(({ source, response }) => (response.features || []).map((feature) => ({ source, feature }))).forEach(({ source, feature }) => {
    const { attributes = {} } = feature;
    const key = JSON.stringify(fields.map((field) => arcgisStatisticValue(attributes, field) ?? null));
    let aggregate = groups.get(key);
    if (!aggregate) {
      aggregate = { attributes: {}, averages: new Map() };
      fields.forEach((field) => { aggregate.attributes[field] = arcgisStatisticValue(attributes, field) ?? null; });
      groups.set(key, aggregate);
    }
    statistics.forEach((statistic, index) => {
      const name = statistic.outStatisticFieldName;
      const kind = kinds[index];
      const value = Number(arcgisStatisticValue(attributes, name));
      if (kind === "avg") {
        const count = Number(arcgisStatisticValue(attributes, countAliases.get(index)));
        const scale = Number(source.statisticScales?.[name] ?? 1);
        const current = aggregate.averages.get(index) || { sum: 0, count: 0 };
        if (Number.isFinite(value) && Number.isFinite(count) && count > 0 && Number.isFinite(scale)) {
          current.sum += value * count * scale;
          current.count += count;
        }
        aggregate.averages.set(index, current);
      } else if (kind === "min" || kind === "max") {
        if (Number.isFinite(value)) {
          const current = aggregate.attributes[name];
          aggregate.attributes[name] = current === undefined ? value : kind === "min" ? Math.min(current, value) : Math.max(current, value);
        }
      } else {
        aggregate.attributes[name] = (Number(aggregate.attributes[name]) || 0) + (Number.isFinite(value) ? value : 0);
      }
    });
  });

  return [...groups.values()].map(({ attributes, averages }) => {
    statistics.forEach((statistic, index) => {
      if (kinds[index] !== "avg") return;
      const result = averages.get(index);
      attributes[statistic.outStatisticFieldName] = result?.count ? result.sum / result.count : null;
    });
    return { attributes };
  });
}

// Pages through a query and returns GeoJSON features.
async function queryAllGeojson(layerUrl, params, signal, pageSize = 1000, maxFeatures = 20000, orderBy = "OBJECTID") {
  const features = [];
  for (let offset = 0; offset < maxFeatures; offset += pageSize) {
    const payload = await arcgisQuery(layerUrl, {
      ...params,
      ...(orderBy ? { orderByFields: orderBy } : {}),
      resultOffset: String(offset),
      resultRecordCount: String(pageSize),
      f: "geojson",
    }, signal);
    if (payload.type !== "FeatureCollection") throw new Error("The service did not return GeoJSON.");
    const page = payload.features || [];
    features.push(...page);
    const more = payload.exceededTransferLimit || payload.properties?.exceededTransferLimit;
    if (!more || !page.length) break;
  }
  return features;
}

// Pages through an Esri JSON query (attributes, statistics) and returns the features.
async function queryAllJson(layerUrl, params, signal, pageSize = 2000, maxFeatures = 200000) {
  const features = [];
  for (let offset = 0; offset < maxFeatures; offset += pageSize) {
    const payload = await arcgisQuery(layerUrl, {
      ...params,
      resultOffset: String(offset),
      resultRecordCount: String(pageSize),
      f: "json",
    }, signal);
    const page = payload.features || [];
    features.push(...page);
    if (!payload.exceededTransferLimit || !page.length) break;
  }
  return features;
}

// Loads a boundary layer and returns normalized features:
// { geometry: MultiPolygon, properties: { GEOGRAPHY_VALUE, GEOGRAPHY_LABEL, COUNTY?, TAG?, raw } }.
// Config: serviceUrl, outFields, where, value(props), label(props), county?(props), tag?(props),
//   maxAllowableOffset, paginate (default true), pageSize, compare?(a, b), expand?(value, props) → extra values.
async function loadArcgisGeography(config, signal) {
  const params = {
    where: config.where || "1=1",
    outFields: config.outFields || "*",
    returnGeometry: "true",
    outSR: "4326",
    ...(config.maxAllowableOffset ? { maxAllowableOffset: String(config.maxAllowableOffset), geometryPrecision: "6" } : {}),
  };
  let features;
  if (config.paginate === false) {
    const payload = await arcgisQuery(config.serviceUrl, { ...params, f: "geojson" }, signal);
    if (payload.type !== "FeatureCollection") throw new Error("The geography service did not return GeoJSON.");
    features = payload.features || [];
  } else {
    features = await queryAllGeojson(config.serviceUrl, params, signal, config.pageSize || 1000, 50000, config.orderBy || null);
  }
  return normalizeGeographyFeatures(features, config);
}

function normalizeGeographyFeatures(features, config) {
  const byValue = new Map();
  const add = (value, feature, extra = {}) => {
    const polygons = polygonsOf(feature.geometry);
    if (!polygons.length) return;
    const existing = byValue.get(value);
    if (existing) {
      existing.geometry.coordinates.push(...polygons);
      return;
    }
    const properties = feature.properties || {};
    byValue.set(value, {
      type: "Feature",
      geometry: { type: "MultiPolygon", coordinates: [...polygons] },
      properties: {
        GEOGRAPHY_VALUE: value,
        GEOGRAPHY_LABEL: config.label ? config.label(properties, value) : value,
        COUNTY: config.county ? config.county(properties) : null,
        TAG: config.tag ? config.tag(properties) : value,
        raw: properties,
        ...extra,
      },
    });
  };
  features.forEach((feature) => {
    if (!feature.geometry) return;
    const rawValue = config.value(feature.properties || {});
    const value = String(rawValue ?? "").trim();
    if (!value) return;
    add(value, feature);
    (config.expand?.(value, feature.properties || {}) || []).forEach((extraValue) => {
      if (extraValue && extraValue !== value) {
        add(extraValue, feature, {
          COMBINED: true,
          GEOGRAPHY_LABEL: config.label ? config.label(feature.properties || {}, extraValue) : extraValue,
        });
      }
    });
  });
  const compare = config.compare
    || ((a, b) => a.properties.GEOGRAPHY_LABEL.localeCompare(b.properties.GEOGRAPHY_LABEL, undefined, { numeric: true }));
  return [...byValue.values()].sort(compare);
}

// Census 2020 urban areas from TIGERweb, limited to the bounding box of the selected geography.
const TIGERWEB_URBAN_AREAS_URL = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Urban/MapServer/6";

async function loadTigerUrbanAreas(signal, geography) {
  const params = {
    where: "1=1",
    outFields: "NAME",
    returnGeometry: "true",
    outSR: "4326",
    maxAllowableOffset: "0.0002",
    geometryPrecision: "6",
  };
  if (geography) {
    const { xmin, ymin, xmax, ymax } = geometryBounds(geography.geometry);
    Object.assign(params, {
      geometry: `${xmin},${ymin},${xmax},${ymax}`,
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
    });
  }
  return queryAllGeojson(TIGERWEB_URBAN_AREAS_URL, params, signal, 500, 5000, null);
}

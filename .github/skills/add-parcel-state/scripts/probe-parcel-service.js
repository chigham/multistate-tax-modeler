#!/usr/bin/env node
"use strict";
/*
 * Probe an ArcGIS parcel layer and report whether it can feed the multistate tax modeler.
 *
 * Usage:
 *   node probe-parcel-service.js <layerUrl> [--where "<filter for one county>"]
 *        [--land F] [--improvement F] [--total F] [--county F] [--municipality F]
 *        [--origin http://localhost:8765] [--timeout 120]
 *
 * Prints: layer capabilities, field roles (guessed or given), value coverage, statistics support
 * (group by, ratio expression, PERCENTILE_CONT, CASE sums), pagination/GeoJSON, CORS, timings,
 * and a PASS/WARN/FAIL verdict against the feasibility gates in SKILL.md.
 */

const args = process.argv.slice(2);
if (!args[0] || args[0].startsWith("--")) {
  console.error("Usage: node probe-parcel-service.js <layerUrl> [--where ...] [--land F --improvement F --total F --county F]");
  process.exit(1);
}
const layerUrl = args[0].replace(/\/+$/, "").replace(/\?.*$/, "");
const option = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index > 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const baseWhere = option("where", "1=1");
const origin = option("origin", "http://localhost:8765");
const timeoutMs = Number(option("timeout", "120")) * 1000;

const results = [];
const gate = (id, status, message) => results.push({ id, status, message });

async function request(params, { method = "POST", path = "/query" } = {}) {
  const started = Date.now();
  const url = `${layerUrl}${path}`;
  const body = new URLSearchParams({ f: "json", ...params });
  const response = await fetch(method === "GET" ? `${url}?${body}` : url, {
    method,
    body: method === "GET" ? undefined : body,
    headers: { Origin: origin, Accept: "application/json, application/geo+json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { error: { message: `Non-JSON response (${response.status}): ${text.slice(0, 120)}` } };
  }
  return { payload, ms: Date.now() - started, headers: response.headers, status: response.status };
}

async function attempt(label, params, options) {
  try {
    const result = await request(params, options);
    const error = result.payload.error;
    const detail = error ? `${error.message || ""} ${(error.details || []).join(" ")}`.trim() : null;
    console.log(`  ${error ? "ERR" : "OK "} ${label} (${result.ms} ms)${detail ? ` - ${detail}` : ""}`);
    return { ...result, ok: !error };
  } catch (failure) {
    console.log(`  ERR ${label} - ${failure.name === "TimeoutError" ? `timed out after ${timeoutMs / 1000}s` : failure.message}`);
    return { ok: false, payload: {}, ms: timeoutMs };
  }
}

const ROLE_PATTERNS = {
  land: /(^|_)(LND|LAND)(_?VAL|VALUE|VL|$)|NFMLNDVL|LANDVAL|LND_VAL|LNDVALUE/i,
  improvement: /(IMP|IMPR|IMPROV|BLDG_?VAL|STRUCT_?VAL)(_?VAL|VALUE|VL|$)|NFMIMPVL|IMPVALUE/i,
  total: /(TOT|TTL|TOTAL)(_?VAL|VALUE|VL|ASSD)|CNTASSDVALUE|ASSD_?VAL|ASSESSED|NFMTTLVL|^JV$|JUST_?VAL|MKT_?VAL|MARKET/i,
  county: /^(CO_?NO|CONAME|COUNTY|COUNTY_?NAME|CNTY|CNTY_?NAME|JURSCODE|COUNTYFP|FIPS)$/i,
  municipality: /PLACE|TOWN|MUNI|CITY|TAX_?DIST|TAXDIST|DESCTOWN/i,
  landUse: /(^|_)(LU|DOR_UC|PA_UC|USE_?CODE|LAND_?USE|PROPCLASS|PROP_?CLASS|CLASS_?CD|DESCLU)($|_)/i,
  building: /BLDG|STRUC|LVG|SQFT|YR_?BLT|YEARBLT|UNITS/i,
  occupancy: /OOI|OWN_?OCC|OWNER_?OCC|HMSTD|HOMESTEAD/i,
  exempt: /EXEMPT|EXCLASS|EXMPT|AUXCLASS/i,
  taxBill: /PRPTA|TAX_?AMT|TAX_?BILL|TOTAL_?TAX|NET_?TAX/i,
  id: /PARCEL|ACCT|(^|_)PIN($|_)|APN|TAXPARCEL/i,
  address: /ADDR|SITE|PHY_/i,
  coordinates: /^(LAT|LATITUDE|LON|LONG|LONGITUDE|X_?COORD|Y_?COORD)$/i,
};
const NUMERIC = new Set(["esriFieldTypeDouble", "esriFieldTypeInteger", "esriFieldTypeSmallInteger", "esriFieldTypeSingle", "esriFieldTypeBigInteger"]);

(async () => {
  console.log(`\nPROBE ${layerUrl}\nSample filter: ${baseWhere}\n`);

  // ---------- Layer metadata ----------
  let meta;
  try {
    meta = (await request({}, { method: "GET", path: "" })).payload;
  } catch (failure) {
    console.log(`Could not reach the layer: ${failure.message}`);
    process.exit(2);
  }
  if (meta.error) {
    console.log(`Layer error: ${meta.error.message}`);
    gate(3, "FAIL", `Layer metadata request failed (${meta.error.message}); may require authentication.`);
    return finish();
  }
  const advanced = meta.advancedQueryCapabilities || {};
  const isMapServer = /\/MapServer\/\d+$/i.test(layerUrl);
  console.log("LAYER");
  console.log(`  name: ${meta.name}  type: ${meta.type}  geometry: ${meta.geometryType}`);
  console.log(`  maxRecordCount: ${meta.maxRecordCount}  capabilities: ${meta.capabilities}`);
  console.log(`  statistics: ${meta.supportsStatistics ?? advanced.supportsStatistics}  pagination: ${advanced.supportsPagination}  orderBy: ${advanced.supportsOrderBy}`);
  console.log(`  percentile: ${advanced.supportsPercentileStatistics}  sqlExpression: ${advanced.supportsSqlExpression}  returnCentroid: ${advanced.supportsReturningGeometryCentroid}`);
  console.log(`  service: ${isMapServer ? "MapServer (export image possible)" : "FeatureServer (no export image)"}`);
  if (meta.indexes?.length) console.log(`  attribute indexes: ${meta.indexes.map((index) => index.fields).join(", ")}`);
  if (meta.relationships?.length) console.log(`  relationships: ${meta.relationships.map((r) => `${r.name} -> table ${r.relatedTableId}`).join("; ")}`);

  // ---------- Field roles ----------
  const fields = meta.fields || [];
  const roles = {};
  for (const [role, pattern] of Object.entries(ROLE_PATTERNS)) {
    roles[role] = fields
      .filter((field) => pattern.test(field.name) || pattern.test(field.alias || ""))
      .filter((field) => !["land", "improvement", "total", "taxBill"].includes(role) || NUMERIC.has(field.type))
      .map((field) => field.name);
  }
  roles.total = roles.total.filter((name) => !roles.land.includes(name) && !roles.improvement.includes(name));
  const chosen = {
    land: option("land", roles.land[0] || null),
    improvement: option("improvement", roles.improvement[0] || null),
    total: option("total", roles.total[0] || null),
    county: option("county", roles.county[0] || null),
    municipality: option("municipality", roles.municipality[0] || null),
  };
  console.log("\nFIELDS");
  console.log(`  ${fields.map((field) => `${field.name}:${field.type.replace("esriFieldType", "")}`).join(" ")}`);
  console.log("\nROLE GUESSES (override with --land/--improvement/--total/--county/--municipality)");
  for (const [role, names] of Object.entries(roles)) console.log(`  ${role.padEnd(13)} ${names.join(", ") || "-"}`);
  console.log(`  -> using land=${chosen.land} improvement=${chosen.improvement} total=${chosen.total} county=${chosen.county} municipality=${chosen.municipality}`);

  // ---------- Gate 1: values ----------
  const valueFields = [chosen.land, chosen.improvement, chosen.total].filter(Boolean);
  if (!chosen.land) {
    gate(1, "FAIL", "No land value field found. Split-rate modeling is impossible without land value.");
  } else if (!chosen.improvement && !chosen.total) {
    gate(1, "FAIL", "Land value found but neither improvement nor total value; improvements cannot be derived.");
  } else {
    gate(1, "PASS", `land=${chosen.land}, improvement=${chosen.improvement || `derived as ${chosen.total} - ${chosen.land}`}, total=${chosen.total || `derived as ${chosen.land} + ${chosen.improvement}`}`);
  }

  // ---------- Counts and coverage ----------
  console.log("\nCOUNTS / COVERAGE (sample filter)");
  const all = await attempt("count", { where: baseWhere, returnCountOnly: "true" });
  const total = all.payload.count;
  if (all.ok) console.log(`    records: ${total?.toLocaleString()}`);
  if (all.headers) {
    const cors = all.headers.get("access-control-allow-origin");
    console.log(`    CORS access-control-allow-origin: ${cors || "(none)"}`);
    gate(3, cors ? "PASS" : "WARN", cors ? `CORS allows ${cors}` : "No CORS header returned to Node; verify in a browser (ArcGIS Online always allows CORS).");
  }
  const coverage = {};
  for (const field of valueFields) {
    const positive = await attempt(`${field} > 0`, { where: `(${baseWhere}) AND ${field} > 0`, returnCountOnly: "true" });
    if (positive.ok && total) {
      coverage[field] = positive.payload.count / total;
      console.log(`    ${field} > 0: ${positive.payload.count.toLocaleString()} (${(coverage[field] * 100).toFixed(1)}%)`);
    }
  }
  const valueCoverage = chosen.total ? coverage[chosen.total] : coverage[chosen.land];
  if (valueCoverage !== undefined) {
    gate(2, valueCoverage >= 0.8 ? "PASS" : valueCoverage >= 0.4 ? "WARN" : "FAIL",
      `${(valueCoverage * 100).toFixed(1)}% of sampled records have a positive value. Re-run with other counties (or group by county below) to check statewide coverage.`);
  }

  // ---------- Sample ----------
  const sample = await attempt("sample attributes", { where: baseWhere, outFields: "*", returnGeometry: "false", resultRecordCount: "3" });
  (sample.payload.features || []).forEach((feature, index) => {
    const attributes = feature.attributes || {};
    const interesting = Object.fromEntries(Object.entries(attributes).filter(([key, value]) => value !== null && value !== "" && !/shape/i.test(key)).slice(0, 40));
    console.log(`    [${index}] ${JSON.stringify(interesting)}`);
  });

  // ---------- Statistics ----------
  console.log("\nSTATISTICS");
  const landExpr = chosen.land;
  const totalExpr = chosen.total || (chosen.land && chosen.improvement ? `(${chosen.land} + ${chosen.improvement})` : null);
  const statsWhere = totalExpr ? `(${baseWhere}) AND ${totalExpr} > 0` : baseWhere;
  if (chosen.county && valueFields.length) {
    const grouped = await attempt(`group by ${chosen.county}`, {
      where: statsWhere,
      outFields: chosen.county,
      groupByFieldsForStatistics: chosen.county,
      outStatistics: JSON.stringify([{ statisticType: "count", onStatisticField: valueFields[0], outStatisticFieldName: "n" }]),
    });
    gate(4, grouped.ok ? "PASS" : "FAIL", grouped.ok ? `Grouped statistics work (${grouped.ms} ms).` : "Grouped statistics failed; server-side totals are not possible.");
    if (grouped.ok) console.log(`    groups: ${(grouped.payload.features || []).length}`);
    gate(6, "PASS", `Jurisdiction field ${chosen.county}${chosen.municipality ? ` (+ ${chosen.municipality})` : ""}.`);
  } else {
    gate(6, "WARN", "No county/jurisdiction field identified; tax rates cannot be grouped by attribute.");
    if (valueFields.length) {
      const plain = await attempt("sum", { where: statsWhere, outStatistics: JSON.stringify([{ statisticType: "sum", onStatisticField: valueFields[0], outStatisticFieldName: "s" }]) });
      gate(4, plain.ok ? "WARN" : "FAIL", plain.ok ? "Statistics work but grouping was not tested (no county field)." : "Statistics failed.");
    }
  }
  if (landExpr && totalExpr) {
    const ratio = `CAST(${landExpr} AS FLOAT) / ${totalExpr}`;
    const mean = await attempt("avg(land / total) expression", { where: statsWhere, outStatistics: JSON.stringify([{ statisticType: "avg", onStatisticField: ratio, outStatisticFieldName: "m" }]) });
    const caseSum = await attempt("sum(CASE WHEN ...) expression", { where: statsWhere, outStatistics: JSON.stringify([{ statisticType: "sum", onStatisticField: `CASE WHEN ${landExpr} <= ${totalExpr} * 0.5 THEN 1 ELSE 0 END`, outStatisticFieldName: "c" }]) });
    const percentile = await attempt("PERCENTILE_CONT on expression", { where: statsWhere, outStatistics: JSON.stringify([{ statisticType: "PERCENTILE_CONT", statisticParameters: { value: 0.5 }, onStatisticField: ratio, outStatisticFieldName: "p" }]) });
    if (!mean.ok || !caseSum.ok) gate(4, "FAIL", "SQL expressions in statistics are not supported; land-share metrics and report bands cannot be computed server-side.");
    if (!percentile.ok) console.log("    -> set parcels.percentileExpressions: false");
    if (Math.max(mean.ms, caseSum.ms) > 60000) gate(11, "WARN", `Statistics took up to ${Math.round(Math.max(mean.ms, caseSum.ms) / 1000)} s for the sample filter.`);
    else gate(11, "PASS", `Statistics took up to ${Math.round(Math.max(mean.ms, caseSum.ms) / 1000)} s for the sample filter.`);
  }

  // ---------- Geometry / pagination ----------
  console.log("\nGEOMETRY / PAGINATION");
  if (!meta.geometryType) {
    gate(5, "FAIL", "Layer is a table without geometry; geography statistics are impossible (popup-only join needs a core extension).");
  } else {
    gate(5, "PASS", `Values are on a ${meta.geometryType} layer.`);
    const page = await attempt("GeoJSON page (offset 1, 2 records, outSR 4326)", {
      where: baseWhere, outFields: valueFields[0] || "*", returnGeometry: "true", outSR: "4326", resultOffset: "1", resultRecordCount: "2", f: "geojson",
    });
    const type = page.payload.features?.[0]?.geometry?.type;
    gate(7, page.ok && type ? "PASS" : "WARN", page.ok ? `GeoJSON pagination works (${type || "no geometry"}).` : "GeoJSON pagination failed.");
    if (/Polygon/.test(meta.geometryType)) {
      const centroid = await attempt("returnCentroid", { where: baseWhere, outFields: "OBJECTID", returnGeometry: "false", returnCentroid: "true", outSR: "4326", resultRecordCount: "1" });
      const hasCoords = roles.coordinates.length > 0;
      gate(8, "WARN", `Polygon layer: pattern B unless a point layer exists. Centroid fields: ${roles.coordinates.join(", ") || "none"}; returnCentroid ${centroid.ok && centroid.payload.features?.[0]?.centroid ? "works" : "unavailable"}.${hasCoords ? "" : " Without either, district membership is approximate."}`);
    } else {
      gate(8, "PASS", "Point layer: use it as the analysis layer (pattern A or C).");
    }
  }
  gate(9, isMapServer ? "PASS" : "WARN", isMapServer ? "MapServer export available for low-zoom images." : "FeatureServer: no low-zoom image; parcels draw at zoom 14+.");
  const softFields = ["landUse", "building", "occupancy", "exempt"].map((role) => `${role}: ${roles[role][0] || "none"}`).join("; ");
  gate(10, ["landUse", "exempt"].every((role) => roles[role].length) ? "PASS" : "WARN", softFields);
  if (roles.taxBill.length) console.log(`\n  Tax bill field(s) ${roles.taxBill.join(", ")} -> effective rates can be derived (guide section 3).`);

  finish();
})();

function finish() {
  console.log("\nGATES (see SKILL.md)");
  results.sort((a, b) => a.id - b.id).forEach(({ id, status, message }) => console.log(`  ${String(id).padStart(2)} ${status.padEnd(4)} ${message}`));
  const hard = results.filter((result) => [1, 3, 4, 5].includes(result.id) && result.status === "FAIL");
  const verdict = hard.length ? "REJECT (hard gate failed)" : results.some((result) => result.status !== "PASS") ? "IMPLEMENT WITH CAVEATS (confirm WARN items)" : "IMPLEMENT";
  console.log(`\nSUGGESTED VERDICT: ${verdict}`);
  console.log("Role guesses are heuristics. Confirm field meanings in the layer's metadata before deciding.\n");
}

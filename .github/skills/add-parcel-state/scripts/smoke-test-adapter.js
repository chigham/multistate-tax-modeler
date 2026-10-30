#!/usr/bin/env node
"use strict";
/*
 * Smoke-test a state adapter against its live services, outside the browser.
 *
 * Usage:
 *   node smoke-test-adapter.js --state XX --where "<parcel filter for one county>" [--sample 300] [--skip-geographies]
 *
 * Loads js/core/helpers.js and every js/states/*.js listed in index.html into a sandbox, then checks:
 *   - required contract keys
 *   - prepare(), every geography loader, attribute filters matching > 0 taxable parcels
 *   - grouped value statistics and that taxJurisdictionDetails returns a rate for each group
 *   - property types partition the taxable sample (no gaps/overlaps)
 *   - each type's server `where` agrees with its local `matches` on sampled records
 *   - SFH benchmark statistics, occupancy groups, popup rows, and CSV row length
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const args = process.argv.slice(2);
const option = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined && !args[index + 1].startsWith("--") ? args[index + 1] : fallback;
};
const stateId = option("state")?.toUpperCase();
const sampleWhere = option("where", "1=1");
const sampleSize = Number(option("sample", "300"));
const skipGeographies = args.includes("--skip-geographies");
if (!stateId) {
  console.error('Usage: node smoke-test-adapter.js --state XX --where "<county filter>"');
  process.exit(1);
}

const appRoot = path.resolve(__dirname, "../../../..");
const html = fs.readFileSync(path.join(appRoot, "index.html"), "utf8");
const scripts = [...html.matchAll(/<script\s+src="(js\/[^"]+\.js)"/g)].map((match) => match[1]).filter((src) => src !== "js/app.js");

const sandbox = { console, fetch, URL, URLSearchParams, DOMException, AbortController, setTimeout, clearTimeout, structuredClone };
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const src of scripts) vm.runInContext(fs.readFileSync(path.join(appRoot, src), "utf8"), sandbox, { filename: src });
const run = (code) => vm.runInContext(code, sandbox);
const registry = run("ParcelStates");
const adapter = registry.adapters[stateId];
if (!adapter) {
  console.error(`State ${stateId} is not registered. Registered: ${registry.order.join(", ")}. Add its <script> tag to index.html.`);
  process.exit(1);
}
const signal = new AbortController().signal;
const arcgisQuery = run("arcgisQuery");
const queryAllJson = run("queryAllJson");
const mapWithConcurrency = run("mapWithConcurrency");
const arcgisStatisticsAcrossSources = run("arcgisStatisticsAcrossSources");
const relatedTable = adapter.parcels.relatedTable || null;
const analysisSources = (relatedTable
  ? [{ key: "related-table", url: relatedTable.url, where: relatedTable.where }]
  : adapter.parcels.analysisSources?.length
  ? adapter.parcels.analysisSources
  : [{ key: "primary", url: adapter.parcels.analysisUrl }])
  .map((source, index) => ({ ...source, key: source.key || `source-${index}` }));
const mapSourceExpression = (expression, source) => {
  if (!expression || !source.fieldMap) return expression;
  return Object.entries(source.fieldMap).reduce((result, [canonical, actual]) =>
    result.replace(new RegExp(`\\b${canonical}\\b`, "g"), String(actual)), String(expression));
};
const normalizeProperties = (source, attributes) => source.normalizeProperties
  ? source.normalizeProperties(attributes || {})
  : (attributes || {});
const whereForSource = (where, source) => {
  let scoped = String(where || "1=1");
  if (source.taxableWhere && adapter.parcels.taxableWhere) {
    scoped = scoped.replaceAll(adapter.parcels.taxableWhere, source.taxableWhere);
  } else {
    scoped = mapSourceExpression(scoped, source);
  }
  return [scoped, source.where].filter(Boolean).map((part) => `(${part})`).join(" AND ");
};

const outcomes = [];
const record = (status, name, detail = "") => {
  outcomes.push({ status, name });
  console.log(`${status.padEnd(4)} ${name}${detail ? ` - ${detail}` : ""}`);
};
async function check(name, fn) {
  const started = Date.now();
  try {
    const result = await fn();
    const status = result?.status || "OK";
    record(status, `${name} (${Date.now() - started} ms)`, result?.detail ?? (typeof result === "string" ? result : ""));
    return result;
  } catch (error) {
    record("FAIL", name, error.message);
    return null;
  }
}

function missingKeys() {
  const required = [
    "id", "name", "center", "zoom", "brand.eyebrow", "brand.dataNote", "brand.acknowledgementsHtml",
    "tax.description", "tax.scopeLabel", "tax.shortLabel",
    "parcels.analysisUrl", "parcels.analysisGeometry", "parcels.shapesUrl", "parcels.outFields", "parcels.taxableWhere", "parcels.objectIdField",
    "fields.land", "fields.improvement", "fields.improvementCount", "fields.total", "values", "jurisdictionGroupBy", "taxJurisdictionDetails",
    "sfh.where", "sfh.matches", "sfh.definition", "propertyTypes", "occupancy.groups", "occupancy.definition",
    "geographies", "geographyOrder", "defaultGeography", "exportDistricts", "urban.load", "urban.definition",
    "popup.title", "popup.rows", "popup.sortKey", "csv.headers", "csv.row",
    "report.title", "report.accountNoun", "report.unitDescription", "report.caveats", "report.rateDefinition", "report.sfhNotes", "report.sourceLines", "report.csvColumnNotes",
  ];
  const missing = required.filter((key) => key.split(".").reduce((value, part) => value?.[part], adapter) === undefined);
  adapter.geographyOrder?.forEach((type) => { if (!adapter.geographies?.[type]) missing.push(`geographies.${type}`); });
  if (adapter.geographies && !adapter.geographies[adapter.defaultGeography]) missing.push("defaultGeography (not in geographies)");
  adapter.exportDistricts?.forEach((district) => { if (!adapter.geographies?.[district.type]) missing.push(`exportDistricts ${district.type}`); });
  ["agricultural", "vacant", "sfh", "other"].forEach((key) => {
    if (!adapter.propertyTypes?.some((type) => type.key === key)) missing.push(`propertyTypes key "${key}"`);
  });
  return missing;
}

const taxable = `(${adapter.parcels.taxableWhere}) AND (${sampleWhere})`;
const stats = (where, statistics, groupBy, whereForSourceOverride = null) => {
  if (analysisSources.length === 1) {
    const source = analysisSources[0];
    const params = {
      where: whereForSourceOverride ? whereForSourceOverride(source) : whereForSource(where, source),
      returnGeometry: "false",
      outStatistics: JSON.stringify(statistics.map((statistic) => ({
        ...statistic,
        onStatisticField: mapSourceExpression(statistic.onStatisticField, source),
      }))),
      f: "json",
    };
    if (groupBy) {
      params.outFields = groupBy;
      params.groupByFieldsForStatistics = groupBy;
    }
    return arcgisQuery(source.url, params, signal).then((payload) => payload.features || []);
  }
  return arcgisStatisticsAcrossSources(
    analysisSources,
    (source) => ({ where: whereForSourceOverride ? whereForSourceOverride(source) : whereForSource(where, source), returnGeometry: "false" }),
    statistics,
    groupBy,
    signal,
    (source) => statistics.map((statistic) => ({
      ...statistic,
      onStatisticField: mapSourceExpression(statistic.onStatisticField, source),
    })),
  );
};
const countWhere = async (where, whereForSourceOverride = null) => {
  const counts = await mapWithConcurrency(analysisSources, 6, async (source) => {
    const payload = await arcgisQuery(source.url, { where: whereForSourceOverride ? whereForSourceOverride(source) : whereForSource(where, source), returnCountOnly: "true", f: "json" }, signal);
    return Number(payload.count) || 0;
  });
  return counts.reduce((sum, count) => sum + count, 0);
};
const read = (attributes, name) => {
  const key = Object.keys(attributes).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? attributes[key] : undefined;
};
const isImproved = (properties) => {
  const { improvement } = adapter.values(properties);
  return improvement !== null && Number.isFinite(improvement) && improvement > 0;
};

(async () => {
  console.log(`\nSMOKE TEST ${adapter.id} (${adapter.name})\nScripts: ${scripts.join(", ")}\nSample: ${taxable}\n`);

  const missing = missingKeys();
  record(missing.length ? "FAIL" : "OK", "contract keys", missing.join(", "));

  if (adapter.prepare) await check("prepare()", async () => { await adapter.prepare(signal); return "done"; });

  if (!skipGeographies) {
    for (const type of adapter.geographyOrder) {
      const config = adapter.geographies[type];
      await check(`geography ${type}`, async () => {
        const features = await config.load(signal);
        if (!features.length) return { status: "FAIL", detail: "no features" };
        const labels = `${features.length} features: ${features[0].properties.GEOGRAPHY_LABEL} ... ${features.at(-1).properties.GEOGRAPHY_LABEL}`;
        if (!config.attributeFilter) return labels;
        const sample = [features[0], features[Math.floor(features.length / 2)], features.at(-1)];
        const counts = await Promise.all(sample.map(async (feature) => {
          const filter = config.attributeFilter(feature);
          return filter ? countWhere(`(${adapter.parcels.taxableWhere}) AND (${filter})`) : null;
        }));
        const zero = counts.filter((count) => count === 0).length;
        return {
          status: zero ? (config.verifyAttributeFilter ? "WARN" : "FAIL") : "OK",
          detail: `${labels}; attribute filter counts ${counts.join(", ")}${zero && !config.verifyAttributeFilter ? " (set verifyAttributeFilter or fix name matching)" : ""}`,
        };
      });
    }
  }

  const taxableCount = await check("taxable count", async () => {
    const count = await countWhere(taxable);
    return { status: count ? "OK" : "FAIL", detail: String(count), count };
  });
  const total = taxableCount?.count || 0;

  await check("value statistics by jurisdiction", async () => {
    // Mirrors valueStatistics() in js/app.js (avg + count only; some MapServers reject sum here).
    const { land, improvement, improvementCount, total: totalField } = adapter.fields;
    const statistics = [
      ...(!adapter.fields.totalFromComponents
        ? [{ statisticType: "avg", onStatisticField: totalField, outStatisticFieldName: "averageTotal" }]
        : []),
      { statisticType: "count", onStatisticField: totalField, outStatisticFieldName: "totalCount" },
      { statisticType: "avg", onStatisticField: land, outStatisticFieldName: "averageLand" },
      { statisticType: "count", onStatisticField: land, outStatisticFieldName: "landCount" },
      ...(!adapter.fields.improvementFromTotalMinusLand
        ? [
          { statisticType: "avg", onStatisticField: improvement, outStatisticFieldName: "averageImprovement" },
          { statisticType: "count", onStatisticField: improvementCount, outStatisticFieldName: "improvementCount" },
        ]
        : []),
    ];
    const rows = await stats(taxable, statistics, adapter.jurisdictionGroupBy);
    const unrated = rows.filter((row) => !Number.isFinite(adapter.taxJurisdictionDetails(row.attributes).rate));
    const example = rows[0] ? adapter.taxJurisdictionDetails(rows[0].attributes) : null;
    return {
      status: !rows.length ? "FAIL" : unrated.length ? "WARN" : "OK",
      detail: `${rows.length} groups, ${unrated.length} without a rate; e.g. ${JSON.stringify(example)}`,
    };
  });

  await check("property types partition the sample", async () => {
    const counts = await mapWithConcurrency(adapter.propertyTypes, 3, async (type) => [type.key, await countWhere(taxable, (source) => {
      const typeWhere = type.whereBySource?.[source.key] || mapSourceExpression(type.where, source);
      return `${whereForSource(taxable, source)} AND (${typeWhere})`;
    })]);
    const sum = counts.reduce((acc, [, count]) => acc + count, 0);
    return {
      status: sum === total ? "OK" : "FAIL",
      detail: `${counts.map(([key, count]) => `${key}=${count}`).join(" ")}; sum ${sum} vs taxable ${total}${sum > total ? " (overlapping where clauses)" : sum < total ? " (gaps in where clauses)" : ""}`,
    };
  });

  const samples = await check(`fetch ${sampleSize} sample records`, async () => {
    const samplePerSource = Math.min(sampleSize, Math.max(1, Math.ceil(sampleSize / analysisSources.length)));
    const featureGroups = await mapWithConcurrency(analysisSources, 6, async (source) => {
      const features = await queryAllJson(source.url, {
        where: whereForSource(taxable, source),
        outFields: relatedTable ? relatedTable.outFields : source.outFields || adapter.parcels.outFields,
        returnGeometry: "false",
        orderByFields: relatedTable ? (relatedTable.orderBy || "ID") : (source.objectIdField || adapter.parcels.objectIdField),
      }, signal, Math.min(samplePerSource, 2000), samplePerSource);
      return features.map((feature) => ({ ...normalizeProperties(source, feature.attributes), __smokeSourceKey: source.key }));
    });
    const features = featureGroups.flat().slice(0, sampleSize);
    return { detail: `${features.length} records across ${analysisSources.length} source(s)`, features };
  });
  const records = samples?.features || [];

  if (relatedTable) {
    await check("related geometry keys match value rows", async () => {
      const geometry = await queryAllJson(adapter.parcels.analysisUrl, {
        where: relatedTable.geometryWhere || "1=1",
        outFields: relatedTable.geometryKeyField,
        returnGeometry: "false",
      }, signal, 10, 10);
      const keys = [...new Set(geometry.map((feature) => String(feature.attributes?.[relatedTable.geometryKeyField] || "").trim()).filter(Boolean))];
      if (!keys.length) return { status: "FAIL", detail: "no geometry join keys in the sample" };
      const keyWhere = `${relatedTable.keyField} IN (${keys.map((key) => `'${key.replaceAll("'", "''")}'`).join(",")})`;
      const rows = await queryAllJson(relatedTable.url, {
        where: [relatedTable.where, keyWhere].filter(Boolean).map((part) => `(${part})`).join(" AND "),
        outFields: `${relatedTable.rowIdField || "ID"},${relatedTable.keyField}`,
        returnGeometry: "false",
      }, signal, 100, 1000);
      const matchedKeys = new Set(rows.map((feature) => String(feature.attributes?.[relatedTable.keyField] || "").trim()));
      const duplicateRows = rows.length - matchedKeys.size;
      return {
        status: matchedKeys.size ? "OK" : "FAIL",
        detail: `${matchedKeys.size}/${keys.length} sampled geometry keys matched ${rows.length} value row(s); ${duplicateRows} extra rows from repeated keys`,
      };
    });
  }

  if (records.length) {
    await check("property type where/matches agree", async () => {
      const idField = relatedTable ? (relatedTable.rowIdField || "ID") : adapter.parcels.objectIdField;
      const recordsBySource = new Map(analysisSources.map((source) => [
        source.key,
        records.filter((record) => record.__smokeSourceKey === source.key),
      ]));
      const serverSets = await Promise.all(adapter.propertyTypes.map(async (type) => {
        const sourceIds = await mapWithConcurrency(analysisSources, 6, async (source) => {
          const ids = (recordsBySource.get(source.key) || []).map((record) => record[idField]);
          if (!ids.length) return { key: source.key, ids: [] };
          const payload = await arcgisQuery(source.url, {
            where: type.whereBySource?.[source.key] || mapSourceExpression(type.where, source), objectIds: ids.join(","), returnIdsOnly: "true", f: "json",
          }, signal);
          return { key: source.key, ids: payload.objectIds || [] };
        });
        return new Set(sourceIds.flatMap(({ key, ids }) => ids.map((id) => `${key}:${id}`)));
      }));
      const mismatches = [];
      records.forEach((properties) => {
        const id = properties[idField];
        const key = `${properties.__smokeSourceKey}:${id}`;
        const server = adapter.propertyTypes.find((_type, index) => serverSets[index].has(key))?.key;
        const local = adapter.propertyTypes.find((type) => type.matches({ properties, improved: isImproved(properties) }))?.key;
        if (server !== local) mismatches.push(`${id}: where=${server} matches=${local}`);
      });
      return { status: mismatches.length ? "FAIL" : "OK", detail: mismatches.length ? `${mismatches.length} mismatches, e.g. ${mismatches.slice(0, 5).join("; ")}` : `${records.length} records agree` };
    });

    await check("SFH where/matches agree", async () => {
      const idField = relatedTable ? (relatedTable.rowIdField || "ID") : adapter.parcels.objectIdField;
      const sourceIds = await mapWithConcurrency(analysisSources, 6, async (source) => {
        const ids = records.filter((record) => record.__smokeSourceKey === source.key).map((record) => record[idField]);
        if (!ids.length) return { key: source.key, ids: [] };
        const payload = await arcgisQuery(source.url, {
          where: source.sfhWhere || mapSourceExpression(adapter.sfh.where, source), objectIds: ids.join(","), returnIdsOnly: "true", f: "json",
        }, signal);
        return { key: source.key, ids: payload.objectIds || [] };
      });
      const server = new Set(sourceIds.flatMap(({ key, ids }) => ids.map((id) => `${key}:${id}`)));
      const disagree = records.filter((properties) => server.has(`${properties.__smokeSourceKey}:${properties[idField]}`) !== Boolean(adapter.sfh.matches(properties)));
      return { status: disagree.length ? "FAIL" : "OK", detail: `${disagree.length} disagreements of ${records.length}` };
    });

    await check("values(), popup, CSV on samples", async () => {
      const problems = [];
      records.forEach((properties) => {
        const { land, improvement, total: value } = adapter.values(properties);
        if (!Number.isFinite(land) || !Number.isFinite(value)) problems.push(`non-numeric land/total for ${properties[adapter.parcels.objectIdField]}`);
        if (improvement !== null && Number.isFinite(improvement) && Math.abs(land + improvement - value) > Math.max(1, value * 0.01)) {
          problems.push(`land + improvement != total for ${properties[adapter.parcels.objectIdField]}`);
        }
        const rows = adapter.popup.rows(properties, { formatCurrency: (amount) => String(amount) });
        if (!Array.isArray(rows) || rows.some((row) => !Array.isArray(row) || row.length !== 2)) problems.push("popup.rows must return [label, value] pairs");
        adapter.popup.title(properties);
        if (adapter.csv.row(properties).length !== adapter.csv.headers.length) problems.push("csv.row length differs from csv.headers");
      });
      const unique = [...new Set(problems)];
      return { status: unique.length ? "WARN" : "OK", detail: unique.length ? `${unique.length} issue types, e.g. ${unique.slice(0, 4).join("; ")}` : "all records OK" };
    });
  }

  await check("SFH benchmark statistics", async () => {
    const ratio = `CAST(${adapter.fields.land} AS FLOAT) / ${adapter.fields.total}`;
    const statistics = [
      { statisticType: "count", onStatisticField: adapter.fields.land, outStatisticFieldName: "sfhCount" },
      { statisticType: "avg", onStatisticField: ratio, outStatisticFieldName: "meanRatio", countStatisticField: "sfhCount" },
    ];
    if (adapter.parcels.percentileExpressions !== false) {
      statistics.push({ statisticType: "PERCENTILE_CONT", statisticParameters: { value: 0.5 }, onStatisticField: ratio, outStatisticFieldName: "medianRatio" });
    }
    const attributes = (await stats(taxable, statistics, null, (source) =>
      `${whereForSource(taxable, source)} AND (${source.sfhWhere || mapSourceExpression(adapter.sfh.where, source)})`))[0]?.attributes || {};
    const count = Number(read(attributes, "sfhCount"));
    return { status: count > 0 ? "OK" : "WARN", detail: JSON.stringify(attributes) };
  });

  await check("occupancy groups", async () => {
    const { field, groups } = adapter.occupancy;
    if (field) {
      const rows = await stats(taxable, [{ statisticType: "count", onStatisticField: adapter.parcels.objectIdField, outStatisticFieldName: "n" }], field);
      return rows.map((row) => `${row.attributes[field] ?? "(null)"}=${read(row.attributes, "n")}`).join(" ");
    }
    if (groups.length === 1) return "single 'Not reported' group (occupancy section hidden in reports)";
    const counts = await Promise.all(groups.map(async (group) => [group.key, group.where ? await countWhere(`${taxable} AND (${group.where})`) : null]));
    const sum = counts.reduce((acc, [, count]) => acc + (count || 0), 0);
    return { status: sum === total ? "OK" : "WARN", detail: `${counts.map(([key, count]) => `${key}=${count}`).join(" ")}; sum ${sum} vs taxable ${total}` };
  });

  const failures = outcomes.filter((outcome) => outcome.status === "FAIL").length;
  const warnings = outcomes.filter((outcome) => outcome.status === "WARN").length;
  console.log(`\nRESULT: ${failures} FAIL, ${warnings} WARN, ${outcomes.length - failures - warnings} OK`);
  console.log("Then check in a browser: county + district load, zoom 16 shapes/popup, underutilized view, all downloads, state switching.\n");
  process.exit(failures ? 1 : 0);
})();

"use strict";

/*
 * State adapter registry.
 *
 * Each state file registers one adapter object. The core app (js/app.js) only talks to
 * parcel data through these adapters, so differing schemas stay inside the state files.
 *
 * Adapter contract (required unless marked optional):
 *   id, name                    "MD", "Maryland"
 *   center, zoom                initial map view
 *   brand: { eyebrow, dataNote, acknowledgementsHtml }
 *   tax: { description, scopeLabel, shortLabel, rateNote? }
 *   parcels: {
 *     analysisUrl               layer used for statistics and membership (points when available)
 *     analysisSources?          [{ key, url, countyName?, countyNames?, where?, taxableWhere?, whereForGeography?, fieldMap?, statisticScales?, normalizeProperties?, outFields?, objectIdField? }]
 *                                countyNames supports one service covering several counties; strictCountySources rejects unsupported counties
 *                                fieldMap translates canonical SQL identifiers to source fields/expressions; statisticScales scales grouped AVG outputs
 *     analysisGeometry          "point" | "polygon"
 *     shapesUrl                 polygon layer drawn at high zoom
 *     shapeSources?             [{ url, where? }] when shapes are split across layers
 *     shapesCarryAttributes     true when shapes are the analysis layer (no separate points)
 *     shapeWhere, shapeOutFields
 *     shapeJoin?                { shapeKey(props), pointKey(props) } to attach points by key instead of point-in-polygon
 *     relatedTable?             { url?, loadRecords?(geography, signal), keyField, geometryKeyField, where, outFields, ... }
 *                                for a non-spatial value table or locally downloaded county file
 *                                The core spatially selects/paginates geometry keys, joins table rows (including 1:many),
 *                                and computes geography statistics locally when the service cannot aggregate a join.
 *     exportMapUrl?, exportLayerId?   MapServer used for low-zoom parcel images
 *     generalizeShapes?         simplify drawn shapes to the screen resolution
 *     parcelVisualization?      { label, description, classCount, colors, value(properties) } optional per-parcel choropleth; class boundaries may be classified from and cached by the selected geography
 *     outFields, taxableWhere, objectIdField, pageSize, pointPageSize?, downloadBatchSize?
 *     percentileExpressions?    false when the service cannot run PERCENTILE_CONT on an expression
 *     center?(props)            [lng, lat] from attributes, for polygon layers
 *   }
 *   fields: { land, improvement, improvementCount, total, totalFromComponents?, improvementFromTotalMinusLand? }
 *                              SQL fields/expressions for statistics; set totalFromComponents when total is land + improvements, or improvementFromTotalMinusLand when grouped AVG(total - land) is unsupported
 *   values(props) → { land, improvement (null when unknown), total }
 *   jurisdictionGroupBy          comma-separated fields that determine the tax rate
 *   prepare?(signal)             async one-time setup (e.g. rate tables derived from data)
 *   taxJurisdictionDetails(props) → { county, municipality, rate, jurisdiction }
 *   sfh: { where, matches(props), definition }
 *   propertyTypes: [{ key, label, definition, where, matches({ properties, improved }) }]
 *   occupancy: { field?, groups: [{ key, label, where?, matches?(props) }], ownerOccupiedKey?, definition }
 *   geographies: { [type]: { label, choiceLabel, load(signal, options), attributeFilter?(feature), verifyAttributeFilter?, wideMenu? } }
 *   geographyOrder, defaultGeography
 *   exportDistricts: [{ type, header, description, perCounty? }]
 *   urban: { load(signal, geography), definition, perGeography? }
 *   popup: { title(props), rows(props, { formatCurrency }) → [[label, value]], sortKey(props) → [a, b] }
 *   csv: { headers, row(props) }   row length must equal headers length
 *   report: { title, accountNoun, unitDescription, caveats, rateDefinition, sfhNotes, sourceLines, csvColumnNotes }
 *
 * Related-table statistics require a stable shared key and are paged by geography; joined records
 * are aggregated client-side when ArcGIS does not support statistics on the joined geometry.
 * Multi-source statistics are queried per layer and combined by group. Counts and sums are added,
 * averages are weighted by server-side counts, and percentile statistics must use additive bins.
 * Object IDs are scoped to a source; centroid exclusions and downloads are kept per source.
 *
 * See .github/skills/add-parcel-state/ for the workflow to add or reject a state.
 */
window.ParcelStates = {
  adapters: {},
  order: [],
  defaultId: "MD",
  register(adapter) {
    this.adapters[adapter.id] = adapter;
    this.order.push(adapter.id);
  },
  get(id) {
    return this.adapters[id] || this.adapters[this.defaultId];
  },
};

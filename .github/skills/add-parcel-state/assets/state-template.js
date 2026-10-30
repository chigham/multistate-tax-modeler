"use strict";

// TODO <State>: one-paragraph summary of the data pattern (A, B, or C from the adapter guide),
// which layer drives statistics, how shapes get attributes, and how values/rates are derived.
(() => {
  const PARCELS_URL = "TODO"; // analysis layer (points when available)
  const SHAPES_URL = "TODO"; // polygon layer (same as PARCELS_URL for pattern B)
  const TAXABLE_WHERE = "TODO_TOTAL > 0"; // TODO: add exemption exclusion
  const DISTRICT_OFFSET = 0.00003;
  const AREA_OFFSET = 0.0002;

  // ---------- Classification ----------
  // `where` and `matches` must describe the same rule; types partition the taxable set
  // (first match wins, last is a catch-all). Keep keys agricultural, vacant, sfh, other.
  const NOT_AG = "TODO";
  const IMPROVED = `${NOT_AG} AND TODO_IMPROVEMENT > 0`;
  const SFH_WHERE = "TODO";
  const isSingleFamilyParcel = (p) => false; // TODO: mirror SFH_WHERE

  const PROPERTY_TYPES = [
    { key: "agricultural", label: "Agricultural", definition: "TODO", where: "TODO", matches: ({ properties }) => false },
    { key: "vacant", label: "Vacant / unimproved land", definition: "Any other parcel with no improvement value.", where: `${NOT_AG} AND (TODO_IMPROVEMENT IS NULL OR TODO_IMPROVEMENT = 0)`, matches: ({ improved }) => !improved },
    { key: "sfh", label: "Single-family homes", definition: "TODO", where: `${IMPROVED} AND TODO`, matches: ({ properties }) => isSingleFamilyParcel(properties) },
    // TODO: condo, otherResidential, apartments, mixedUse, commercial, industrial as the data allows
    { key: "other", label: "Other", definition: "Remaining improved parcels.", where: `${IMPROVED} AND TODO_NOT_ANY_ABOVE`, matches: () => true },
  ];

  // ---------- Tax rates ----------
  // Pick a strategy (adapter guide section 3). Never invent rates; use a flagged placeholder if needed.
  function taxJurisdictionDetails(p) {
    // Receives only the jurisdictionGroupBy fields.
    const county = "TODO County";
    const municipality = null;
    const rate = null;
    return { county, municipality, rate, jurisdiction: municipality ? `${county} — ${municipality}` : county };
  }

  const optional = (value) => (value === null || value === undefined || value === "" ? null : value);
  const percentOf = (part, total) => (Number(total) ? ` (${((Number(part) / Number(total)) * 100).toFixed(0)}%)` : "");
  const urbanCache = new Map();

  window.ParcelStates.register({
    id: "XX", // TODO two-letter code (used in ?state=XX and the brand mark)
    name: "TODO",
    center: [0, 0], // TODO [lat, lng]
    zoom: 7,
    brand: {
      eyebrow: "TODO property insights",
      dataNote: "Parcels provided by TODO",
      acknowledgementsHtml: `
        <li><a href="TODO" target="_blank" rel="noopener">TODO</a> — parcels and assessments</li>
        <li><a href="https://tigerweb.geo.census.gov/" target="_blank" rel="noopener">U.S. Census Bureau TIGERweb</a> — 2020 urban areas</li>`,
    },
    tax: {
      description: "TODO which parcels load and which tax is modeled.",
      scopeLabel: "County real property tax", // TODO
      shortLabel: "County Property Tax", // TODO
      // rateNote: "TODO shown as a warning in the panel when rates are approximate or placeholders",
    },
    parcels: {
      analysisUrl: PARCELS_URL,
      analysisGeometry: "point", // or "polygon"
      shapesUrl: SHAPES_URL,
      // shapesCarryAttributes: true,          // pattern B
      shapeWhere: "1=1",
      shapeOutFields: "OBJECTID",               // pattern C: add key fields
      // shapeJoin: { shapeKey: (p) => p.ID, pointKey: (p) => p.ID }, // pattern C
      // exportMapUrl: "https://.../MapServer", exportLayerId: 0,     // only for MapServers
      generalizeShapes: true,
      outFields: "OBJECTID,TODO",
      taxableWhere: TAXABLE_WHERE,
      objectIdField: "OBJECTID",
      pageSize: 2000,
      pointPageSize: 2000,
      // percentileExpressions: false,         // hosted layers
      // center: (p) => [Number(p.LON), Number(p.LAT)], // pattern B with centroid fields
    },
    fields: { land: "TODO_LAND", improvement: "TODO_IMPROVEMENT", improvementCount: "TODO_IMPROVEMENT", total: "TODO_TOTAL" },
    values: (p) => ({
      land: Number(p.TODO_LAND),
      improvement: p.TODO_IMPROVEMENT === null || p.TODO_IMPROVEMENT === undefined ? null : Number(p.TODO_IMPROVEMENT),
      total: Number(p.TODO_TOTAL),
    }),
    jurisdictionGroupBy: "TODO_COUNTY",
    // prepare: (signal) => cachedPromise,      // async rate setup
    taxJurisdictionDetails,
    sfh: { where: SFH_WHERE, matches: isSingleFamilyParcel, definition: "TODO plain-language SFH rule" },
    propertyTypes: PROPERTY_TYPES,
    occupancy: {
      groups: [{ key: "", label: "Not reported" }], // TODO: field-based or where-based groups if available
      definition: "TODO",
    },
    geographies: {
      stateUpper: {
        label: "TODO State Senate districts (year)",
        choiceLabel: "District",
        load: (signal) => loadArcgisGeography({
          serviceUrl: "TODO",
          outFields: "TODO",
          maxAllowableOffset: DISTRICT_OFFSET,
          value: (p) => p.TODO,
          label: (p, value) => `TODO Senate - ${value}`,
        }, signal),
      },
      // stateLower: { ... },
      congressional: { label: "U.S. congressional districts (year)", choiceLabel: "District", load: (signal) => loadArcgisGeography({ serviceUrl: "TODO", outFields: "TODO", maxAllowableOffset: DISTRICT_OFFSET, value: (p) => p.TODO, label: (p, value) => `U.S. - ${value}` }, signal) },
      county: {
        label: "Counties",
        choiceLabel: "County",
        load: (signal) => loadArcgisGeography({ serviceUrl: "TODO", outFields: "TODO", maxAllowableOffset: AREA_OFFSET, value: (p) => p.TODO, label: (p, value) => `${value} County`, county: (p) => `${p.TODO} County` }, signal),
        attributeFilter: (feature) => `TODO_COUNTY = ${sqlString(feature.properties.raw.TODO)}`,
      },
      municipality: {
        label: "Municipalities",
        choiceLabel: "Municipality",
        // verifyAttributeFilter: true,
        load: (signal) => loadArcgisGeography({ serviceUrl: "TODO", outFields: "TODO", maxAllowableOffset: AREA_OFFSET, value: (p) => p.TODO, label: (p) => p.TODO }, signal),
      },
    },
    geographyOrder: ["stateUpper", "congressional", "county", "municipality"],
    defaultGeography: "stateUpper",
    exportDistricts: [
      { type: "stateUpper", header: "STATE_SENATE_DISTRICT", description: "TODO" },
      { type: "congressional", header: "CONGRESSIONAL_DISTRICT", description: "TODO" },
    ],
    urban: {
      definition: "2020 Census urban area (at least 2,000 housing units or 5,000 people)",
      perGeography: true,
      load: (signal, geography) => {
        const key = geography?.properties.GEOGRAPHY_VALUE ?? "";
        if (!urbanCache.has(key)) {
          urbanCache.set(key, loadTigerUrbanAreas(signal, geography).catch((error) => {
            urbanCache.delete(key);
            throw error;
          }));
        }
        return urbanCache.get(key);
      },
    },
    popup: {
      title: (p) => optional(p.TODO_ADDRESS) || "Selected parcel",
      sortKey: (p) => [p.TODO_ADDRESS, p.TODO_ID],
      rows: (p, { formatCurrency }) => [
        ["Parcel ID", optional(p.TODO_ID)],
        ["Land value", `${formatCurrency(p.TODO_LAND)}${percentOf(p.TODO_LAND, p.TODO_TOTAL)}`],
        ["Improvement value", `${formatCurrency(p.TODO_IMPROVEMENT)}${percentOf(p.TODO_IMPROVEMENT, p.TODO_TOTAL)}`],
        ["Total value", `${formatCurrency(p.TODO_TOTAL)}${Number(p.TODO_TOTAL) ? " (100%)" : ""}`],
      ],
    },
    csv: {
      headers: ["TODO_ID", "TODO_LAND", "TODO_IMPROVEMENT", "TODO_TOTAL"],
      row: (p) => [p.TODO_ID, Number(p.TODO_LAND), Number(p.TODO_IMPROVEMENT) || 0, Number(p.TODO_TOTAL)],
    },
    report: {
      title: "PARCEL ANALYSIS - TODO - SPLIT-RATE PROPERTY TAX SUMMARY",
      accountNoun: "parcels",
      unitDescription: "TODO what one record represents.",
      caveats: ["TODO levies covered, values used, credits not modeled, data gaps."],
      rateDefinition: "Rates are percent of assessed value ($ per $100). TODO",
      sfhNotes: "TODO SFH benchmark rule in field terms.",
      sourceLines: [`TODO parcels: ${PARCELS_URL}`],
      csvColumnNotes: ["TODO one line per source column group."],
    },
  });
})();

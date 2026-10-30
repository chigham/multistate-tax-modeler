"use strict";

// District of Columbia: DC GIS Owner Polygons carry geometry and selected
// current phased land/building values (polygon-only pattern B).
(() => {
  const PARCELS_URL = "https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Property_and_Land_WebMercator/MapServer/40";
  const DC_BOUNDARY_URL = "https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Administrative_Other_Boundaries_WebMercator/MapServer/10";
  const WARDS_URL = "https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Administrative_Other_Boundaries_WebMercator/MapServer/53";
  const TIGER_LEGISLATIVE = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Legislative/MapServer";
  const TAXABLE_WHERE = "ASSESSMENT > 0 AND PHASELAND IS NOT NULL AND PHASEBUILD IS NOT NULL";
  const DISTRICT_OFFSET = 0.00003;
  const PLACEHOLDER_RATE = 0.0065;
  const SFH_TYPE = "Residential-Single Family (Det";

  const hasValue = (value) => value !== null && value !== undefined && value !== "";
  const numberOrNull = (value) => hasValue(value) && Number.isFinite(Number(value)) ? Number(value) : null;
  const isImproved = (properties) => Number(properties.PHASEBUILD) > 0;
  const propertyType = (properties) => String(properties.PROPTYPE || "").trim().toUpperCase();
  const isSfhProxy = (properties) => propertyType(properties) === SFH_TYPE.toUpperCase() && isImproved(properties);

  const PROPERTY_TYPES = [
    {
      key: "agricultural",
      label: "Agricultural (not separately identified)",
      definition: "The owner-polygon layer does not expose a verified agricultural parcel class; no records are assigned to this category.",
      where: "1 = 0",
      matches: () => false,
    },
    {
      key: "vacant",
      label: "No positive current building value",
      definition: "Taxable owner polygons with no positive PHASEBUILD value; this is a value-based proxy and not the DC land-use Vacant classification.",
      where: "PHASEBUILD <= 0",
      matches: ({ improved }) => !improved,
    },
    {
      key: "sfh",
      label: "Detached single-family (source type)",
      definition: "Positive current building value and PROPTYPE = Residential-Single Family (Det. The source property-type field is truncated to 30 characters but identifies the detached category.",
      where: `PROPTYPE = '${SFH_TYPE}' AND PHASEBUILD > 0`,
      matches: ({ properties }) => isSfhProxy(properties),
    },
    {
      key: "other",
      label: "Other improved property",
      definition: "Remaining owner polygons with positive current building value outside the detached single-family category.",
      where: `PHASEBUILD > 0 AND (PROPTYPE IS NULL OR PROPTYPE <> '${SFH_TYPE}')`,
      matches: ({ properties, improved }) => improved && !isSfhProxy(properties),
    },
  ];

  function taxJurisdictionDetails() {
    return {
      county: "District of Columbia",
      municipality: null,
      rate: PLACEHOLDER_RATE,
      jurisdiction: "District of Columbia",
    };
  }

  const acknowledgementsHtml = `
    <li><a href="${PARCELS_URL}" target="_blank" rel="noopener">DC GIS Owner Polygons (Common Ownership Layer)</a> — parcel polygons and selected current assessment fields</li>
    <li><a href="${WARDS_URL}" target="_blank" rel="noopener">DC GIS 2022 Wards</a> and <a href="${DC_BOUNDARY_URL}" target="_blank" rel="noopener">DC administrative boundary</a></li>
    <li><a href="https://tigerweb.geo.census.gov/" target="_blank" rel="noopener">U.S. Census Bureau TIGERweb</a> — 119th Congress at-large delegate district and 2020 urban areas</li>`;

  const optional = (value) => (value === null || value === undefined || value === "" ? null : value);
  const percentOf = (part, total) => (Number(total) ? ` (${((Number(part) / Number(total)) * 100).toFixed(0)}%)` : "");
  const urbanCache = new Map();

  window.ParcelStates.register({
    id: "DC",
    name: "District of Columbia",
    center: [38.9, -77.02],
    zoom: 12,
    brand: {
      eyebrow: "District of Columbia property insights",
      dataNote: "DC GIS Owner Polygons and current assessment fields",
      acknowledgementsHtml,
    },
    tax: {
      description: "Load DC Owner Polygons with a positive Assessment and current land/building values. Current tax uses a uniform illustrative placeholder, not a certified DC rate or parcel tax bill.",
      scopeLabel: "Illustrative District property tax (placeholder rate)",
      shortLabel: "Illustrative Property Tax",
      rateNote: `A verified DC tax-rate schedule is not configured. The model uses an illustrative ${(PLACEHOLDER_RATE * 1000).toFixed(1)}-mill placeholder; replace it before citing tax-dollar results.`,
    },
    parcels: {
      analysisUrl: PARCELS_URL,
      analysisGeometry: "polygon",
      shapesUrl: PARCELS_URL,
      shapesCarryAttributes: true,
      generalizeShapes: true,
      outFields: "OBJECTID,SSL,PRMSWARD,PROPTYPE,USECODE,HSTDCODE,OWNOCCT,OLDLAND,OLDIMPR,OLDTOTAL,NEWLAND,NEWIMPR,NEWTOTAL,PHASELAND,PHASEBUILD,ASSESSMENT,ANNUALTAX",
      taxableWhere: TAXABLE_WHERE,
      objectIdField: "OBJECTID",
      pageSize: 2000,
    },
    fields: { land: "PHASELAND", improvement: "PHASEBUILD", improvementCount: "PHASEBUILD", total: "ASSESSMENT" },
    values: (properties) => ({
      land: numberOrNull(properties.PHASELAND),
      improvement: numberOrNull(properties.PHASEBUILD),
      total: numberOrNull(properties.ASSESSMENT),
    }),
    // PRMSWARD keeps service-side aggregate queries bounded; each ward row maps
    // to the same single District-wide illustrative tax jurisdiction.
    jurisdictionGroupBy: "PRMSWARD",
    taxJurisdictionDetails,
    sfh: {
      where: `PROPTYPE = '${SFH_TYPE}' AND PHASEBUILD > 0`,
      matches: isSfhProxy,
      definition: "Source-type proxy: positive PHASEBUILD and the truncated PROPTYPE value Residential-Single Family (Det. This is the closest available detached-home class, not an independent building inspection.",
    },
    propertyTypes: PROPERTY_TYPES,
    occupancy: {
      groups: [{ key: "", label: "Not reported" }],
      definition: "The Owner Polygons layer does not expose a verified owner-occupancy or homestead field; HSTDCODE and OWNOCCT are not interpreted as occupancy here.",
    },
    geographies: {
      councilWard: {
        label: "DC Council wards (2022; local legislative geography)",
        choiceLabel: "Ward",
        load: (signal) => loadArcgisGeography({
          serviceUrl: WARDS_URL,
          outFields: "WARD,LABEL,STATE",
          maxAllowableOffset: DISTRICT_OFFSET,
          value: (properties) => properties.WARD,
          label: (properties, value) => properties.LABEL || `Ward ${value}`,
        }, signal),
      },
      congressional: {
        label: "U.S. House delegate district (119th Congress; 2026 Census vintage)",
        choiceLabel: "District",
        load: (signal) => loadArcgisGeography({
          serviceUrl: `${TIGER_LEGISLATIVE}/4`,
          where: "STATE = '11'",
          outFields: "CD119,STATE,NAME,GEOID",
          maxAllowableOffset: DISTRICT_OFFSET,
          value: (properties) => properties.CD119,
          label: (properties) => `U.S. House ${properties.NAME || "Delegate District (at Large)"}`,
        }, signal),
      },
      county: {
        label: "District boundary (county equivalent)",
        choiceLabel: "District",
        load: (signal) => loadArcgisGeography({
          serviceUrl: DC_BOUNDARY_URL,
          outFields: "CITY_NAME",
          value: (properties) => properties.CITY_NAME || "District of Columbia",
          label: () => "District of Columbia",
          county: () => "District of Columbia",
        }, signal),
      },
    },
    geographyOrder: ["councilWard", "congressional", "county"],
    defaultGeography: "councilWard",
    exportDistricts: [
      { type: "councilWard", header: "DC_COUNCIL_WARD", description: "2022 DC Council ward containing the parcel centroid; wards are local council districts, not state legislative districts." },
      { type: "congressional", header: "US_HOUSE_DELEGATE_DISTRICT", description: "119th Congress U.S. House delegate district containing the parcel centroid; DC's at-large delegate is non-voting." },
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
      title: (properties) => optional(properties.SSL) || "Selected DC owner polygon",
      sortKey: (properties) => [properties.SSL, properties.OBJECTID],
      rows: (properties, { formatCurrency }) => [
        ["Square-suffix-lot (SSL)", optional(properties.SSL)],
        ["Premise ward", optional(properties.PRMSWARD)],
        ["Property type", optional(properties.PROPTYPE)],
        ["Use code", optional(properties.USECODE)],
        ["Homestead code", optional(properties.HSTDCODE)],
        ["Current land value", `${formatCurrency(properties.PHASELAND)}${percentOf(properties.PHASELAND, properties.ASSESSMENT)}`],
        ["Current building value", `${formatCurrency(properties.PHASEBUILD)}${percentOf(properties.PHASEBUILD, properties.ASSESSMENT)}`],
        ["Current phased assessment", `${formatCurrency(properties.ASSESSMENT)}${Number(properties.ASSESSMENT) ? " (100%)" : ""}`],
        ["Proposed total value (not modeled)", optional(properties.NEWTOTAL) === null ? null : formatCurrency(properties.NEWTOTAL)],
        ["Source-reported annual tax (not modeled)", optional(properties.ANNUALTAX) === null ? null : formatCurrency(properties.ANNUALTAX)],
      ],
    },
    csv: {
      headers: ["OBJECTID", "SSL", "PRMSWARD", "PROPTYPE", "USECODE", "HSTDCODE", "OWNOCCT", "OLDLAND", "OLDIMPR", "OLDTOTAL", "NEWLAND", "NEWIMPR", "NEWTOTAL", "PHASELAND", "PHASEBUILD", "ASSESSMENT", "ANNUALTAX"],
      row: (properties) => [
        properties.OBJECTID, properties.SSL, properties.PRMSWARD, properties.PROPTYPE, properties.USECODE, properties.HSTDCODE,
        numberOrNull(properties.OWNOCCT), numberOrNull(properties.OLDLAND), numberOrNull(properties.OLDIMPR), numberOrNull(properties.OLDTOTAL),
        numberOrNull(properties.NEWLAND), numberOrNull(properties.NEWIMPR), numberOrNull(properties.NEWTOTAL), numberOrNull(properties.PHASELAND),
        numberOrNull(properties.PHASEBUILD), numberOrNull(properties.ASSESSMENT), numberOrNull(properties.ANNUALTAX),
      ],
    },
    report: {
      title: "PARCEL ANALYSIS - DISTRICT OF COLUMBIA - SPLIT-RATE PROPERTY TAX SUMMARY",
      accountNoun: "owner polygons",
      unitDescription: "Each record is a geometry-bearing DC GIS Owner Polygon; polygon centers are used for geography membership and polygons are simplified for display.",
      caveats: [
        `A certified DC tax-rate schedule is not configured; current tax applies an illustrative ${(PLACEHOLDER_RATE * 1000).toFixed(1)}-mill placeholder to ASSESSMENT. The results are not official estimates or actual parcel bills.`,
        "The model uses PHASELAND (Current Land Value), PHASEBUILD (Current Build Value), and ASSESSMENT. Sampled records show the current components reconciling to ASSESSMENT; OLD*, NEW*, and ANNUALTAX are retained for transparency but are not used in modeled totals or rates.",
        "The Owner Polygons layer is a mixed Common Ownership geometry layer, not a clean one-feature-per-tax-account parcel roll. It includes multiple lot/property classes and may contain shared or overlapping geometries; owner polygons also have one-to-many SSL relationships to some separate tax data. Results are source-record summaries, not de-duplicated tax accounts.",
        "Positive Assessment and available current land/building values are a data filter, not a legal determination of taxability. Exemptions, credits, and verified parcel tax rates are not applied. The source-reported ANNUALTAX field is not used because its calculation and coverage have not been independently validated.",
        "The source lacks a verified agricultural class and owner-occupancy indicator. The detached-home benchmark uses the truncated source PROPTYPE value Residential-Single Family (Det; HSTDCODE and OWNOCCT are shown but not interpreted as occupancy.",
        "DC has no state legislature. 2022 DC Council wards are offered as local council geography (not state legislative districts); the Census congressional layer identifies DC's at-large, non-voting U.S. House delegate district. The administrative boundary and ward lines are for mapping and analysis, not a legal survey.",
        "The MapServer has no pre-rendered low-zoom parcel image in this adapter; parcel outlines are drawn at zoom 14+.",
      ],
      rateDefinition: "Rates are shown as a percentage of source-reported ASSESSMENT ($ per $100). Current tax is a uniform illustrative placeholder, not a certified DC rate or actual bill.",
      sfhNotes: "Benchmark proxy: positive PHASEBUILD and PROPTYPE = Residential-Single Family (Det. The 30-character source field is truncated; confirm current classification definitions before official use.",
      sourceLines: [`DC GIS Owner Polygons (Common Ownership Layer): ${PARCELS_URL}`, `DC GIS 2022 Ward boundaries: ${WARDS_URL}`, `DC GIS administrative boundary: ${DC_BOUNDARY_URL}`],
      csvColumnNotes: [
        "OBJECTID and SSL: owner-polygon feature ID and Square-Suffix-Lot identifier; the owner polygons can have one-to-many related tax records.",
        "PRMSWARD, PROPTYPE, USECODE, HSTDCODE, OWNOCCT: premise ward, property/use/homestead codes, and owner-occupied-units field; these classification/occupancy fields are not treated as verified exemption or occupancy determinations.",
        "PHASELAND, PHASEBUILD, ASSESSMENT: current land value, current building value, and assessment used in the model. OLD* and NEW* are separate value stages; ANNUALTAX is retained as a source field but not used to calculate current tax.",
      ],
    },
  });
})();

"use strict";

// Vermont: VCGI's standardized statewide Grand List parcel polygons contain
// parcel-level land, improvement, and full listed-value fields (pattern B).
(() => {
  const PARCELS_URL = "https://services1.arcgis.com/BkFxaEFNwHqX3tAw/arcgis/rest/services/FS_VCGI_OPENDATA_Cadastral_VTPARCELS_poly_standardized_parcels_SP_v1/FeatureServer/0";
  const TOWNS_URL = "https://services1.arcgis.com/BkFxaEFNwHqX3tAw/arcgis/rest/services/FS_VCGI_OPENDATA_Boundary_BNDHASH_poly_towns_SP_v1/FeatureServer/0";
  const COUNTIES_URL = "https://services1.arcgis.com/BkFxaEFNwHqX3tAw/arcgis/rest/services/FS_VCGI_OPENDATA_Boundary_BNDHASH_poly_counties_SP_v1/FeatureServer/0";
  const HOUSE_URL = "https://services1.arcgis.com/BkFxaEFNwHqX3tAw/arcgis/rest/services/FS_VCGI_OPENDATA_Boundary_HOUS2022_poly_SP_v1/FeatureServer/0";
  const SENATE_URL = "https://services1.arcgis.com/BkFxaEFNwHqX3tAw/arcgis/rest/services/FS_VCGI_OPENDATA_Boundary_SENA2022_poly_SP_v1/FeatureServer/0";
  const TIGER_LEGISLATIVE = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Legislative/MapServer";
  const TAXABLE_WHERE = "PROPTYPE = 'PARCEL' AND REAL_FLV > 0 AND LAND_LV IS NOT NULL";
  const DISTRICT_OFFSET = 0.00003;
  const AREA_OFFSET = 0.0002;
  const PLACEHOLDER_RATE = 0.0065;

  const hasValue = (value) => value !== null && value !== undefined && value !== "";
  const numberOrNull = (value) => hasValue(value) && Number.isFinite(Number(value)) ? Number(value) : null;
  const category = (properties) => String(properties.CAT || "").trim().toUpperCase();
  const isAgricultural = (properties) => category(properties) === "F";
  const isSfhProxy = (properties) => category(properties) === "R1" && Number(properties.IMPRV_LV) > 0;
  const isImproved = (properties) => Number(properties.IMPRV_LV) > 0;

  const PROPERTY_TYPES = [
    {
      key: "agricultural",
      label: "Farm category (proxy)",
      definition: "CAT = F, used as a farm-category proxy. This source code is not an exemption or legal agricultural-use determination.",
      where: "CAT = 'F'",
      matches: ({ properties }) => isAgricultural(properties),
    },
    {
      key: "vacant",
      label: "No reported improvements",
      definition: "Non-Farm-category parcels with a missing or non-positive listed improvement value.",
      where: "(CAT IS NULL OR CAT <> 'F') AND (IMPRV_LV IS NULL OR IMPRV_LV <= 0)",
      matches: ({ properties, improved }) => !isAgricultural(properties) && !improved,
    },
    {
      key: "sfh",
      label: "Residential CAT R1 (SFH proxy)",
      definition: "Parcels with CAT = R1 and a positive listed improvement value. This category is a residential proxy, not a verified detached-home classification.",
      where: "CAT = 'R1' AND IMPRV_LV > 0",
      matches: ({ properties }) => isSfhProxy(properties),
    },
    {
      key: "other",
      label: "Other improved property",
      definition: "Remaining parcels outside the Farm and R1 proxies with a positive listed improvement value.",
      where: "IMPRV_LV > 0 AND (CAT IS NULL OR (CAT <> 'F' AND CAT <> 'R1'))",
      matches: ({ properties, improved }) => !isAgricultural(properties) && improved && !isSfhProxy(properties),
    },
  ];

  let townCountyMapPromise = null;
  async function loadTownCountyMap(signal) {
    if (!townCountyMapPromise) {
      townCountyMapPromise = Promise.all([
        queryAllJson(TOWNS_URL, { where: "1=1", outFields: "TOWNNAME,CNTY", returnGeometry: "false" }, signal, 2000),
        queryAllJson(COUNTIES_URL, { where: "1=1", outFields: "CNTY,CNTYNAME", returnGeometry: "false" }, signal, 2000),
      ]).then(([townFeatures, countyFeatures]) => {
        const countyNames = new Map(countyFeatures.map(({ attributes = {} }) => [String(attributes.CNTY), String(attributes.CNTYNAME || "")]));
        return new Map(townFeatures.map(({ attributes = {} }) => [
          String(attributes.TOWNNAME || "").trim().toUpperCase(),
          countyNames.get(String(attributes.CNTY)) || "",
        ]).filter(([town]) => town));
      }).catch((error) => {
        townCountyMapPromise = null;
        throw error;
      });
    }
    return townCountyMapPromise;
  }

  function taxJurisdictionDetails(properties) {
    const townCode = String(properties.TOWN || "").trim().toUpperCase();
    const municipality = String(properties.TNAME || properties.TOWN || "").trim();
    const resolvedCounty = townCountyByName(townCode);
    const county = resolvedCounty ? `${titleCase(resolvedCounty)} County` : "Vermont";
    const displayTown = municipality ? titleCase(municipality) : null;
    return {
      county,
      municipality: displayTown,
      rate: PLACEHOLDER_RATE,
      jurisdiction: displayTown ? `${county} — ${displayTown}` : county,
    };
  }

  // The promise resolves during prepare(); retain the map separately so statistics
  // callbacks can synchronously assign each Grand List town to a county.
  let townCountyByName = () => "";
  async function prepare(signal) {
    const map = await loadTownCountyMap(signal);
    townCountyByName = (town) => map.get(town) || "";
  }

  const districtGeography = (label, serviceUrl, field, prefix) => ({
    label,
    choiceLabel: "District",
    load: (signal) => loadArcgisGeography({
      serviceUrl,
      outFields: `${field},NAME`,
      maxAllowableOffset: DISTRICT_OFFSET,
      value: (properties) => properties[field],
      label: (properties, value) => properties.NAME || `${prefix} - ${value}`,
    }, signal),
  });

  const urbanCache = new Map();
  const acknowledgementsHtml = `
    <li><a href="${PARCELS_URL}" target="_blank" rel="noopener">Vermont Center for Geographic Information (VCGI)</a> — standardized statewide Grand List parcel polygons and listed values</li>
    <li><a href="${TOWNS_URL}" target="_blank" rel="noopener">VCGI BNDHASH town boundaries</a> and <a href="${COUNTIES_URL}" target="_blank" rel="noopener">county boundaries</a> — general mapping boundaries</li>
    <li><a href="${HOUSE_URL}" target="_blank" rel="noopener">VCGI 2022 Vermont House</a> and <a href="${SENATE_URL}" target="_blank" rel="noopener">Senate reapportionment boundaries</a>; <a href="https://tigerweb.geo.census.gov/" target="_blank" rel="noopener">U.S. Census Bureau TIGERweb</a> — congressional districts and 2020 urban areas</li>`;

  const optional = (value) => (value === null || value === undefined || value === "" ? null : value);
  const percentOf = (part, total) => (Number(total) ? ` (${((Number(part) / Number(total)) * 100).toFixed(0)}%)` : "");

  window.ParcelStates.register({
    id: "VT",
    name: "Vermont",
    center: [44.0, -72.7],
    zoom: 8,
    brand: {
      eyebrow: "Vermont property insights",
      dataNote: "VCGI standardized Grand List parcel polygons and listed values",
      acknowledgementsHtml,
    },
    tax: {
      description: "Load parcel polygons with positive listed real value and a reported land value. Current tax uses a uniform illustrative placeholder, not certified town rates or parcel tax bills.",
      scopeLabel: "Illustrative property tax (placeholder rate)",
      shortLabel: "Illustrative Property Tax",
      rateNote: `Certified Vermont town tax rates are not configured. Every town currently uses an illustrative ${(PLACEHOLDER_RATE * 1000).toFixed(1)}-mill placeholder; replace it before citing tax-dollar results.`,
    },
    parcels: {
      analysisUrl: PARCELS_URL,
      analysisGeometry: "polygon",
      shapesUrl: PARCELS_URL,
      shapesCarryAttributes: true,
      generalizeShapes: true,
      outFields: "OBJECTID,TOWN,TNAME,PROPTYPE,CAT,RESCODE,HSDECL,HSTED_FLV,NRES_FLV,LAND_LV,IMPRV_LV,REAL_FLV",
      taxableWhere: TAXABLE_WHERE,
      objectIdField: "OBJECTID",
      pageSize: 2000,
    },
    fields: { land: "LAND_LV", improvement: "IMPRV_LV", improvementCount: "IMPRV_LV", total: "REAL_FLV" },
    values: (properties) => ({
      land: numberOrNull(properties.LAND_LV),
      improvement: numberOrNull(properties.IMPRV_LV),
      total: numberOrNull(properties.REAL_FLV),
    }),
    jurisdictionGroupBy: "TOWN,TNAME",
    prepare,
    taxJurisdictionDetails,
    sfh: {
      where: "CAT = 'R1' AND IMPRV_LV > 0",
      matches: isSfhProxy,
      definition: "Proxy only: CAT = R1 with positive listed improvements. Vermont's statewide parcel layer does not verify detached single-family building type.",
    },
    propertyTypes: PROPERTY_TYPES,
    occupancy: {
      field: "HSDECL",
      groups: [
        { key: "Y", label: "Homestead declared" },
        { key: "N", label: "No homestead declaration" },
        { key: "", label: "Not reported" },
      ],
      definition: "HSDECL reports whether a homestead was declared (Y/N); this is not treated as verified owner occupancy.",
    },
    geographies: {
      stateSenate: districtGeography("Vermont State Senate districts (2022 reapportionment)", SENATE_URL, "DISTRICT", "VT Senate"),
      stateHouse: districtGeography("Vermont State House districts (2022 reapportionment)", HOUSE_URL, "DISTRICT", "VT House"),
      congressional: {
        label: "U.S. congressional districts (119th Congress; 2026 Census vintage)",
        choiceLabel: "District",
        load: (signal) => loadArcgisGeography({
          serviceUrl: `${TIGER_LEGISLATIVE}/4`,
          where: "STATE = '50'",
          outFields: "CD119,STATE,NAME",
          maxAllowableOffset: DISTRICT_OFFSET,
          value: (properties) => properties.CD119,
          label: (properties, value) => `U.S. - ${value}`,
        }, signal),
      },
      county: {
        label: "Counties",
        choiceLabel: "County",
        load: (signal) => loadArcgisGeography({
          serviceUrl: COUNTIES_URL,
          outFields: "CNTY,CNTYNAME,CNTYGEOID",
          maxAllowableOffset: AREA_OFFSET,
          value: (properties) => properties.CNTYGEOID,
          label: (properties) => `${titleCase(properties.CNTYNAME)} County`,
          county: (properties) => `${titleCase(properties.CNTYNAME)} County`,
        }, signal),
      },
      municipality: {
        label: "Towns and cities",
        choiceLabel: "Town or city",
        verifyAttributeFilter: true,
        load: async (signal) => {
          const townCountyByName = await loadTownCountyMap(signal);
          return loadArcgisGeography({
            serviceUrl: TOWNS_URL,
            outFields: "TOWNNAME,TOWNNAMEMC,CNTY,TOWNGEOID",
            maxAllowableOffset: AREA_OFFSET,
            value: (properties) => properties.TOWNGEOID,
            label: (properties) => {
              const county = townCountyByName.get(String(properties.TOWNNAME || "").trim().toUpperCase());
              return `${titleCase(properties.TOWNNAMEMC || properties.TOWNNAME)}${county ? ` (${titleCase(county)} County)` : ""}`;
            },
            county: (properties) => {
              const county = townCountyByName.get(String(properties.TOWNNAME || "").trim().toUpperCase());
              return county ? `${titleCase(county)} County` : null;
            },
          }, signal);
        },
        attributeFilter: (feature) => {
          const town = String(feature.properties.raw.TOWNNAME || "").trim();
          return town ? `TOWN = ${sqlString(town)}` : null;
        },
      },
    },
    geographyOrder: ["stateSenate", "stateHouse", "congressional", "county", "municipality"],
    defaultGeography: "stateHouse",
    exportDistricts: [
      { type: "stateSenate", header: "STATE_SENATE_DISTRICT", description: "2022 Vermont State Senate district containing the parcel centroid." },
      { type: "stateHouse", header: "STATE_HOUSE_DISTRICT", description: "2022 Vermont State House district containing the parcel centroid." },
      { type: "congressional", header: "CONGRESSIONAL_DISTRICT", description: "119th Congress U.S. district containing the parcel centroid." },
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
      title: (properties) => optional(properties.TNAME) || optional(properties.TOWN) || "Selected parcel",
      sortKey: (properties) => [properties.TNAME, properties.TOWN, properties.OBJECTID],
      rows: (properties, { formatCurrency }) => [
        ["Grand List town", optional(properties.TNAME) || optional(properties.TOWN)],
        ["Parcel record type", optional(properties.PROPTYPE)],
        ["Grand List category", optional(properties.CAT)],
        ["Resident ownership code", optional(properties.RESCODE)],
        ["Homestead declared", optional(properties.HSDECL)],
        ["Land listed value", `${formatCurrency(properties.LAND_LV)}${percentOf(properties.LAND_LV, properties.REAL_FLV)}`],
        ["Improvement listed value", `${formatCurrency(properties.IMPRV_LV)}${percentOf(properties.IMPRV_LV, properties.REAL_FLV)}`],
        ["Full listed real value", `${formatCurrency(properties.REAL_FLV)}${Number(properties.REAL_FLV) ? " (100%)" : ""}`],
        ["Homestead full listed value", optional(properties.HSTED_FLV) === null ? null : formatCurrency(properties.HSTED_FLV)],
        ["Non-residential full listed value", optional(properties.NRES_FLV) === null ? null : formatCurrency(properties.NRES_FLV)],
      ],
    },
    csv: {
      headers: ["OBJECTID", "TOWN", "TNAME", "PROPTYPE", "CAT", "RESCODE", "HSDECL", "HSTED_FLV", "NRES_FLV", "LAND_LV", "IMPRV_LV", "REAL_FLV"],
      row: (properties) => [
        properties.OBJECTID, properties.TOWN, properties.TNAME, properties.PROPTYPE, properties.CAT, properties.RESCODE, properties.HSDECL,
        numberOrNull(properties.HSTED_FLV), numberOrNull(properties.NRES_FLV), numberOrNull(properties.LAND_LV),
        numberOrNull(properties.IMPRV_LV), numberOrNull(properties.REAL_FLV),
      ],
    },
    report: {
      title: "PARCEL ANALYSIS - VERMONT - SPLIT-RATE PROPERTY TAX SUMMARY",
      accountNoun: "parcel records",
      unitDescription: "Each record is a geometry-bearing VCGI standardized Grand List parcel feature; parcel polygons are simplified for display and geography membership uses parcel centroids.",
      caveats: [
        `Certified Vermont town tax rates are not configured; current tax applies an illustrative ${(PLACEHOLDER_RATE * 1000).toFixed(1)}-mill placeholder to Full Listed Real Value. These are not tax bills or official tax estimates.`,
        "The source reports Grand List listed values, not verified market values or a uniform taxable-value base. Positive listed value is a data filter, not a legal determination of taxability; exemptions, credits, and local levies are not modeled.",
        "VCGI warns that multiple Grand List records can produce identical stacked parcel polygons (including parcels, buildings, and mobile homes). Each source record is modeled separately, so overlapping records may represent distinct accounts and can affect summed totals.",
        "Property classes are proxies: CAT = F is treated as a farm-category proxy and CAT = R1 with positive improvements is the residential/SFH benchmark. These are not legal agricultural exemptions or verified detached-home classifications.",
        "HSDECL is a reported homestead declaration, not proof of owner occupancy. Vermont parcel features do not expose a county field; town codes are mapped to VCGI BNDHASH county boundaries for reporting.",
        "VCGI BNDHASH boundaries are best-available general mapping boundaries and are not legally definitive. Hosted FeatureServer polygons have no low-zoom map image and are drawn at zoom 14+.",
      ],
      rateDefinition: "Rates are shown as a percentage of source-reported Full Listed Real Value ($ per $100). Current tax is an illustrative statewide placeholder, not a certified town rate or actual bill.",
      sfhNotes: "Benchmark proxy: positive IMPRV_LV and CAT = R1. The source category does not verify detached single-family building type.",
      sourceLines: [`VCGI standardized Vermont parcel layer: ${PARCELS_URL}`, `VCGI BNDHASH town boundaries: ${TOWNS_URL}`, `VCGI BNDHASH county boundaries: ${COUNTIES_URL}`],
      csvColumnNotes: [
        "OBJECTID, TOWN, TNAME: source feature ID and Grand List town identifiers/names; the parcel layer does not carry a county field.",
        "PROPTYPE, CAT, RESCODE, HSDECL: source record type, real-estate category, resident-ownership code, and homestead-declaration indicator; category and occupancy interpretations are proxies.",
        "LAND_LV, IMPRV_LV, REAL_FLV: listed land, improvement, and full real values used in the model; HSTED_FLV and NRES_FLV are additional full-value components and are not added again.",
      ],
    },
  });
})();

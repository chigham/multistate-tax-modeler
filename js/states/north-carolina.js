"use strict";

// North Carolina: NC OneMap publishes matching parcel point and polygon layers with
// the same assessment attributes. Points drive statistics and membership; shapes are
// joined by state-county FIPS plus local parcel number (pattern C).
(() => {
  const SERVICE_ROOT = "https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/MapServer";
  const POINTS_URL = `${SERVICE_ROOT}/0`;
  const SHAPES_URL = `${SERVICE_ROOT}/1`;
  const TIGER_LEGISLATIVE = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Legislative/MapServer";
  const TIGER_COUNTIES = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/55";
  const TIGER_PLACES = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/25";
  const TAXABLE_WHERE = "parval > 0 AND landval IS NOT NULL";
  const DISTRICT_OFFSET = 0.00003;
  const AREA_OFFSET = 0.0002;

  const USE_FIELDS = ["parusedesc", "parusedsc2"];
  const LIKE_TOKENS = ["SINGLE FAMILY", "SINGLE-FAMILY", "SINGLEFAMILY", "SINGLFAM", "SFR", "SFD", "ONE FAMILY", "ONE-FAMILY"];
  const AGRICULTURAL_TOKENS = ["AGRICULT", "FARMLAND", "FARM USE", "FARMING", "CROPLAND", "TIMBER", "FOREST", "PASTURE", "ORCHARD"];
  const sqlLikeAny = (fields, tokens) => `(${fields.map((field) => `(${field} IS NOT NULL AND (${tokens.map((token) => `UPPER(${field}) LIKE '%${token}%'`).join(" OR ")}))`).join(" OR ")})`;
  const AGRICULTURAL_WHERE = sqlLikeAny(USE_FIELDS, AGRICULTURAL_TOKENS);
  const NOT_AGRICULTURAL = `NOT ${AGRICULTURAL_WHERE}`;
  const SFH_TERMS = sqlLikeAny(USE_FIELDS, LIKE_TOKENS);
  const NOT_TOWNHOUSE_WHERE = USE_FIELDS.map((field) => `(${field} IS NULL OR (UPPER(${field}) NOT LIKE '%TOWN HOUSE%' AND UPPER(${field}) NOT LIKE '%TOWNHOUSE%'))`).join(" AND ");
  const SFH_USE_WHERE = `(${SFH_TERMS} AND ${NOT_TOWNHOUSE_WHERE})`;
  const IMPROVED = "improvval > 0";
  const SFH_WHERE = `${IMPROVED} AND ${NOT_AGRICULTURAL} AND ${SFH_USE_WHERE}`;

  const useText = (properties) => USE_FIELDS.map((field) => String(properties[field] || "")).join(" ").toUpperCase();
  const matchesTokens = (properties, tokens) => {
    const text = useText(properties);
    return tokens.some((token) => text.includes(token));
  };
  const isAgricultural = (properties) => matchesTokens(properties, AGRICULTURAL_TOKENS);
  const isImproved = (properties) => Number(properties.improvval) > 0;
  const isSfh = (properties) => {
    const text = useText(properties);
    return isImproved(properties)
      && !isAgricultural(properties)
      && LIKE_TOKENS.some((token) => text.includes(token))
      && !/TOWN[ -]?HOUSE|TOWNHOUSE/.test(text);
  };

  const PROPERTY_TYPES = [
    {
      key: "agricultural",
      label: "Agricultural / forest (text proxy)",
      definition: "County-provided use descriptions containing agricultural, farm, crop, timber, forest, pasture, or orchard terms. County coding is not standardized, so this proxy can miss land or include mixed uses.",
      where: AGRICULTURAL_WHERE,
      matches: ({ properties }) => isAgricultural(properties),
    },
    {
      key: "vacant",
      label: "Vacant / unimproved land",
      definition: "All other parcels with no reported improvement value.",
      where: `${NOT_AGRICULTURAL} AND (improvval IS NULL OR improvval <= 0)`,
      matches: ({ properties, improved }) => !isAgricultural(properties) && !improved,
    },
    {
      key: "sfh",
      label: "Single-family residential (text proxy)",
      definition: "Improved parcels whose county-provided use description contains a single-family/SFR/SFD term, excluding descriptions that identify townhouses. County descriptions vary and are not a standardized statewide building class.",
      where: SFH_WHERE,
      matches: ({ properties }) => isSfh(properties),
    },
    {
      key: "other",
      label: "Other improved property",
      definition: "All remaining improved parcels, including residential types not identified by the county-provided single-family text rule.",
      where: `${IMPROVED} AND ${NOT_AGRICULTURAL} AND NOT ${SFH_USE_WHERE}`,
      matches: ({ properties, improved }) => !isAgricultural(properties) && improved && !isSfh(properties),
    },
  ];

  // Placeholder only: replace with certified county / municipal rates before using tax estimates.
  const PLACEHOLDER_COUNTY_RATE = 0.0065;
  function taxJurisdictionDetails(properties) {
    const name = String(properties.cntyname || "").trim();
    const county = name ? `${name} County` : "Unknown county";
    return { county, municipality: null, rate: name ? PLACEHOLDER_COUNTY_RATE : null, jurisdiction: county };
  }

  const districtGeography = (label, layerId, field, prefix) => ({
    label,
    choiceLabel: "District",
    load: (signal) => loadArcgisGeography({
      serviceUrl: `${TIGER_LEGISLATIVE}/${layerId}`,
      where: "STATE = '37'",
      outFields: `${field},STATE`,
      maxAllowableOffset: DISTRICT_OFFSET,
      value: (properties) => properties[field],
      label: (properties, value) => `${prefix} - ${value}`,
    }, signal),
  });

  const parcelKey = (properties, kind) => {
    const parcelNumber = String(properties.parno || "").trim();
    const countyFips = String(properties.stcntyfips || "").trim();
    return parcelNumber && countyFips
      ? `${countyFips}|${parcelNumber}`
      : `${kind}:${properties.objectid ?? "missing-id"}`;
  };

  const acknowledgementsHtml = `
    <li><a href="${POINTS_URL}" target="_blank" rel="noopener">NC OneMap Integrated Cadastral Data Exchange</a> — statewide parcel points, polygons, source-reported values, and county-submitted characteristics</li>
    <li><a href="https://tigerweb.geo.census.gov/" target="_blank" rel="noopener">U.S. Census Bureau TIGERweb</a> — January 2026 congressional and state legislative districts; 2020 counties and incorporated places; 2020 urban areas</li>`;

  const optional = (value) => (value === null || value === undefined || value === "" ? null : value);
  const percentOf = (part, total) => (Number(total) ? ` (${((Number(part) / Number(total)) * 100).toFixed(0)}%)` : "");
  const urbanCache = new Map();

  window.ParcelStates.register({
    id: "NC",
    name: "North Carolina",
    center: [35.55, -79.4],
    zoom: 7,
    brand: {
      eyebrow: "North Carolina property insights",
      dataNote: "Parcels provided by NC OneMap and county data producers",
      acknowledgementsHtml,
    },
    tax: {
      description: "Load North Carolina parcels with positive reported parcel value and a reported land value. Tax-dollar estimates use a statewide placeholder rate, not certified county or municipal rates.",
      scopeLabel: "Illustrative county property tax (placeholder rate)",
      shortLabel: "Illustrative Property Tax",
      rateNote: `Certified North Carolina jurisdictional rates are not configured. Every county currently uses an illustrative ${(PLACEHOLDER_COUNTY_RATE * 1000).toFixed(1)}-mill placeholder; replace it before citing tax-dollar results.`,
    },
    parcels: {
      analysisUrl: POINTS_URL,
      analysisGeometry: "point",
      shapesUrl: SHAPES_URL,
      shapeWhere: "parno IS NOT NULL AND stcntyfips IS NOT NULL AND parval > 0",
      shapeOutFields: "objectid,parno,stcntyfips",
      shapeJoin: {
        shapeKey: (properties) => parcelKey(properties, "shape"),
        pointKey: (properties) => parcelKey(properties, "point"),
      },
      exportMapUrl: SERVICE_ROOT,
      exportLayerId: 1,
      generalizeShapes: true,
      outFields: "objectid,parno,altparno,landval,improvval,parval,parvaltype,siteadd,scity,szip,gisacres,struct,multistruc,structno,structyear,parusecode,parusedesc,parusedsc2,parusecd2,owntype,cntyname,cntyfips,stfips,stcntyfips,sourceagnt,transfdate,presentval",
      taxableWhere: TAXABLE_WHERE,
      objectIdField: "objectid",
      pageSize: 5000,
      pointPageSize: 5000,
      percentileExpressions: false,
    },
    fields: { land: "landval", improvement: "improvval", improvementCount: "improvval", total: "parval" },
    values: (properties) => ({
      land: Number(properties.landval),
      improvement: properties.improvval === null || properties.improvval === undefined ? null : Number(properties.improvval),
      total: Number(properties.parval),
    }),
    jurisdictionGroupBy: "cntyname",
    taxJurisdictionDetails,
    sfh: {
      where: SFH_WHERE,
      matches: isSfh,
      definition: "County-provided use-description proxy for improved single-family/SFR/SFD parcels. Use descriptions are heterogeneous and do not provide a normalized statewide building class.",
    },
    propertyTypes: PROPERTY_TYPES,
    occupancy: {
      groups: [{ key: "", label: "Not reported" }],
      definition: "The statewide parcel service does not provide an owner-occupancy field.",
    },
    geographies: {
      stateSenate: districtGeography("North Carolina State Senate districts (2024; 2026 Census vintage)", 5, "SLDU", "NC Senate"),
      stateHouse: districtGeography("North Carolina House districts (2024; 2026 Census vintage)", 6, "SLDL", "NC House"),
      congressional: districtGeography("U.S. congressional districts (119th Congress; 2026 Census vintage)", 4, "CD119", "U.S."),
      county: {
        label: "Counties",
        choiceLabel: "County",
        verifyAttributeFilter: true,
        load: (signal) => loadArcgisGeography({
          serviceUrl: TIGER_COUNTIES,
          where: "STATE = '37'",
          outFields: "NAME,STATE,GEOID",
          maxAllowableOffset: AREA_OFFSET,
          value: (properties) => properties.GEOID,
          label: (properties) => properties.NAME,
          county: (properties) => properties.NAME,
        }, signal),
        attributeFilter: (feature) => {
          const name = String(feature.properties.raw.NAME || "").replace(/\s+County$/i, "").trim();
          return name ? `cntyname = ${sqlString(name)}` : null;
        },
      },
      municipality: {
        label: "Incorporated places",
        choiceLabel: "Municipality",
        load: (signal) => loadArcgisGeography({
          serviceUrl: TIGER_PLACES,
          where: "STATE = '37'",
          outFields: "BASENAME,GEOID,STATE",
          maxAllowableOffset: AREA_OFFSET,
          value: (properties) => properties.GEOID,
          label: (properties) => properties.BASENAME,
        }, signal),
      },
    },
    geographyOrder: ["stateSenate", "stateHouse", "congressional", "county", "municipality"],
    defaultGeography: "stateHouse",
    exportDistricts: [
      { type: "stateSenate", header: "STATE_SENATE_DISTRICT", description: "2024 North Carolina State Senate district containing the parcel point." },
      { type: "stateHouse", header: "STATE_HOUSE_DISTRICT", description: "2024 North Carolina House district containing the parcel point." },
      { type: "congressional", header: "CONGRESSIONAL_DISTRICT", description: "119th Congress U.S. district containing the parcel point." },
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
      title: (properties) => optional(properties.siteadd) || optional(properties.parno) || "Selected parcel",
      sortKey: (properties) => [properties.siteadd, properties.parno],
      rows: (properties, { formatCurrency }) => [
        ["Parcel number", optional(properties.parno)],
        ["Site address", optional(properties.siteadd)],
        ["City / ZIP", [properties.scity, properties.szip].filter(Boolean).join(" ") || null],
        ["County", optional(properties.cntyname)],
        ["Reported value type", optional(properties.parvaltype) || "Not reported"],
        ["Use description", optional(properties.parusedesc) || optional(properties.parusedsc2) || optional(properties.parusecode)],
        ["Land value", `${formatCurrency(properties.landval)}${percentOf(properties.landval, properties.parval)}`],
        ["Improvement value", `${formatCurrency(properties.improvval)}${percentOf(properties.improvval, properties.parval)}`],
        ["Parcel value", `${formatCurrency(properties.parval)}${Number(properties.parval) ? " (100%)" : ""}`],
        ["Acres", Number(properties.gisacres) > 0 ? Number(properties.gisacres).toLocaleString() : null],
        ["Source county", optional(properties.sourceagnt)],
      ],
    },
    csv: {
      headers: [
        "parno", "altparno", "siteadd", "scity", "szip", "cntyname", "cntyfips", "stcntyfips", "parvaltype", "landval", "improvval", "parval",
        "parusecode", "parusedesc", "parusedsc2", "parusecd2", "struct", "multistruc", "structno", "structyear", "gisacres", "owntype", "sourceagnt", "transfdate", "presentval",
      ],
      row: (properties) => [
        properties.parno, properties.altparno, properties.siteadd, properties.scity, properties.szip, properties.cntyname, properties.cntyfips,
        properties.stcntyfips, properties.parvaltype, Number(properties.landval), properties.improvval === null || properties.improvval === undefined ? 0 : Number(properties.improvval),
        Number(properties.parval), properties.parusecode, properties.parusedesc, properties.parusedsc2, properties.parusecd2, properties.struct,
        properties.multistruc, properties.structno, properties.structyear, properties.gisacres, properties.owntype, properties.sourceagnt,
        properties.transfdate, properties.presentval,
      ],
    },
    report: {
      title: "PARCEL ANALYSIS - NORTH CAROLINA - SPLIT-RATE PROPERTY TAX SUMMARY",
      accountNoun: "parcels",
      unitDescription: "Each record is one parcel point in the NC OneMap statewide parcel points layer; parcel outlines are joined by state-county FIPS and local parcel number.",
      caveats: [
        `Certified county and municipal tax rates are not configured; current tax uses an illustrative ${(PLACEHOLDER_COUNTY_RATE * 1000).toFixed(1)}-mill placeholder statewide. Tax-dollar estimates are not actual bills.`,
        "The live parcel service has records in five counties that currently have no parcels with both positive parval and a reported landval: Alleghany, Camden, Chowan, Hoke, and Yancey. Those county selections return no modeled parcels until usable values are published.",
        "The source's parvaltype varies across parcels and counties (including Assessed, Market, Appraised, Taxable, and blank). No equalization or conversion is applied, so statewide value and tax comparisons can mix different valuation bases.",
        "The source has no exemption flag or reported tax bills. The model filters on positive parcel value and land value, but does not calculate the taxable base after exemptions, credits, or special assessments.",
        "County-contributed use descriptions are not standardized. Agricultural and single-family classifications are text-based proxies; owner occupancy is not reported.",
        "Census 2020 incorporated-place and county boundaries are used for those geographies; district boundaries use the Census January 2026 vintage.",
      ],
      rateDefinition: "Rates are percent of source-reported parcel value ($ per $100). Current rate is an illustrative county-level placeholder; the source values may use different bases by county.",
      sfhNotes: "Qualifying benchmark proxy: positive improvement value and county-provided use text containing single-family/SFR/SFD terms, excluding townhouse descriptions. This is not a standardized statewide SFH classification.",
      sourceLines: [`NC OneMap parcel points: ${POINTS_URL}`, `NC OneMap parcel polygons: ${SHAPES_URL}`],
      csvColumnNotes: [
        "parno, altparno, stcntyfips: local and alternate parcel identifiers and state-county FIPS; polygons are joined on stcntyfips + parno.",
        "siteadd, scity, szip, cntyname, cntyfips, sourceagnt: site location, county, and contributing county source.",
        "landval, improvval, parval: source-reported land, improvement, and total parcel values. parvaltype identifies the reported value basis and must be considered when comparing counties.",
        "parusecode, parusedesc, parusedsc2, parusecd2: county-provided land-use codes and descriptions; struct fields are selected structure characteristics.",
      ],
    },
  });
})();

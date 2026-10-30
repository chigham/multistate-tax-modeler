"use strict";

// Washington State Parcels Project: statewide normalized parcel polygons carry
// market land/building values and DOR land-use codes. Polygons drive analysis.
(() => {
  const PARCELS_URL = "https://services.arcgis.com/jsIt88o09Q0r1j8h/arcgis/rest/services/Current_Parcels/FeatureServer/0";
  const TIGER_LEGISLATIVE = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Legislative/MapServer";
  const TIGER_COUNTIES = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/55";
  const TIGER_PLACES = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/25";
  const TAXABLE_WHERE = "FIPS_NR IS NOT NULL AND FIPS_NR <> '' AND VALUE_LAND IS NOT NULL AND VALUE_BLDG IS NOT NULL AND VALUE_LAND + VALUE_BLDG > 0";
  const DISTRICT_OFFSET = 0.00003;
  const AREA_OFFSET = 0.0002;

  const COUNTY_NAMES_BY_FIPS = {
    "001": "Adams", "003": "Asotin", "005": "Benton", "007": "Chelan", "009": "Clallam",
    "011": "Clark", "013": "Columbia", "015": "Cowlitz", "017": "Douglas", "019": "Ferry",
    "021": "Franklin", "023": "Garfield", "025": "Grant", "027": "Grays Harbor", "029": "Island",
    "031": "Jefferson", "033": "King", "035": "Kitsap", "037": "Kittitas", "039": "Klickitat",
    "041": "Lewis", "043": "Lincoln", "045": "Mason", "047": "Okanogan", "049": "Pacific",
    "051": "Pend Oreille", "053": "Pierce", "055": "San Juan", "057": "Skagit", "059": "Skamania",
    "061": "Snohomish", "063": "Spokane", "065": "Stevens", "067": "Thurston", "069": "Wahkiakum",
    "071": "Walla Walla", "073": "Whatcom", "075": "Whitman", "077": "Yakima",
  };

  // These DOR codes describe agriculture, current-use open space, and designated forest/timberland.
  const AGRICULTURAL_LAND_USE_CODES = [81, 82, 83, 88, 94, 95];
  const AGRICULTURAL_WHERE = `LANDUSE_CD IN (${AGRICULTURAL_LAND_USE_CODES.join(", ")})`;
  const NOT_AGRICULTURAL = `(LANDUSE_CD IS NULL OR LANDUSE_CD NOT IN (${AGRICULTURAL_LAND_USE_CODES.join(", ")}))`;
  const IMPROVED = "VALUE_BLDG > 0";
  const SFH_WHERE = `${NOT_AGRICULTURAL} AND ${IMPROVED} AND LANDUSE_CD = 11`;

  const landUseCode = (properties) => properties.LANDUSE_CD === null || properties.LANDUSE_CD === undefined
    ? null
    : Number(properties.LANDUSE_CD);
  const isAgricultural = (properties) => AGRICULTURAL_LAND_USE_CODES.includes(landUseCode(properties));
  const isImproved = (properties) => properties.VALUE_BLDG !== null
    && properties.VALUE_BLDG !== undefined
    && Number(properties.VALUE_BLDG) > 0;
  const isSfh = (properties) => !isAgricultural(properties)
    && isImproved(properties)
    && landUseCode(properties) === 11;

  const PROPERTY_TYPES = [
    {
      key: "agricultural",
      label: "Agriculture / resource land (DOR proxy)",
      definition: "Parcels with DOR land-use codes 81, 82, 83, 88, 94, or 95: agriculture, current-use open space, or designated forest/timberland. This is a land-use-code proxy, not a tax-exemption determination.",
      where: AGRICULTURAL_WHERE,
      matches: ({ properties }) => isAgricultural(properties),
    },
    {
      key: "vacant",
      label: "No reported building value",
      definition: "Non-agriculture/resource parcels with VALUE_BLDG at or below zero. This does not establish legal vacancy or tax status.",
      where: `${NOT_AGRICULTURAL} AND VALUE_BLDG <= 0`,
      matches: ({ properties, improved }) => !isAgricultural(properties) && !improved,
    },
    {
      key: "sfh",
      label: "Single-family residential (DOR proxy)",
      definition: "Parcels with positive building value and DOR land-use code 11 (household, single-family units). This is not a building-level or owner-occupancy classification.",
      where: SFH_WHERE,
      matches: ({ properties }) => isSfh(properties),
    },
    {
      key: "other",
      label: "Other improved property",
      definition: "Non-agriculture/resource parcels with positive building value and a land-use code other than 11, including unknown codes.",
      where: `${NOT_AGRICULTURAL} AND ${IMPROVED} AND (LANDUSE_CD IS NULL OR LANDUSE_CD <> 11)`,
      matches: ({ properties, improved }) => !isAgricultural(properties) && improved && landUseCode(properties) !== 11,
    },
  ];

  // Placeholder only: replace with certified county and local rates before using tax estimates.
  const PLACEHOLDER_COUNTY_RATE = 0.0065;
  function taxJurisdictionDetails(properties) {
    const code = String(properties.FIPS_NR || "").trim().padStart(3, "0");
    const countyName = COUNTY_NAMES_BY_FIPS[code] || null;
    const county = countyName ? `${countyName} County` : "Unknown Washington county";
    return { county, municipality: null, rate: countyName ? PLACEHOLDER_COUNTY_RATE : null, jurisdiction: county };
  }

  const districtGeography = (label, layerId, field, prefix) => ({
    label,
    choiceLabel: "District",
    load: (signal) => loadArcgisGeography({
      serviceUrl: `${TIGER_LEGISLATIVE}/${layerId}`,
      where: "STATE = '53'",
      outFields: `${field},STATE`,
      maxAllowableOffset: DISTRICT_OFFSET,
      value: (properties) => properties[field],
      label: (properties, value) => `${prefix} - ${value}`,
    }, signal),
  });

  const acknowledgementsHtml = `
    <li><a href="${PARCELS_URL}" target="_blank" rel="noopener">Washington State Parcels Project</a> — standardized statewide parcel polygons, market land/building values, DOR land-use codes, and assessor links</li>
    <li><a href="https://tigerweb.geo.census.gov/" target="_blank" rel="noopener">U.S. Census Bureau TIGERweb</a> — January 2026 congressional and state legislative districts; 2020 counties, incorporated places, and urban areas</li>`;

  const optional = (value) => (value === null || value === undefined || value === "" ? null : value);
  const percentOf = (part, total) => (Number(total) ? ` (${((Number(part) / Number(total)) * 100).toFixed(0)}%)` : "");
  const urbanCache = new Map();

  window.ParcelStates.register({
    id: "WA",
    name: "Washington",
    center: [47.4, -120.7],
    zoom: 6,
    brand: {
      eyebrow: "Washington property insights",
      dataNote: "Parcels, market values, and land-use codes provided by the Washington State Parcels Project",
      acknowledgementsHtml,
    },
    tax: {
      description: "Load Washington parcels with a positive derived market value (market land plus market building value) and a county identifier. Tax-dollar estimates use a statewide placeholder rate, not certified county or municipal rates.",
      scopeLabel: "Illustrative county property tax (placeholder rate)",
      shortLabel: "Illustrative Property Tax",
      rateNote: `Certified Washington jurisdictional rates are not configured. Every county currently uses an illustrative ${(PLACEHOLDER_COUNTY_RATE * 1000).toFixed(1)}-mill placeholder; replace it before citing tax-dollar results.`,
    },
    parcels: {
      analysisUrl: PARCELS_URL,
      analysisGeometry: "polygon",
      shapesUrl: PARCELS_URL,
      shapesCarryAttributes: true,
      generalizeShapes: true,
      outFields: "OBJECTID,FIPS_NR,COUNTY_NM,PARCEL_ID_NR,ORIG_PARCEL_ID,SITUS_ADDRESS,SUB_ADDRESS,SITUS_CITY_NM,SITUS_ZIP_NR,LANDUSE_CD,ORIG_LANDUSE_CD,VALUE_LAND,VALUE_BLDG,DATA_LINK,GlobalID",
      taxableWhere: TAXABLE_WHERE,
      objectIdField: "OBJECTID",
      pageSize: 2000,
    },
    fields: {
      land: "VALUE_LAND",
      improvement: "VALUE_BLDG",
      improvementCount: "VALUE_BLDG",
      total: "(VALUE_LAND + VALUE_BLDG)",
      totalFromComponents: true,
    },
    values: (properties) => {
      const land = properties.VALUE_LAND === null || properties.VALUE_LAND === undefined ? null : Number(properties.VALUE_LAND);
      const improvement = properties.VALUE_BLDG === null || properties.VALUE_BLDG === undefined ? null : Number(properties.VALUE_BLDG);
      return { land, improvement, total: land === null || improvement === null ? null : land + improvement };
    },
    jurisdictionGroupBy: "FIPS_NR",
    taxJurisdictionDetails,
    sfh: {
      where: SFH_WHERE,
      matches: isSfh,
      definition: "Proxy only: positive VALUE_BLDG and DOR land-use code 11 (household, single-family units).",
    },
    propertyTypes: PROPERTY_TYPES,
    occupancy: {
      groups: [{ key: "", label: "Not reported" }],
      definition: "The statewide parcel service does not provide an owner-occupancy or homestead field.",
    },
    geographies: {
      stateSenate: districtGeography("Washington State Senate districts (2024; 2026 Census vintage)", 5, "SLDU", "WA Senate"),
      stateHouse: districtGeography("Washington State House districts (2024; 2026 Census vintage)", 6, "SLDL", "WA House"),
      congressional: districtGeography("U.S. congressional districts (119th Congress; 2026 Census vintage)", 4, "CD119", "U.S."),
      county: {
        label: "Counties",
        choiceLabel: "County",
        verifyAttributeFilter: true,
        load: (signal) => loadArcgisGeography({
          serviceUrl: TIGER_COUNTIES,
          where: "STATE = '53'",
          outFields: "NAME,STATE,GEOID",
          maxAllowableOffset: AREA_OFFSET,
          value: (properties) => properties.GEOID,
          label: (properties) => properties.NAME,
          county: (properties) => properties.NAME,
        }, signal),
        attributeFilter: (feature) => {
          const geoid = String(feature.properties.raw.GEOID || "");
          const countyFips = geoid.length >= 5 ? geoid.slice(-3) : "";
          return countyFips ? `FIPS_NR = ${sqlString(countyFips)}` : null;
        },
      },
      municipality: {
        label: "Incorporated places",
        choiceLabel: "Municipality",
        load: (signal) => loadArcgisGeography({
          serviceUrl: TIGER_PLACES,
          where: "STATE = '53'",
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
      { type: "stateSenate", header: "STATE_SENATE_DISTRICT", description: "2024 Washington State Senate district containing the parcel centroid." },
      { type: "stateHouse", header: "STATE_HOUSE_DISTRICT", description: "2024 Washington State House district containing the parcel centroid." },
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
      title: (properties) => optional(properties.SITUS_ADDRESS) || optional(properties.PARCEL_ID_NR) || optional(properties.ORIG_PARCEL_ID) || "Selected parcel",
      sortKey: (properties) => [properties.SITUS_ADDRESS, properties.PARCEL_ID_NR],
      rows: (properties, { formatCurrency }) => [
        ["Parcel ID", optional(properties.PARCEL_ID_NR)],
        ["Original parcel ID", optional(properties.ORIG_PARCEL_ID)],
        ["Situs address", [properties.SITUS_ADDRESS, properties.SITUS_CITY_NM, properties.SITUS_ZIP_NR].filter(Boolean).join(", ") || null],
        ["County", taxJurisdictionDetails(properties).county],
        ["DOR land-use code", optional(properties.LANDUSE_CD)],
        ["County land-use code", optional(properties.ORIG_LANDUSE_CD)],
        ["Market land value", `${formatCurrency(properties.VALUE_LAND)}${percentOf(properties.VALUE_LAND, Number(properties.VALUE_LAND) + Number(properties.VALUE_BLDG))}`],
        ["Market building value", `${formatCurrency(properties.VALUE_BLDG)}${percentOf(properties.VALUE_BLDG, Number(properties.VALUE_LAND) + Number(properties.VALUE_BLDG))}`],
        ["Derived total market value", `${formatCurrency(Number(properties.VALUE_LAND) + Number(properties.VALUE_BLDG))} (land + building)`],
      ],
    },
    csv: {
      headers: [
        "FIPS_NR", "COUNTY_NM", "PARCEL_ID_NR", "ORIG_PARCEL_ID", "SITUS_ADDRESS", "SUB_ADDRESS", "SITUS_CITY_NM", "SITUS_ZIP_NR",
        "LANDUSE_CD", "ORIG_LANDUSE_CD", "VALUE_LAND", "VALUE_BLDG", "DERIVED_TOTAL_MARKET_VALUE", "DATA_LINK",
      ],
      row: (properties) => [
        properties.FIPS_NR, properties.COUNTY_NM, properties.PARCEL_ID_NR, properties.ORIG_PARCEL_ID, properties.SITUS_ADDRESS,
        properties.SUB_ADDRESS, properties.SITUS_CITY_NM, properties.SITUS_ZIP_NR, properties.LANDUSE_CD, properties.ORIG_LANDUSE_CD,
        Number(properties.VALUE_LAND), Number(properties.VALUE_BLDG), Number(properties.VALUE_LAND) + Number(properties.VALUE_BLDG), properties.DATA_LINK,
      ],
    },
    report: {
      title: "PARCEL ANALYSIS - WASHINGTON - SPLIT-RATE PROPERTY TAX SUMMARY",
      accountNoun: "parcels",
      unitDescription: "Each record is one polygon in the Washington State Parcels Project statewide parcel layer.",
      caveats: [
        `Certified county and local tax rates are not configured; current tax uses an illustrative ${(PLACEHOLDER_COUNTY_RATE * 1000).toFixed(1)}-mill placeholder. Tax-dollar estimates are not actual bills.`,
        "The source identifies VALUE_LAND and VALUE_BLDG as market values. Total value is derived as their sum; no assessment equalization, exemption, credit, or taxable-value adjustment is applied.",
        "About 95.0% of statewide parcel records have a positive derived total and a county identifier. Parcels without a county identifier are excluded, and the current feed contains no Asotin County parcel records.",
        "The source does not provide parcel tax bills, an exemption flag, or owner-occupancy/homestead status.",
        "DOR land-use code 11 is used as the single-family proxy. Codes 81, 82, 83, 88, 94, and 95 form an agriculture/resource-land proxy; these categories do not determine legal tax exemptions.",
        "The polygon FeatureServer has no low-zoom map image; parcel shapes are drawn at zoom 14+. District membership uses returned polygon centroids.",
        "The statewide source covers counties that currently have digital tax parcels; county coverage and data currency can vary.",
      ],
      rateDefinition: "Rates are percent of derived market value (VALUE_LAND + VALUE_BLDG, dollars per $100). Current rate is an illustrative county-level placeholder.",
      sfhNotes: "Qualifying benchmark proxy: positive VALUE_BLDG and Washington DOR land-use code 11 (household, single-family units). This is not a building-level or owner-occupancy classification.",
      sourceLines: [`Washington State Parcels Project: ${PARCELS_URL}`],
      csvColumnNotes: [
        "FIPS_NR: three-digit county FIPS code used for county attribution; COUNTY_NM is retained as provided by the service.",
        "PARCEL_ID_NR, ORIG_PARCEL_ID: normalized statewide and source parcel identifiers.",
        "VALUE_LAND and VALUE_BLDG: source-reported market values; DERIVED_TOTAL_MARKET_VALUE is their sum, not a certified taxable value.",
        "LANDUSE_CD: standardized Washington Department of Revenue two-digit use code; ORIG_LANDUSE_CD preserves the county-specific source code.",
        "DATA_LINK: source assessor parcel page, when supplied.",
      ],
    },
  });
})();
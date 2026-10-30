"use strict";

// Utah: county-published LIR feature layers carry parcel polygons and roll
// attributes, so the state uses pattern B across multiple analysis services.
(() => {
  const REST_ROOT = "https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services";
  const PARCEL_CATALOG = "https://gis.utah.gov/products/sgid/cadastre/parcels/";
  const COUNTY_BOUNDARIES_URL = `${REST_ROOT}/UtahCountyBoundaries/FeatureServer/0`;
  const MUNICIPAL_BOUNDARIES_URL = `${REST_ROOT}/UtahMunicipalBoundaries/FeatureServer/0`;
  const HOUSE_URL = `${REST_ROOT}/UtahHouseDistricts2022to2032/FeatureServer/0`;
  const SENATE_URL = `${REST_ROOT}/UtahSenateDistricts2022to2032/FeatureServer/0`;
  const CONGRESSIONAL_URL = `${REST_ROOT}/political_us_congress_districts_2026_to_2032/FeatureServer/0`;
  const TAX_AREAS_URL = `${REST_ROOT}/TaxAreas2024/FeatureServer/0`;
  const TAX_ENTITIES_URL = `${REST_ROOT}/economy_tax_entities_2025/FeatureServer/0`;
  const DISTRICT_OFFSET = 0.00003;
  const AREA_OFFSET = 0.0002;
  const PLACEHOLDER_RATE = 0.0065;
  const TAXABLE_WHERE = "TOTAL_MKT_VALUE > 0 AND LAND_MKT_VALUE IS NOT NULL AND LAND_MKT_VALUE >= 0 AND LAND_MKT_VALUE <= TOTAL_MKT_VALUE";
  const COUNTY_SOURCES = [
    { id: "1", name: "Beaver", layer: "Beaver" },
    { id: "2", name: "Box Elder", layer: "BoxElder" },
    { id: "3", name: "Cache", layer: "Cache" },
    { id: "4", name: "Carbon", layer: "Carbon" },
    { id: "5", name: "Daggett", layer: "Daggett" },
    { id: "6", name: "Davis", layer: "Davis" },
    { id: "7", name: "Duchesne", layer: "Duchesne" },
    { id: "8", name: "Emery", layer: "Emery" },
    { id: "9", name: "Garfield", layer: "Garfield" },
    { id: "10", name: "Grand", layer: "Grand" },
    { id: "11", name: "Iron", layer: "Iron" },
    { id: "12", name: "Juab", layer: "Juab" },
    { id: "13", name: "Kane", layer: "Kane" },
    { id: "14", name: "Millard", layer: "Millard" },
    { id: "15", name: "Morgan", layer: "Morgan" },
    { id: "16", name: "Piute", layer: "Piute" },
    { id: "17", name: "Rich", layer: "Rich" },
    { id: "18", name: "Salt Lake", layer: "SaltLake" },
    { id: "19", name: "San Juan", layer: "SanJuan" },
    { id: "20", name: "Sanpete", layer: "Sanpete" },
    { id: "21", name: "Sevier", layer: "Sevier" },
    { id: "22", name: "Summit", layer: "Summit" },
    { id: "23", name: "Tooele", layer: "Tooele" },
    { id: "24", name: "Uintah", layer: "Uintah" },
    { id: "25", name: "Utah", layer: "Utah" },
    { id: "26", name: "Wasatch", layer: "Wasatch" },
    { id: "27", name: "Washington", layer: "Washington" },
    { id: "28", name: "Wayne", layer: "Wayne" },
    { id: "29", name: "Weber", layer: "Weber" },
  ];
  const ANALYSIS_SOURCES = COUNTY_SOURCES.map((county) => ({
    key: county.id,
    countyId: county.id,
    countyName: `${county.name} County`,
    url: `${REST_ROOT}/Parcels_${county.layer}_LIR/FeatureServer/0`,
  }));
  const OUT_FIELDS = [
    "OBJECTID", "COUNTY_NAME", "COUNTY_ID", "CURRENT_ASOF", "PARCEL_ID", "SERIAL_NUM", "PARCEL_ADD", "PARCEL_CITY",
    "TAXEXEMPT_TYPE", "TAX_DISTRICT", "TOTAL_MKT_VALUE", "LAND_MKT_VALUE", "PARCEL_ACRES", "PROP_CLASS",
    "PRIMARY_RES", "HOUSE_CNT", "BLDG_SQFT",
  ].join(",");

  const hasValue = (value) => value !== null && value !== undefined && value !== "";
  const numberOrNull = (value) => hasValue(value) && Number.isFinite(Number(value)) ? Number(value) : null;
  const optional = (value) => (hasValue(value) ? value : null);
  const percentOf = (part, total) => (Number(total) ? ` (${((Number(part) / Number(total)) * 100).toFixed(0)}%)` : "");
  const normalizedClass = (properties) => String(properties.PROP_CLASS || "").trim().toUpperCase();
  const isAgricultural = (properties) => normalizedClass(properties).includes("AGRICULT");
  const isResidentialClass = (properties) => {
    const value = normalizedClass(properties);
    return value === "RESIDENTIAL" || value.includes("SINGLE FAMILY");
  };
  const isImproved = (properties) => {
    const total = numberOrNull(properties.TOTAL_MKT_VALUE);
    const land = numberOrNull(properties.LAND_MKT_VALUE);
    return total !== null && land !== null && total > land;
  };
  const isSfhProxy = (properties) => isResidentialClass(properties)
    && String(properties.PRIMARY_RES || "").trim().toUpperCase() === "Y"
    && Number(properties.HOUSE_CNT) === 1
    && isImproved(properties);

  const AGRICULTURAL_WHERE = "UPPER(PROP_CLASS) LIKE '%AGRICULT%'";
  const NON_AGRICULTURAL_WHERE = "(PROP_CLASS IS NULL OR UPPER(PROP_CLASS) NOT LIKE '%AGRICULT%')";
  const RESIDENTIAL_CLASS_WHERE = "(UPPER(PROP_CLASS) = 'RESIDENTIAL' OR UPPER(PROP_CLASS) LIKE '%SINGLE FAMILY%')";
  const SFH_CLASS_WHERE = `${RESIDENTIAL_CLASS_WHERE} AND PRIMARY_RES = 'Y' AND HOUSE_CNT = 1`;
  const NON_SFH_WHERE = "(PROP_CLASS IS NULL OR (UPPER(PROP_CLASS) <> 'RESIDENTIAL' AND UPPER(PROP_CLASS) NOT LIKE '%SINGLE FAMILY%') OR PRIMARY_RES IS NULL OR PRIMARY_RES <> 'Y' OR HOUSE_CNT IS NULL OR HOUSE_CNT <> 1)";

  const PROPERTY_TYPES = [
    {
      key: "agricultural",
      label: "Agricultural class proxy",
      definition: "PROP_CLASS labels containing 'Agricultural' are treated as an agricultural proxy; Greenbelt and other county-specific classifications are not inferred as agricultural.",
      where: AGRICULTURAL_WHERE,
      matches: ({ properties }) => isAgricultural(properties),
    },
    {
      key: "vacant",
      label: "No reported improvement value",
      definition: "Non-agricultural records whose reported land market value equals total market value.",
      where: `${NON_AGRICULTURAL_WHERE} AND LAND_MKT_VALUE >= TOTAL_MKT_VALUE`,
      matches: ({ properties, improved }) => !isAgricultural(properties) && !improved,
    },
    {
      key: "sfh",
      label: "Primary residential, one-house proxy",
      definition: "Residential or Single Family class, PRIMARY_RES = Y, HOUSE_CNT = 1, and positive derived improvements. This is a detached-home proxy, not a verified building-type determination.",
      where: `${NON_AGRICULTURAL_WHERE} AND ${SFH_CLASS_WHERE} AND TOTAL_MKT_VALUE > LAND_MKT_VALUE`,
      matches: ({ properties }) => !isAgricultural(properties) && isSfhProxy(properties),
    },
    {
      key: "other",
      label: "Other improved property",
      definition: "Remaining non-agricultural records with positive derived improvements.",
      where: `${NON_AGRICULTURAL_WHERE} AND TOTAL_MKT_VALUE > LAND_MKT_VALUE AND ${NON_SFH_WHERE}`,
      matches: ({ properties, improved }) => !isAgricultural(properties) && improved && !isSfhProxy(properties),
    },
  ];

  let countyNameMapPromise = null;
  async function loadCountyNameMap(signal) {
    if (!countyNameMapPromise) {
      countyNameMapPromise = queryAllJson(COUNTY_BOUNDARIES_URL, {
        where: "1=1",
        outFields: "COUNTYNBR,NAME",
        returnGeometry: "false",
        orderByFields: "COUNTYNBR",
      }, signal, 2000).then((features) => new Map(features.map(({ attributes = {} }) => [
        String(Number(attributes.COUNTYNBR)), `${titleCase(String(attributes.NAME || "").trim())} County`,
      ]))).catch((error) => {
        countyNameMapPromise = null;
        throw error;
      });
    }
    return countyNameMapPromise;
  }

  function taxJurisdictionDetails(properties) {
    const countyId = String(properties.COUNTY_ID || "").trim();
    const sourceCounty = String(properties.COUNTY_NAME || "").trim();
    const fallbackCounty = COUNTY_SOURCES.find((item) => item.id === countyId)?.name;
    const county = sourceCounty || (fallbackCounty ? `${fallbackCounty} County` : "Utah");
    return {
      county,
      municipality: null,
      rate: countyId || sourceCounty ? PLACEHOLDER_RATE : null,
      jurisdiction: county,
    };
  }

  const districtGeography = (label, serviceUrl, field, prefix) => ({
    label,
    choiceLabel: "District",
    load: (signal) => loadArcgisGeography({
      serviceUrl,
      outFields: field,
      maxAllowableOffset: DISTRICT_OFFSET,
      value: (properties) => properties[field],
      label: (_properties, value) => `${prefix} - ${value}`,
    }, signal),
  });

  const urbanCache = new Map();
  const sourceLinks = ANALYSIS_SOURCES.map((source) =>
    `<li><a href="${source.url}" target="_blank" rel="noopener">${source.countyName} LIR parcels</a></li>`).join("");
  const acknowledgementsHtml = `
    <li><a href="${PARCEL_CATALOG}" target="_blank" rel="noopener">Utah Geospatial Resource Center (UGRC)</a> — official parcel catalog and county Land Information Record (LIR) descriptions</li>
    ${sourceLinks}
    <li><a href="${COUNTY_BOUNDARIES_URL}" target="_blank" rel="noopener">UGRC county boundaries</a> and <a href="${MUNICIPAL_BOUNDARIES_URL}" target="_blank" rel="noopener">municipal boundaries</a></li>
    <li><a href="${HOUSE_URL}" target="_blank" rel="noopener">Utah House districts 2022–2032</a>, <a href="${SENATE_URL}" target="_blank" rel="noopener">Senate districts 2022–2032</a>, and <a href="${CONGRESSIONAL_URL}" target="_blank" rel="noopener">U.S. congressional districts 2026–2032</a></li>
    <li><a href="${TAX_AREAS_URL}" target="_blank" rel="noopener">Utah Tax Areas 2024</a> and <a href="${TAX_ENTITIES_URL}" target="_blank" rel="noopener">Tax Entities 2025</a> were evaluated; the tax-area Rate field is null and entity rates are not combined into parcel rates in this model</li>
    <li><a href="https://tigerweb.geo.census.gov/" target="_blank" rel="noopener">U.S. Census Bureau TIGERweb</a> — 2020 urban areas</li>`;

  window.ParcelStates.register({
    id: "UT",
    name: "Utah",
    center: [39.5, -111.6],
    zoom: 6,
    brand: {
      eyebrow: "Utah property insights",
      dataNote: "UGRC county LIR parcel polygons and reported market values",
      acknowledgementsHtml,
    },
    tax: {
      description: "The county LIR feeds report market values, not verified taxable assessments or parcel tax bills. Current tax and split-rate results use an illustrative statewide placeholder rate, not certified Utah rates.",
      scopeLabel: "Illustrative property tax (placeholder rate)",
      shortLabel: "Illustrative Property Tax",
      rateNote: `Certified composite Utah property-tax rates are not configured. Every county uses an illustrative ${(PLACEHOLDER_RATE * 1000).toFixed(1)}-mill placeholder applied to source-reported market value; the 2024 Tax Areas Rate field is null, and 2025 entity rates are not a parcel-level composite schedule. Replace the placeholder before citing tax-dollar results.`,
    },
    parcels: {
      analysisUrl: ANALYSIS_SOURCES[0].url,
      analysisSources: ANALYSIS_SOURCES,
      analysisGeometry: "polygon",
      shapesUrl: ANALYSIS_SOURCES[0].url,
      shapesCarryAttributes: true,
      generalizeShapes: true,
      outFields: OUT_FIELDS,
      taxableWhere: TAXABLE_WHERE,
      objectIdField: "OBJECTID",
      pageSize: 2000,
      downloadBatchSize: 200,
      percentileExpressions: false,
    },
    fields: {
      land: "LAND_MKT_VALUE",
      improvement: "TOTAL_MKT_VALUE - LAND_MKT_VALUE",
      improvementCount: "LAND_MKT_VALUE",
      total: "TOTAL_MKT_VALUE",
      improvementFromTotalMinusLand: true,
    },
    values: (properties) => {
      const land = numberOrNull(properties.LAND_MKT_VALUE);
      const total = numberOrNull(properties.TOTAL_MKT_VALUE);
      return {
        land,
        improvement: land !== null && total !== null ? total - land : null,
        total,
      };
    },
    jurisdictionGroupBy: "COUNTY_ID,COUNTY_NAME",
    taxJurisdictionDetails,
    sfh: {
      where: `${SFH_CLASS_WHERE} AND TOTAL_MKT_VALUE > LAND_MKT_VALUE`,
      matches: (properties) => isSfhProxy(properties),
      definition: "Proxy only: residential/single-family class, a primary-residence indicator, one reported house, and positive derived improvements. County-level class conventions vary and do not verify detached homes.",
    },
    propertyTypes: PROPERTY_TYPES,
    occupancy: {
      field: "PRIMARY_RES",
      groups: [
        { key: "Y", label: "Primary residence indicated" },
        { key: "N", label: "Not marked primary residence" },
        { key: "", label: "Not reported or unrecognized code" },
      ],
      definition: "PRIMARY_RES is the county LIR primary-residence indicator, not independently verified owner occupancy or a complete taxable-value adjustment.",
    },
    geographies: {
      stateSenate: districtGeography("Utah State Senate districts (2022–2032)", SENATE_URL, "DIST", "Utah Senate"),
      stateHouse: districtGeography("Utah State House districts (2022–2032)", HOUSE_URL, "DIST", "Utah House"),
      congressional: districtGeography("U.S. congressional districts (2026–2032 court-adopted plan)", CONGRESSIONAL_URL, "DISTRICT", "U.S."),
      county: {
        label: "Counties",
        choiceLabel: "County",
        load: (signal) => loadArcgisGeography({
          serviceUrl: COUNTY_BOUNDARIES_URL,
          outFields: "COUNTYNBR,NAME,FIPS_STR",
          maxAllowableOffset: AREA_OFFSET,
          value: (properties) => properties.FIPS_STR || properties.COUNTYNBR,
          label: (properties) => `${titleCase(properties.NAME)} County`,
          county: (properties) => `${titleCase(properties.NAME)} County`,
        }, signal),
        attributeFilter: (feature) => {
          const countyId = String(Number(feature.properties.raw.COUNTYNBR));
          return countyId && countyId !== "NaN" ? `COUNTY_ID = ${sqlString(countyId)}` : null;
        },
      },
      municipality: {
        label: "Utah municipalities",
        choiceLabel: "Municipality",
        load: async (signal) => {
          const countyNames = await loadCountyNameMap(signal);
          return loadArcgisGeography({
            serviceUrl: MUNICIPAL_BOUNDARIES_URL,
            outFields: "OBJECTID,COUNTYNBR,NAME,FIPS,UGRCODE",
            maxAllowableOffset: AREA_OFFSET,
            value: (properties) => `${properties.COUNTYNBR}-${properties.FIPS || properties.UGRCODE || properties.OBJECTID}`,
            label: (properties) => {
              const county = countyNames.get(String(Number(properties.COUNTYNBR)));
              return `${titleCase(properties.NAME)}${county ? ` (${county})` : ""}`;
            },
            county: (properties) => countyNames.get(String(Number(properties.COUNTYNBR))) || null,
          }, signal);
        },
      },
    },
    geographyOrder: ["stateSenate", "stateHouse", "congressional", "county", "municipality"],
    defaultGeography: "stateHouse",
    exportDistricts: [
      { type: "stateSenate", header: "STATE_SENATE_DISTRICT", description: "2022–2032 Utah Senate district containing the parcel centroid." },
      { type: "stateHouse", header: "STATE_HOUSE_DISTRICT", description: "2022–2032 Utah House district containing the parcel centroid." },
      { type: "congressional", header: "CONGRESSIONAL_DISTRICT", description: "2026–2032 U.S. congressional district containing the parcel centroid." },
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
      title: (properties) => optional(properties.PARCEL_ID) || optional(properties.PARCEL_ADD) || "Selected Utah parcel",
      sortKey: (properties) => [properties.COUNTY_NAME, properties.PARCEL_ID, properties.OBJECTID],
      rows: (properties, { formatCurrency }) => [
        ["County", optional(properties.COUNTY_NAME)],
        ["Parcel ID", optional(properties.PARCEL_ID)],
        ["Address", optional(properties.PARCEL_ADD)],
        ["Property class", optional(properties.PROP_CLASS)],
        ["Primary residence indicator", optional(properties.PRIMARY_RES)],
        ["Reported house count", numberOrNull(properties.HOUSE_CNT)],
        ["Tax exemption type", optional(properties.TAXEXEMPT_TYPE)],
        ["Tax district", optional(properties.TAX_DISTRICT)],
        ["Land market value", `${formatCurrency(properties.LAND_MKT_VALUE)}${percentOf(properties.LAND_MKT_VALUE, properties.TOTAL_MKT_VALUE)}`],
        ["Derived improvement market value", `${formatCurrency(numberOrNull(properties.TOTAL_MKT_VALUE) - numberOrNull(properties.LAND_MKT_VALUE))}${percentOf(Number(properties.TOTAL_MKT_VALUE) - Number(properties.LAND_MKT_VALUE), properties.TOTAL_MKT_VALUE)}`],
        ["Total market value", `${formatCurrency(properties.TOTAL_MKT_VALUE)}${Number(properties.TOTAL_MKT_VALUE) ? " (100%)" : ""}`],
        ["LIR current as of", formatDate(properties.CURRENT_ASOF)],
      ],
    },
    csv: {
      headers: ["OBJECTID", "COUNTY_NAME", "COUNTY_ID", "PARCEL_ID", "SERIAL_NUM", "PARCEL_ADD", "PARCEL_CITY", "TAX_DISTRICT", "TAXEXEMPT_TYPE", "PROP_CLASS", "PRIMARY_RES", "HOUSE_CNT", "LAND_MKT_VALUE", "DERIVED_IMPROVEMENT_MKT_VALUE", "TOTAL_MKT_VALUE", "PARCEL_ACRES", "BLDG_SQFT", "CURRENT_ASOF"],
      row: (properties) => [
        properties.OBJECTID, properties.COUNTY_NAME, properties.COUNTY_ID, properties.PARCEL_ID, properties.SERIAL_NUM,
        properties.PARCEL_ADD, properties.PARCEL_CITY, properties.TAX_DISTRICT, properties.TAXEXEMPT_TYPE, properties.PROP_CLASS,
        properties.PRIMARY_RES, numberOrNull(properties.HOUSE_CNT), numberOrNull(properties.LAND_MKT_VALUE),
        numberOrNull(properties.TOTAL_MKT_VALUE) !== null && numberOrNull(properties.LAND_MKT_VALUE) !== null
          ? numberOrNull(properties.TOTAL_MKT_VALUE) - numberOrNull(properties.LAND_MKT_VALUE)
          : null,
        numberOrNull(properties.TOTAL_MKT_VALUE), numberOrNull(properties.PARCEL_ACRES), numberOrNull(properties.BLDG_SQFT), formatDate(properties.CURRENT_ASOF),
      ],
    },
    report: {
      title: "PARCEL ANALYSIS - UTAH - SPLIT-RATE PROPERTY TAX SUMMARY",
      accountNoun: "parcel records",
      unitDescription: "Each record is a geometry-bearing county Land Information Record (LIR) parcel feature from one of 29 county services; polygon centroids determine district membership.",
      caveats: [
        `Certified composite Utah rates and parcel tax bills are not configured. Current tax uses an illustrative ${(PLACEHOLDER_RATE * 1000).toFixed(1)}-mill placeholder on market value and is not an official tax estimate. The UGRC Tax Areas 2024 Rate field was null on all 1,641 polygons tested; the 2025 Tax Entities layer supplies component rates but not a verified parcel-level composite rate schedule.`,
        "TOTAL_MKT_VALUE and LAND_MKT_VALUE are market-value fields, not verified taxable assessed values. PRIMARY_RES and exemption/class fields vary across county feeds; this model does not calculate Utah's primary-residence assessment reduction, exemptions, credits, or parcel bills. Positive value is an analytical filter, not a legal determination of taxability.",
        "During the October 2026 onboarding audit, 1,484,176 of 1,525,742 records with positive total market value (97.28%) also had a non-null land value; after excluding negative or over-total land values, 1,480,414 records (97.03%) remained. Rich County had no usable land values (0 of 16,464 positive-total records); Summit County had 23,560 of 33,522 (70.3%). These counts are a live-source snapshot and will change as county feeds update.",
        "Agricultural records are proxied by PROP_CLASS labels containing 'Agricultural'. The SFH benchmark is a proxy based on Residential/Single Family class, PRIMARY_RES = Y, and HOUSE_CNT = 1; county classification conventions vary and neither proxy establishes legal use or detached-home status.",
        "TAXEXEMPT_TYPE is not consistently coded as a null/non-null exemption flag (many counties report 'Unknown'); the model does not use it as a taxability filter. County LIR submissions and CURRENT_ASOF dates vary, and SGID updates LIR data when county year-end rolls are provided.",
        "Analysis fans out to 29 public county services. Counts and sums are added and averages are weighted across services; the hosted polygon layers have no low-zoom map image, so parcel shapes draw at zoom 14+ and selected-geography district membership uses parcel centroids.",
      ],
      rateDefinition: "Rates are shown as a percentage of source-reported total market value ($ per $100). The 6.5-mill rate is an illustrative placeholder only; Utah's taxable-value adjustments and composite local levies are not modeled.",
      sfhNotes: "Benchmark proxy: positive derived improvement value, Residential or Single Family PROP_CLASS, PRIMARY_RES = Y, and HOUSE_CNT = 1. This is not a verified detached single-family classification.",
      sourceLines: [
        `UGRC Utah Parcels and LIR catalog: ${PARCEL_CATALOG}`,
        ...ANALYSIS_SOURCES.map((source) => `${source.countyName} LIR parcel polygons: ${source.url}`),
        `UGRC county boundaries: ${COUNTY_BOUNDARIES_URL}`,
        `UGRC municipal boundaries: ${MUNICIPAL_BOUNDARIES_URL}`,
        `Utah House and Senate districts: ${HOUSE_URL}; ${SENATE_URL}`,
        `Utah U.S. congressional districts 2026–2032: ${CONGRESSIONAL_URL}`,
        `Utah Tax Areas 2024 (evaluated): ${TAX_AREAS_URL}`,
        `Utah Tax Entities 2025 (evaluated): ${TAX_ENTITIES_URL}`,
        "U.S. Census Bureau TIGERweb 2020 urban areas: https://tigerweb.geo.census.gov/",
      ],
      csvColumnNotes: [
        "OBJECTID is unique only within its county service; use COUNTY_ID + OBJECTID to identify a source feature. COUNTY_NAME, COUNTY_ID, PARCEL_ID, SERIAL_NUM, PARCEL_ADD, and PARCEL_CITY are county LIR parcel identifiers and address fields.",
        "TAX_DISTRICT, TAXEXEMPT_TYPE, PROP_CLASS, PRIMARY_RES, and HOUSE_CNT retain county-provided classifications; their semantics and completeness vary. Occupancy and property-type categories are explicitly described as proxies.",
        "LAND_MKT_VALUE and TOTAL_MKT_VALUE are source-reported market values. DERIVED_IMPROVEMENT_MKT_VALUE is total market value minus land market value; it is not a source-reported improvement assessment or taxable value. CURRENT_ASOF is the county LIR record date.",
      ],
    },
  });

  function formatDate(value) {
    if (!hasValue(value)) return null;
    const date = new Date(Number(value));
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }
})();

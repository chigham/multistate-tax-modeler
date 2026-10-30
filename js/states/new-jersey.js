"use strict";

// New Jersey's normalized statewide parcel composite is polygon-only and carries
// MOD-IV assessment fields plus prior-year tax. Tax rates are effective estimates
// derived from the tax/value totals reported for each municipality.
(() => {
  const PARCELS_URL = "https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/Parcels_Composite_NJ_WM/FeatureServer/0";
  const TIGER_LEGISLATIVE = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Legislative/MapServer";
  const TIGER_COUNTIES = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/55";
  const TIGER_COUNTY_SUBDIVISIONS = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/1";
  const TAXABLE_WHERE = "NET_VALUE > 0 AND LAND_VAL IS NOT NULL AND IMPRVT_VAL IS NOT NULL AND NET_VALUE >= LAND_VAL AND COUNTY IS NOT NULL AND MUN_NAME IS NOT NULL";
  const IMPROVEMENT_SQL = "(NET_VALUE - LAND_VAL)";
  const DISTRICT_OFFSET = 0.00003;
  const AREA_OFFSET = 0.0002;

  const optional = (value) => (value === null || value === undefined || value === "" ? null : value);
  const numberOrNull = (value) => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
  const countyKey = (name) => String(name || "").trim().toUpperCase().replace(/^SAINT /, "ST ").replace(/\./g, "").replace(/\s+COUNTY$/, "");
  const countyLabel = (name) => `${titleCase(countyKey(name))} County`;
  const placeLabel = (name) => titleCase(name)
    .replace(/\bTwp\b/gi, "Township")
    .replace(/\bBoro\b/gi, "Borough");
  const propertyClass = (properties) => String(properties.PROP_CLASS || "").trim().toUpperCase();
  const isAgricultural = (properties) => ["3A", "3B"].includes(propertyClass(properties));
  const isImproved = (properties) => {
    const total = numberOrNull(properties.NET_VALUE);
    const land = numberOrNull(properties.LAND_VAL);
    return total !== null && land !== null && total - land > 0;
  };
  const isSingleFamilyProxy = (properties) => !isAgricultural(properties)
    && propertyClass(properties) === "2"
    && Number(properties.DWELL) === 1
    && (properties.COMM_DWELL === null || properties.COMM_DWELL === undefined || Number(properties.COMM_DWELL) === 0)
    && isImproved(properties);

  const NOT_AGRICULTURAL = "(PROP_CLASS IS NULL OR PROP_CLASS NOT IN ('3A', '3B'))";
  const IMPROVED = "NET_VALUE > LAND_VAL";
  const SFH_WHERE = `${NOT_AGRICULTURAL} AND PROP_CLASS = '2' AND DWELL = 1 AND (COMM_DWELL IS NULL OR COMM_DWELL = 0) AND ${IMPROVED}`;

  const PROPERTY_TYPES = [
    {
      key: "agricultural",
      label: "Farm-assessed property (class 3A/3B proxy)",
      definition: "New Jersey MOD-IV property class 3A or 3B. This is a farm-assessment classification proxy, not a separate verification of current agricultural use or exemption eligibility.",
      where: "PROP_CLASS IN ('3A', '3B')",
      matches: ({ properties }) => isAgricultural(properties),
    },
    {
      key: "vacant",
      label: "Vacant / no modeled improvements",
      definition: "Non-farm-assessed properties with no positive non-land value (NET_VALUE minus LAND_VAL); this does not independently establish legal vacancy.",
      where: `${NOT_AGRICULTURAL} AND NET_VALUE <= LAND_VAL`,
      matches: ({ properties, improved }) => !isAgricultural(properties) && !improved,
    },
    {
      key: "sfh",
      label: "Single dwelling residential (proxy)",
      definition: "Class 2 residential records with one reported dwelling, no reported commercial dwelling, and positive modeled non-land value. This does not distinguish detached homes from every condominium or other one-unit residential account.",
      where: SFH_WHERE,
      matches: ({ properties }) => isSingleFamilyProxy(properties),
    },
    {
      key: "otherResidential",
      label: "Other residential",
      definition: "Improved class 2 residential records that do not meet the one-dwelling benchmark proxy.",
      where: `${NOT_AGRICULTURAL} AND PROP_CLASS = '2' AND ${IMPROVED} AND (DWELL IS NULL OR DWELL <> 1 OR (COMM_DWELL IS NOT NULL AND COMM_DWELL <> 0))`,
      matches: ({ properties, improved }) => !isAgricultural(properties) && propertyClass(properties) === "2" && improved && !isSingleFamilyProxy(properties),
    },
    {
      key: "commercial",
      label: "Commercial",
      definition: "Improved class 4A commercial property.",
      where: `${NOT_AGRICULTURAL} AND PROP_CLASS = '4A' AND ${IMPROVED}`,
      matches: ({ properties, improved }) => !isAgricultural(properties) && propertyClass(properties) === "4A" && improved,
    },
    {
      key: "industrial",
      label: "Industrial",
      definition: "Improved class 4B industrial property.",
      where: `${NOT_AGRICULTURAL} AND PROP_CLASS = '4B' AND ${IMPROVED}`,
      matches: ({ properties, improved }) => !isAgricultural(properties) && propertyClass(properties) === "4B" && improved,
    },
    {
      key: "apartments",
      label: "Apartments (class 4C)",
      definition: "Improved class 4C apartment property; the class does not provide unit-level building occupancy or ownership detail.",
      where: `${NOT_AGRICULTURAL} AND PROP_CLASS = '4C' AND ${IMPROVED}`,
      matches: ({ properties, improved }) => !isAgricultural(properties) && propertyClass(properties) === "4C" && improved,
    },
    {
      key: "other",
      label: "Other improved property",
      definition: "Remaining records with positive modeled non-land value, including other MOD-IV classes and missing or less common classes.",
      where: `${NOT_AGRICULTURAL} AND ${IMPROVED} AND (PROP_CLASS IS NULL OR PROP_CLASS NOT IN ('2', '4A', '4B', '4C'))`,
      matches: ({ properties, improved }) => !isAgricultural(properties) && improved && !["2", "4A", "4B", "4C"].includes(propertyClass(properties)),
    },
  ];

  // Effective municipal rates = reported prior-year tax divided by current NET_VALUE.
  const rates = { byMunicipality: new Map(), byCounty: new Map(), statewide: null };
  let ratesPromise = null;
  let countyNamesPromise = null;
  let countyNamesByFips = new Map();

  async function loadRates(signal) {
    const statistics = JSON.stringify([
      { statisticType: "sum", onStatisticField: "LAST_YR_TX", outStatisticFieldName: "tax" },
      { statisticType: "sum", onStatisticField: "NET_VALUE", outStatisticFieldName: "base" },
    ]);
    const rows = await queryAllJson(PARCELS_URL, {
      where: `(${TAXABLE_WHERE}) AND LAST_YR_TX > 0`,
      outFields: "COUNTY,MUN_NAME",
      groupByFieldsForStatistics: "COUNTY,MUN_NAME",
      orderByFields: "COUNTY,MUN_NAME",
      outStatistics: statistics,
      returnGeometry: "false",
    }, signal, 1000, 2000);

    const countyTotals = new Map();
    let statewideTax = 0;
    let statewideBase = 0;
    rows.forEach(({ attributes = {} }) => {
      const tax = Number(attributes.tax);
      const base = Number(attributes.base);
      if (!(tax > 0 && base > 0 && attributes.COUNTY && attributes.MUN_NAME)) return;
      const county = countyKey(attributes.COUNTY);
      const key = `${county}|${String(attributes.MUN_NAME).trim().toUpperCase()}`;
      rates.byMunicipality.set(key, tax / base);
      const totals = countyTotals.get(county) || { tax: 0, base: 0 };
      totals.tax += tax;
      totals.base += base;
      countyTotals.set(county, totals);
      statewideTax += tax;
      statewideBase += base;
    });
    countyTotals.forEach(({ tax, base }, county) => rates.byCounty.set(county, tax / base));
    rates.statewide = statewideBase > 0 ? statewideTax / statewideBase : null;
  }

  async function loadCountyNames(signal) {
    if (!countyNamesPromise) {
      countyNamesPromise = queryAllJson(TIGER_COUNTIES, {
        where: "STATE = '34'",
        outFields: "NAME,GEOID,STATE",
        returnGeometry: "false",
      }, signal, 1000, 1000).then((rows) => {
        countyNamesByFips = new Map(rows.map(({ attributes = {} }) => [
          String(attributes.GEOID || "").slice(-3), countyKey(attributes.NAME),
        ]));
        return countyNamesByFips;
      }).catch((error) => {
        countyNamesPromise = null;
        throw error;
      });
    }
    return countyNamesPromise;
  }

  const loadCountyNameSync = (fips) => countyNamesByFips.get(String(fips || "").padStart(3, "0")) || "";
  let preparePromise = null;
  function prepare(signal) {
    if (!preparePromise) {
      preparePromise = Promise.all([loadRates(signal), loadCountyNames(signal)]).catch((error) => {
        preparePromise = null;
        rates.byMunicipality.clear();
        rates.byCounty.clear();
        rates.statewide = null;
        throw error;
      });
    }
    return preparePromise;
  }

  function taxJurisdictionDetails(properties) {
    const rawCounty = properties.COUNTY || "";
    const county = rawCounty ? countyLabel(rawCounty) : "Unknown New Jersey county";
    const municipalityName = String(properties.MUN_NAME || "").trim();
    const municipality = municipalityName ? placeLabel(municipalityName) : null;
    const rate = rates.byMunicipality.get(`${countyKey(rawCounty)}|${municipalityName.toUpperCase()}`)
      ?? rates.byCounty.get(countyKey(rawCounty))
      ?? rates.statewide;
    return { county, municipality, rate, jurisdiction: municipality ? `${county} — ${municipality}` : county };
  }

  function municipalityCandidates(censusName) {
    const normalized = String(censusName || "").trim().toUpperCase().replace(/\./g, "");
    const suffix = normalized.match(/^(.*?)\s+(TOWNSHIP|BOROUGH|CITY|TOWN|VILLAGE)$/);
    if (!suffix) return normalized ? [normalized] : [];
    const [, base, kind] = suffix;
    if (kind === "TOWNSHIP") return [`${base} TWP`, `${base} TOWNSHIP`];
    if (kind === "BOROUGH") return [`${base} BORO`, `${base} BOROUGH`];
    return [`${base} ${kind}`];
  }

  const districtGeography = (label, layerId, field, prefix) => ({
    label,
    choiceLabel: "District",
    load: (signal) => loadArcgisGeography({
      serviceUrl: `${TIGER_LEGISLATIVE}/${layerId}`,
      where: `STATE = '34' AND ${field} <> 'ZZZ'`,
      outFields: `${field},STATE,NAME`,
      maxAllowableOffset: DISTRICT_OFFSET,
      value: (properties) => properties[field],
      label: (properties, value) => properties.NAME || `${prefix} - ${value}`,
    }, signal),
  });

  const urbanCache = new Map();
  const acknowledgementsHtml = `
    <li><a href="https://njgin.nj.gov/njgin/edata/parcels/" target="_blank" rel="noopener">New Jersey Geographic Information Network (NJGIN)</a> — statewide normalized parcel composite and MOD-IV assessment attributes</li>
    <li><a href="https://tigerweb.geo.census.gov/" target="_blank" rel="noopener">U.S. Census Bureau TIGERweb</a> — 2026 state legislative districts, 119th Congress districts, counties, county subdivisions, and 2020 urban areas</li>`;
  const percentOf = (part, total) => (Number(total) ? ` (${((Number(part) / Number(total)) * 100).toFixed(0)}%)` : "");
  const classLabels = {
    "1": "Vacant land", "2": "Residential", "3A": "Farm property (regular assessment)", "3B": "Farm property (qualified assessment)",
    "4A": "Commercial", "4B": "Industrial", "4C": "Apartments", "5A": "Railroad property", "5B": "Public utility property", "6A": "Mineral property",
  };

  window.ParcelStates.register({
    id: "NJ",
    name: "New Jersey",
    center: [40.1, -74.6],
    zoom: 8,
    brand: {
      eyebrow: "New Jersey property insights",
      dataNote: "Statewide parcel composite and assessment attributes provided by NJGIN",
      acknowledgementsHtml,
    },
    tax: {
      description: "Load New Jersey parcel records with positive NET_VALUE and reported land and improvement values. The baseline uses municipality-level effective rates derived from reported LAST_YR_TX divided by NET_VALUE.",
      scopeLabel: "Reported prior-year property tax (effective local rate)",
      shortLabel: "Reported Property Tax",
      rateNote: "Rates are estimates from grouped LAST_YR_TX / NET_VALUE totals, not a certified current rate schedule. Missing municipality rates fall back to the county estimate, then the statewide estimate.",
    },
    parcels: {
      analysisUrl: PARCELS_URL,
      analysisGeometry: "polygon",
      shapesUrl: PARCELS_URL,
      shapesCarryAttributes: true,
      generalizeShapes: true,
      outFields: "OBJECTID,PAMS_PIN,PCL_MUN,PCLBLOCK,PCLLOT,PCLQCODE,PCLLASTUPD,PIN_NODUP,GIS_PIN,CD_CODE,PROP_CLASS,COUNTY,MUN_NAME,PROP_LOC,ST_ADDRESS,CITY_STATE,ZIP_CODE,LAND_VAL,IMPRVT_VAL,NET_VALUE,LAST_YR_TX,BLDG_DESC,LAND_DESC,CALC_ACRE,ADD_LOTS1,ADD_LOTS2,FAC_NAME,PROP_USE,BLDG_CLASS,YR_CONSTR,SALES_CODE,SALE_PRICE,DWELL,COMM_DWELL,ZIP5,ZIP_PLUS4",
      taxableWhere: TAXABLE_WHERE,
      objectIdField: "OBJECTID",
      pageSize: 2000,
      percentileExpressions: false,
    },
    fields: {
      land: "LAND_VAL",
      improvement: "IMPRVT_VAL",
      improvementCount: "IMPRVT_VAL",
      total: "NET_VALUE",
      improvementFromTotalMinusLand: true,
    },
    values: (properties) => {
      const land = numberOrNull(properties.LAND_VAL);
      const total = numberOrNull(properties.NET_VALUE);
      return { land, improvement: land === null || total === null ? null : total - land, total };
    },
    jurisdictionGroupBy: "COUNTY,MUN_NAME",
    prepare,
    taxJurisdictionDetails,
    sfh: {
      where: SFH_WHERE,
      matches: isSingleFamilyProxy,
      definition: "Class 2 residential, one reported dwelling, no reported commercial dwelling, and positive NET_VALUE minus LAND_VAL. This is a proxy, not verified detached-home or owner-occupancy status.",
    },
    propertyTypes: PROPERTY_TYPES,
    occupancy: {
      groups: [{ key: "", label: "Not reported" }],
      definition: "The statewide parcel composite does not provide verified owner-occupancy or homestead status.",
    },
    geographies: {
      stateSenate: districtGeography("New Jersey State Senate districts (2026 Census vintage)", 1, "SLDU", "NJ Senate"),
      stateAssembly: districtGeography("New Jersey General Assembly districts (2026 Census vintage)", 2, "SLDL", "NJ Assembly"),
      congressional: districtGeography("U.S. congressional districts (119th Congress)", 4, "CD119", "U.S."),
      county: {
        label: "Counties",
        choiceLabel: "County",
        load: (signal) => loadArcgisGeography({
          serviceUrl: TIGER_COUNTIES,
          where: "STATE = '34'",
          outFields: "NAME,STATE,GEOID",
          maxAllowableOffset: AREA_OFFSET,
          value: (properties) => properties.GEOID,
          label: (properties) => countyLabel(properties.NAME),
          county: (properties) => countyLabel(properties.NAME),
        }, signal),
        attributeFilter: (feature) => {
          const name = countyKey(feature.properties.raw.NAME);
          return name ? `COUNTY = ${sqlString(name)}` : null;
        },
      },
      municipality: {
        label: "Municipalities",
        choiceLabel: "Municipality",
        verifyAttributeFilter: true,
        load: async (signal) => {
          const countyNames = await loadCountyNames(signal);
          return loadArcgisGeography({
            serviceUrl: TIGER_COUNTY_SUBDIVISIONS,
            where: "STATE = '34'",
            outFields: "NAME,BASENAME,STATE,COUNTY,GEOID,COUSUB",
            maxAllowableOffset: AREA_OFFSET,
            value: (properties) => properties.GEOID,
            label: (properties) => {
              const county = countyNames.get(String(properties.COUNTY || "").padStart(3, "0"));
              return `${titleCase(properties.NAME)}${county ? ` (${titleCase(county)} County)` : ""}`;
            },
            county: (properties) => {
              const county = countyNames.get(String(properties.COUNTY || "").padStart(3, "0"));
              return county ? countyLabel(county) : null;
            },
          }, signal);
        },
        attributeFilter: (feature) => {
          const raw = feature.properties.raw;
          const county = countyKey(loadCountyNameSync(raw.COUNTY));
          const names = municipalityCandidates(raw.NAME);
          return county && names.length ? `COUNTY = ${sqlString(county)} AND MUN_NAME IN (${sqlList(names)})` : null;
        },
      },
    },
    geographyOrder: ["stateSenate", "stateAssembly", "congressional", "county", "municipality"],
    defaultGeography: "stateAssembly",
    exportDistricts: [
      { type: "stateSenate", header: "STATE_SENATE_DISTRICT", description: "2026 Census-vintage New Jersey State Senate district containing the parcel centroid." },
      { type: "stateAssembly", header: "STATE_ASSEMBLY_DISTRICT", description: "2026 Census-vintage New Jersey General Assembly district containing the parcel centroid." },
      { type: "congressional", header: "CONGRESSIONAL_DISTRICT", description: "119th Congress U.S. congressional district containing the parcel centroid." },
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
      title: (properties) => optional(properties.ST_ADDRESS) || optional(properties.PAMS_PIN) || "Selected parcel",
      sortKey: (properties) => [properties.ST_ADDRESS, properties.PAMS_PIN, properties.OBJECTID],
      rows: (properties, { formatCurrency }) => {
        const details = taxJurisdictionDetails(properties);
        const modelValues = window.ParcelStates.get("NJ").values(properties);
        return [
          ["Parcel PIN", optional(properties.PAMS_PIN) || optional(properties.PIN_NODUP)],
          ["Municipality", details.municipality],
          ["County", details.county],
          ["Site address", [properties.ST_ADDRESS, properties.CITY_STATE, properties.ZIP_CODE].filter(Boolean).join(", ") || null],
          ["MOD-IV class", optional(properties.PROP_CLASS) ? `${properties.PROP_CLASS}${classLabels[propertyClass(properties)] ? ` — ${classLabels[propertyClass(properties)]}` : ""}` : null],
          ["Building description", optional(properties.BLDG_DESC)],
          ["Land description", optional(properties.LAND_DESC)],
          ["Land assessment", `${formatCurrency(properties.LAND_VAL)}${percentOf(properties.LAND_VAL, properties.NET_VALUE)}`],
          ["Reported improvement assessment", `${formatCurrency(properties.IMPRVT_VAL)}${percentOf(properties.IMPRVT_VAL, properties.NET_VALUE)}`],
          ["Modeled non-land value (NET_VALUE − land)", `${formatCurrency(modelValues.improvement)}${percentOf(modelValues.improvement, properties.NET_VALUE)}`],
          ["Total net assessment", `${formatCurrency(properties.NET_VALUE)}${Number(properties.NET_VALUE) ? " (100%)" : ""}`],
          ["Reported prior-year tax", properties.LAST_YR_TX ? formatCurrency(properties.LAST_YR_TX) : null],
          ["Reported dwelling count", optional(properties.DWELL)],
          ["Parcel acreage", optional(properties.CALC_ACRE)],
          ["Last parcel update", optional(properties.PCLLASTUPD)],
        ];
      },
    },
    csv: {
      headers: [
        "PAMS_PIN", "PIN_NODUP", "PCL_MUN", "PCLBLOCK", "PCLLOT", "PCLQCODE", "ST_ADDRESS", "CITY_STATE", "ZIP_CODE",
        "COUNTY", "MUN_NAME", "PROP_CLASS", "BLDG_DESC", "LAND_DESC", "DWELL", "COMM_DWELL", "CALC_ACRE",
        "LAND_VAL", "IMPRVT_VAL", "MODEL_NONLAND_VALUE", "NET_VALUE", "LAST_YR_TX", "PCLLASTUPD", "CD_CODE",
      ],
      row: (properties) => {
        const values = window.ParcelStates.get("NJ").values(properties);
        return [
          properties.PAMS_PIN, properties.PIN_NODUP, properties.PCL_MUN, properties.PCLBLOCK, properties.PCLLOT, properties.PCLQCODE,
          properties.ST_ADDRESS, properties.CITY_STATE, properties.ZIP_CODE, properties.COUNTY, properties.MUN_NAME,
          properties.PROP_CLASS, properties.BLDG_DESC, properties.LAND_DESC, properties.DWELL, properties.COMM_DWELL, properties.CALC_ACRE,
          Number(properties.LAND_VAL), Number(properties.IMPRVT_VAL), values.improvement, Number(properties.NET_VALUE),
          properties.LAST_YR_TX, properties.PCLLASTUPD, properties.CD_CODE,
        ];
      },
    },
    report: {
      title: "PARCEL ANALYSIS - NEW JERSEY - SPLIT-RATE PROPERTY TAX SUMMARY",
      accountNoun: "parcel records",
      unitDescription: "Each record is a polygon in NJGIN's statewide parcel composite joined to selected MOD-IV fields. Parcel centers are used for geography membership.",
      caveats: [
        "The statewide composite was normalized during 2008–2014 and is updated as county and municipal data are received. NJGIN says these mapped polygons are not survey data or legal ownership boundaries; local currency and completeness vary.",
        "The model includes positive NET_VALUE records with reported land and improvement values. For a consistent land/non-land split, modeled improvement is NET_VALUE minus LAND_VAL; this may differ from source IMPRVT_VAL, which is retained in popups and downloads. A small number of records with NET_VALUE below LAND_VAL are excluded.",
        "Reported prior-year tax (LAST_YR_TX) divided by NET_VALUE is used to derive effective municipality rates. These ratios are estimates from the current composite, not a certified rate schedule or independently reconciled tax bills; missing municipality rates use a county or statewide fallback.",
        "MOD-IV property classes 3A/3B are a farm-assessment proxy. A class-2, one-dwelling record with no commercial dwelling is the single-family benchmark proxy; it is not a verified detached-home or owner-occupancy determination. No statewide exemption or homestead filter is available.",
        "NJGIN redacts protected owner names under Daniel's Law. The hosted FeatureServer has no low-zoom parcel image; polygons are drawn at zoom 14+ and users can click the map to inspect at smaller scales.",
        "Census TIGERweb 2026-vintage legislative and 119th Congress districts and 2020 county-subdivision boundaries are for analysis and mapping, not legal surveys.",
      ],
      rateDefinition: "Estimated effective rate, in percent of NET_VALUE (reported LAST_YR_TX divided by NET_VALUE), grouped by municipality and county.",
      sfhNotes: "Benchmark proxy: MOD-IV class 2, one reported dwelling, no reported commercial dwelling, and positive NET_VALUE minus LAND_VAL. This is not a verified detached-home or owner-occupancy category.",
      sourceLines: [`NJGIN Statewide Parcels Composite: ${PARCELS_URL}`, "U.S. Census Bureau TIGERweb boundaries: https://tigerweb.geo.census.gov/"],
      csvColumnNotes: [
        "PAMS_PIN and PIN_NODUP: normalized parcel identifiers; PCL_MUN, PCLBLOCK, PCLLOT, and PCLQCODE retain source parcel-map identifiers.",
        "COUNTY and MUN_NAME: source jurisdiction names; PROP_CLASS: New Jersey MOD-IV class; BLDG_DESC, LAND_DESC, DWELL, and COMM_DWELL are source characteristics.",
        "LAND_VAL and IMPRVT_VAL: source land and improvement assessments; NET_VALUE: source net total assessment; MODEL_NONLAND_VALUE is derived as NET_VALUE minus LAND_VAL so model components reconcile to the total.",
        "LAST_YR_TX: source-reported prior-year tax used to estimate effective municipality rates; it is not represented as a certified current bill.",
      ],
    },
  });
})();
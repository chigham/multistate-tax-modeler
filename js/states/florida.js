"use strict";

// Florida: Florida Department of Revenue (FDOR) statewide cadastral data published by the Florida GIO.
// Both a centroid (point) layer and a polygon layer carry the full NAL attributes:
//   - the centroid layer drives statistics and membership (exact point-in-boundary counts);
//   - polygons are drawn at high zoom with only their join key (CO_NO + PARCEL_ID), and the
//     centroid attributes are attached by key, so each parcel's attributes are downloaded once.
// The FDOR roll has no improvement value field, so improvements = just value (JV) - land value (LND_VAL).
(() => {
  const POINTS_URL = "https://services9.arcgis.com/Gh9awoU677aKree0/ArcGIS/rest/services/Florida_Statewide_Parcel_Centroid_Version/FeatureServer/0";
  const SHAPES_URL = "https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0";
  const FDOT_BOUNDARIES = "https://gis.fdot.gov/arcgis/rest/services/Admin_Boundaries/FeatureServer";
  const TAXABLE_WHERE = "CO_NO > 0 AND JV > 0 AND (TV_NSD > 0 OR JV_HMSTD > 0)";
  const DISTRICT_OFFSET = 0.00003;

  // FDOR county numbers 11-77, alphabetical (Miami-Dade sorts as "Dade").
  const COUNTIES = [
    "Alachua", "Baker", "Bay", "Bradford", "Brevard", "Broward", "Calhoun", "Charlotte", "Citrus", "Clay",
    "Collier", "Columbia", "Miami-Dade", "DeSoto", "Dixie", "Duval", "Escambia", "Flagler", "Franklin", "Gadsden",
    "Gilchrist", "Glades", "Gulf", "Hamilton", "Hardee", "Hendry", "Hernando", "Highlands", "Hillsborough", "Holmes",
    "Indian River", "Jackson", "Jefferson", "Lafayette", "Lake", "Lee", "Leon", "Levy", "Liberty", "Madison",
    "Manatee", "Marion", "Martin", "Monroe", "Nassau", "Okaloosa", "Okeechobee", "Orange", "Osceola", "Palm Beach",
    "Pasco", "Pinellas", "Polk", "Putnam", "St. Johns", "St. Lucie", "Santa Rosa", "Sarasota", "Seminole", "Sumter",
    "Suwannee", "Taylor", "Union", "Volusia", "Wakulla", "Walton", "Washington",
  ];
  const countyName = (coNo) => COUNTIES[Number(coNo) - 11] || null;
  const countyKey = (name) => String(name || "").toUpperCase().replace(/^SAINT/, "ST").replace(/[^A-Z]/g, "");
  const COUNTY_NUMBER_BY_KEY = new Map(COUNTIES.map((name, index) => [countyKey(name), index + 11]));

  // County-wide operating millage (as a fraction of value) by county name.
  // Not yet configured: every county falls back to PLACEHOLDER_COUNTY_RATE until certified
  // county millage rates (Florida DOR / TRIM) are entered here, e.g. "Leon": 0.0083144.
  const COUNTY_TAX_RATES = {};
  const PLACEHOLDER_COUNTY_RATE = 0.0065;

  function taxJurisdictionDetails(p) {
    const name = countyName(p.CO_NO);
    const county = name ? `${name} County` : "Unknown county";
    const rate = name ? COUNTY_TAX_RATES[name] ?? PLACEHOLDER_COUNTY_RATE : null;
    return { county, municipality: null, rate, jurisdiction: county };
  }

  // ---------- Property types (FDOR DOR_UC land use codes) ----------

  const codes = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => String(from + index).padStart(3, "0"));
  const AGRICULTURAL = codes(50, 69);
  const COMMERCIAL = codes(10, 39).filter((code) => code !== "012");
  const INDUSTRIAL = codes(40, 49);
  const OTHER_RESIDENTIAL = ["000", "002", "006", "007", "009"];
  const MULTIFAMILY = ["003", "008"];
  const CONDO = ["004", "005"];
  const useCode = (p) => String(p.DOR_UC ?? "").trim();
  const NOT_AG = `(DOR_UC IS NULL OR DOR_UC NOT IN (${sqlList(AGRICULTURAL)}))`;
  const IMPROVED = `${NOT_AG} AND JV - LND_VAL > 0`;
  const SFH_WHERE = "DOR_UC = '001' AND TOT_LVG_AR > 0 AND JV - LND_VAL > 0";
  const isSingleFamilyParcel = (p) => useCode(p) === "001" && Number(p.TOT_LVG_AR) > 0 && Number(p.JV) - Number(p.LND_VAL) > 0;

  const PROPERTY_TYPES = [
    {
      key: "agricultural",
      label: "Agricultural",
      definition: "DOR use codes 050-069 (cropland, timberland, grazing, groves, and other agricultural), with or without buildings.",
      where: `DOR_UC IN (${sqlList(AGRICULTURAL)})`,
      matches: ({ properties }) => AGRICULTURAL.includes(useCode(properties)),
    },
    {
      key: "vacant",
      label: "Vacant / unimproved land",
      definition: "Any other parcel whose just value is not greater than its land value (no improvement value).",
      where: `${NOT_AG} AND (LND_VAL IS NULL OR JV - LND_VAL <= 0)`,
      matches: ({ improved }) => !improved,
    },
    {
      key: "sfh",
      label: "Single-family homes",
      definition: "Improved parcels with DOR use code 001 (single family) and living area > 0.",
      where: `${IMPROVED} AND DOR_UC = '001' AND TOT_LVG_AR > 0`,
      matches: ({ properties }) => isSingleFamilyParcel(properties),
    },
    {
      key: "condo",
      label: "Condominiums / cooperatives",
      definition: "Improved parcels with DOR use code 004 (condominium) or 005 (cooperative).",
      where: `${IMPROVED} AND DOR_UC IN (${sqlList(CONDO)})`,
      matches: ({ properties }) => CONDO.includes(useCode(properties)),
    },
    {
      key: "otherResidential",
      label: "Other residential",
      definition: "Improved parcels with DOR use codes 000, 002 (mobile homes), 006, 007, 009, or 001 without living area.",
      where: `${IMPROVED} AND (DOR_UC IN (${sqlList(OTHER_RESIDENTIAL)}) OR (DOR_UC = '001' AND (TOT_LVG_AR IS NULL OR TOT_LVG_AR <= 0)))`,
      matches: ({ properties }) => OTHER_RESIDENTIAL.includes(useCode(properties)) || useCode(properties) === "001",
    },
    {
      key: "apartments",
      label: "Multifamily",
      definition: "Improved parcels with DOR use code 003 (10+ units) or 008 (fewer than 10 units).",
      where: `${IMPROVED} AND DOR_UC IN (${sqlList(MULTIFAMILY)})`,
      matches: ({ properties }) => MULTIFAMILY.includes(useCode(properties)),
    },
    {
      key: "mixedUse",
      label: "Mixed use",
      definition: "Improved parcels with DOR use code 012 (mixed use: store and office or store and residential).",
      where: `${IMPROVED} AND DOR_UC = '012'`,
      matches: ({ properties }) => useCode(properties) === "012",
    },
    {
      key: "commercial",
      label: "Commercial",
      definition: "Improved parcels with DOR use codes 010-039, except 012.",
      where: `${IMPROVED} AND DOR_UC IN (${sqlList(COMMERCIAL)})`,
      matches: ({ properties }) => COMMERCIAL.includes(useCode(properties)),
    },
    {
      key: "industrial",
      label: "Industrial",
      definition: "Improved parcels with DOR use codes 040-049.",
      where: `${IMPROVED} AND DOR_UC IN (${sqlList(INDUSTRIAL)})`,
      matches: ({ properties }) => INDUSTRIAL.includes(useCode(properties)),
    },
    {
      key: "other",
      label: "Other",
      definition: "Remaining improved parcels: institutional, government, and miscellaneous use codes (070-099).",
      where: `${IMPROVED} AND (DOR_UC IS NULL OR DOR_UC NOT IN (${sqlList(["001", ...CONDO, ...OTHER_RESIDENTIAL, ...MULTIFAMILY, "012", ...COMMERCIAL, ...INDUSTRIAL])}))`,
      matches: () => true,
    },
  ];

  function useCodeLabel(code) {
    const named = {
      "000": "Vacant residential", "001": "Single family", "002": "Mobile home", "003": "Multifamily (10+ units)",
      "004": "Condominium", "005": "Cooperative", "006": "Retirement home", "007": "Miscellaneous residential",
      "008": "Multifamily (under 10 units)", "009": "Residential common area", "010": "Vacant commercial",
      "012": "Mixed use", "039": "Hotel / motel", "040": "Vacant industrial", "048": "Warehousing",
      "070": "Vacant institutional", "071": "Church", "082": "Forest, park, or recreation", "086": "County",
      "087": "State", "088": "Federal", "089": "Municipal", "091": "Utility", "094": "Right-of-way",
    };
    if (!code) return null;
    if (named[code]) return `${named[code]} (${code})`;
    const value = Number(code);
    const group = value < 10 ? "Residential" : value < 40 ? "Commercial" : value < 50 ? "Industrial"
      : value < 70 ? "Agricultural" : value < 80 ? "Institutional" : value < 90 ? "Government" : "Miscellaneous";
    return `${group} (${code})`;
  }

  // ---------- Geographies ----------

  const districtGeography = (label, serviceUrl, prefix) => ({
    label,
    choiceLabel: "District",
    load: (signal) => loadArcgisGeography({
      serviceUrl,
      outFields: "DISTRICT",
      maxAllowableOffset: DISTRICT_OFFSET,
      value: (p) => p.DISTRICT,
      label: (p, value) => `${prefix} - ${value}`,
    }, signal),
  });

  const acknowledgementsHtml = `
    <li><a href="https://geodata.floridagio.gov/" target="_blank" rel="noopener">Florida Geospatial Information Office</a> — statewide FDOR cadastral parcels and parcel centroids, and the May 2026 congressional districts</li>
    <li><a href="https://floridarevenue.com/property/Pages/DataPortal.aspx" target="_blank" rel="noopener">Florida Department of Revenue</a> — Name-Address-Legal (NAL) assessment roll attributes</li>
    <li><a href="https://gis.fdot.gov/arcgis/rest/services/Admin_Boundaries/FeatureServer" target="_blank" rel="noopener">Florida Department of Transportation</a> — county boundaries and incorporated city boundaries</li>
    <li><a href="https://www.flsenate.gov/Session/Redistricting" target="_blank" rel="noopener">Florida Legislature</a> 2022 enacted plans (House H000H8013, Senate S027S8058), as published by Leon County GIS</li>
    <li><a href="https://tigerweb.geo.census.gov/" target="_blank" rel="noopener">U.S. Census Bureau TIGERweb</a> — 2020 urban areas</li>`;

  const optional = (value) => (value === null || value === undefined || value === "" ? null : value);
  const improvementOf = (p) => (p.JV === null || p.JV === undefined || p.LND_VAL === null || p.LND_VAL === undefined
    ? null
    : Number(p.JV) - Number(p.LND_VAL));
  const percentOf = (part, total) => (Number(total) && Number.isFinite(part) ? ` (${((Number(part) / Number(total)) * 100).toFixed(0)}%)` : "");
  const urbanCache = new Map();

  window.ParcelStates.register({
    id: "FL",
    name: "Florida",
    center: [27.9, -83.6],
    zoom: 7,
    brand: {
      eyebrow: "Florida property insights",
      dataNote: "Parcels provided by the Florida GIO and Florida DOR",
      acknowledgementsHtml,
    },
    tax: {
      description: "Load Florida parcels with a positive just value that are not fully exempt. This tool is for predicting COUNTY LEVEL REAL PROPERTY TAX only, not municipal, school, or special district taxes.",
      scopeLabel: "County real property tax",
      shortLabel: "County Property Tax",
      rateNote: `County millage rates are not configured yet, so every county uses a placeholder rate of ${(PLACEHOLDER_COUNTY_RATE * 1000).toFixed(1)} mills. Add certified rates in js/states/florida.js before citing results.`,
    },
    parcels: {
      analysisUrl: POINTS_URL,
      analysisGeometry: "point",
      shapesUrl: SHAPES_URL,
      shapeWhere: "CO_NO > 0",
      shapeOutFields: "OBJECTID,CO_NO,PARCEL_ID",
      shapeJoin: {
        shapeKey: (p) => `${p.CO_NO}|${p.PARCEL_ID}`,
        pointKey: (p) => `${p.CO_NO}|${p.PARCEL_ID}`,
      },
      generalizeShapes: true,
      outFields: "OBJECTID,CO_NO,PARCEL_ID,PHY_ADDR1,PHY_CITY,PHY_ZIPCD,DOR_UC,JV,LND_VAL,AV_NSD,TV_NSD,JV_HMSTD,TOT_LVG_AR,NO_RES_UNT,NO_BULDNG,ACT_YR_BLT,LND_SQFOOT,ASMNT_YR",
      taxableWhere: TAXABLE_WHERE,
      objectIdField: "OBJECTID",
      pageSize: 2000,
      pointPageSize: 2000,
      percentileExpressions: false,
    },
    fields: { land: "LND_VAL", improvement: "JV - LND_VAL", improvementCount: "LND_VAL", total: "JV" },
    values: (p) => ({ land: Number(p.LND_VAL), improvement: improvementOf(p), total: Number(p.JV) }),
    jurisdictionGroupBy: "CO_NO",
    taxJurisdictionDetails,
    sfh: {
      where: SFH_WHERE,
      matches: isSingleFamilyParcel,
      definition: "DOR use code 001 (single family) with living area and improvements; condos, mobile homes, and multifamily are not SFH",
    },
    propertyTypes: PROPERTY_TYPES,
    occupancy: {
      ownerOccupiedKey: "homestead",
      groups: [
        { key: "homestead", label: "Homestead (owner-occupied)", where: "JV_HMSTD > 0", matches: (p) => Number(p.JV_HMSTD) > 0 },
        { key: "nonHomestead", label: "Non-homestead", where: "(JV_HMSTD IS NULL OR JV_HMSTD = 0)", matches: () => true },
      ],
      definition: "Homestead = parcel has homestead just value (JV_HMSTD > 0), i.e. an owner-occupied permanent residence; all other parcels are non-homestead.",
    },
    geographies: {
      stateSenate: districtGeography("Florida Senate districts (2022)", "https://services.arcgis.com/ptvDyBs1KkcwzQNJ/arcgis/rest/services/Florida_Senate_2022_S027S8058/FeatureServer/1", "FL Senate"),
      stateHouse: districtGeography("Florida House districts (2022)", "https://services.arcgis.com/ptvDyBs1KkcwzQNJ/arcgis/rest/services/Florida_House_2022_H000H8013/FeatureServer/2", "FL House"),
      congressional: districtGeography("U.S. congressional districts (May 2026 plan)", "https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/FL_Congressional_Districts_May_2026/FeatureServer/0", "U.S."),
      county: {
        label: "Counties",
        choiceLabel: "County",
        load: (signal) => loadArcgisGeography({
          serviceUrl: `${FDOT_BOUNDARIES}/5`,
          outFields: "NAME",
          maxAllowableOffset: 0.0001,
          value: (p) => p.NAME,
          label: (p) => {
            const number = COUNTY_NUMBER_BY_KEY.get(countyKey(p.NAME));
            return number ? `${countyName(number)} County` : titleCase(p.NAME);
          },
          county: (p) => {
            const number = COUNTY_NUMBER_BY_KEY.get(countyKey(p.NAME));
            return number ? `${countyName(number)} County` : null;
          },
        }, signal),
        attributeFilter: (feature) => {
          const number = COUNTY_NUMBER_BY_KEY.get(countyKey(feature.properties.raw.NAME));
          return number ? `CO_NO = ${number}` : null;
        },
      },
      municipality: {
        label: "Municipalities",
        choiceLabel: "Municipality",
        load: (signal) => loadArcgisGeography({
          serviceUrl: `${FDOT_BOUNDARIES}/7`,
          where: "CLASSFP LIKE 'C%'",
          outFields: "NAME,GEOID",
          maxAllowableOffset: DISTRICT_OFFSET,
          value: (p) => p.GEOID,
          label: (p) => p.NAME,
        }, signal),
      },
    },
    geographyOrder: ["stateSenate", "stateHouse", "congressional", "county", "municipality"],
    defaultGeography: "stateHouse",
    exportDistricts: [
      { type: "stateSenate", header: "STATE_SENATE_DISTRICT", description: "2022 Florida Senate district containing the parcel centroid." },
      { type: "stateHouse", header: "STATE_HOUSE_DISTRICT", description: "2022 Florida House district containing the parcel centroid." },
      { type: "congressional", header: "CONGRESSIONAL_DISTRICT", description: "U.S. congressional district (May 2026 plan) containing the parcel centroid." },
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
      title: (p) => optional(p.PHY_ADDR1) || "Selected parcel",
      sortKey: (p) => [p.PHY_ADDR1, p.PARCEL_ID],
      rows: (p, { formatCurrency }) => {
        const improvement = improvementOf(p);
        return [
          ["Parcel ID", optional(p.PARCEL_ID)],
          ["City / ZIP", [p.PHY_CITY, p.PHY_ZIPCD].filter(Boolean).join(" ") || null],
          ["County", countyName(p.CO_NO)],
          ["Land use", useCodeLabel(useCode(p))],
          ["Land value", `${formatCurrency(p.LND_VAL)}${percentOf(Number(p.LND_VAL), p.JV)}`],
          ["Improvement value", `${formatCurrency(improvement)}${percentOf(improvement, p.JV)}`],
          ["Just value", `${formatCurrency(p.JV)}${Number(p.JV) ? " (100%)" : ""}`],
          ["Taxable value (non-school)", formatCurrency(p.TV_NSD)],
          ["Homestead", Number(p.JV_HMSTD) > 0 ? "Yes" : "No"],
          ["Living area", Number(p.TOT_LVG_AR) > 0 ? `${Number(p.TOT_LVG_AR).toLocaleString()} sq ft` : null],
          ["Year built", Number(p.ACT_YR_BLT) > 0 ? p.ACT_YR_BLT : null],
        ];
      },
    },
    csv: {
      headers: [
        "CO_NO", "PARCEL_ID", "PHY_ADDR1", "PHY_CITY", "PHY_ZIPCD", "DOR_UC", "LND_VAL", "IMPROVEMENT_VALUE", "JV",
        "AV_NSD", "TV_NSD", "JV_HMSTD", "TOT_LVG_AR", "NO_RES_UNT", "NO_BULDNG", "ACT_YR_BLT", "LND_SQFOOT", "ASMNT_YR",
      ],
      row: (p) => [
        p.CO_NO, p.PARCEL_ID, p.PHY_ADDR1, p.PHY_CITY, p.PHY_ZIPCD, p.DOR_UC, Number(p.LND_VAL), improvementOf(p) ?? 0,
        Number(p.JV), p.AV_NSD, p.TV_NSD, p.JV_HMSTD, p.TOT_LVG_AR, p.NO_RES_UNT, p.NO_BULDNG, p.ACT_YR_BLT, p.LND_SQFOOT, p.ASMNT_YR,
      ],
    },
    report: {
      title: "PARCEL ANALYSIS - FLORIDA - SPLIT-RATE PROPERTY TAX SUMMARY",
      accountNoun: "parcels",
      unitDescription: "Each record is one parcel centroid in the FDOR statewide cadastral centroid layer.",
      caveats: [
        `County millage rates are not configured yet: every county uses a placeholder rate of ${(PLACEHOLDER_COUNTY_RATE * 1000).toFixed(1)} mills. Current and hypothetical dollar amounts are illustrative until certified rates are entered.`,
        "Covers county real property tax only. School, municipal, and special district taxes are not included.",
        "Includes parcels with just value above $0 that are not fully exempt (non-school taxable value above $0, or homestead).",
        "Bills are just value x rate. Homestead exemptions, Save Our Homes and non-homestead assessment caps, and other exemptions are not modeled, so actual bills (especially for long-held homesteads) are lower.",
        "Improvement value is just value minus land value; the FDOR roll has no separate improvement value.",
      ],
      rateDefinition: "Rates are percent of just value ($ per $100). Current rate is the county rate.",
      sfhNotes: "Qualifying SFH parcel count: improved parcels with DOR_UC = 001 and TOT_LVG_AR > 0. Condos, mobile homes, and multifamily are excluded.",
      sourceLines: [
        `FDOR statewide cadastral centroids: ${POINTS_URL}`,
        `FDOR statewide cadastral polygons: ${SHAPES_URL}`,
      ],
      csvColumnNotes: [
        "CO_NO, PARCEL_ID: FDOR county number and parcel identifier.",
        "PHY_ADDR1, PHY_CITY, PHY_ZIPCD: physical address.",
        "DOR_UC: FDOR land use code. TOT_LVG_AR, NO_RES_UNT, NO_BULDNG, ACT_YR_BLT, LND_SQFOOT, ASMNT_YR: selected parcel characteristics.",
        "LND_VAL: land value; IMPROVEMENT_VALUE: JV - LND_VAL; JV: just (market) value.",
        "AV_NSD, TV_NSD: non-school assessed and taxable value. JV_HMSTD: homestead just value.",
      ],
    },
  });
})();

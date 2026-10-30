"use strict";

// Ohio is a live-service pilot covering four parcel feeds and six counties.
// A Central Ohio regional layer supplies Delaware, Fairfield, and Licking;
// Franklin is queried from its authoritative Auditor service to avoid overlap.
(() => {
  const TIGER_LEGISLATIVE = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Legislative/MapServer";
  const TIGER_COUNTIES = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/55";
  const TIGER_PLACES = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/25";
  const PLACEHOLDER_RATE = 0.0065;
  const ASSESSMENT_RATIO = 0.35;
  const COUNTY_FIPS = {
    "Cuyahoga": "39035",
    "Delaware": "39041",
    "Fairfield": "39045",
    "Franklin": "39049",
    "Hamilton": "39061",
    "Licking": "39089",
  };
  const COUNTY_NAMES = Object.keys(COUNTY_FIPS);
  const COUNTY_GEOIDS = Object.values(COUNTY_FIPS);
  const AREA_OFFSET = 0.0002;
  const DISTRICT_OFFSET = 0.00003;
  const hasValue = (value) => value !== null && value !== undefined && value !== "";
  const numberOrNull = (value) => hasValue(value) && Number.isFinite(Number(value)) ? Number(value) : null;
  const stringValue = (value) => hasValue(value) ? String(value).trim() : "";
  const percentOf = (part, total) => Number(total) ? ` (${((Number(part) / Number(total)) * 100).toFixed(0)}%)` : "";
  const normalizeCode = (value) => String(value ?? "").trim().toUpperCase();
  const isImproved = (properties) => numberOrNull(properties.OH_TOTAL) !== null
    && numberOrNull(properties.OH_LAND) !== null
    && Number(properties.OH_TOTAL) > Number(properties.OH_LAND);
  const isAgricultural = (properties) => properties.OH_AGRICULTURAL === true;
  const isSfh = (properties) => !isAgricultural(properties) && properties.OH_SFH === true && isImproved(properties);

  const FIELD_MAP = {
    OH_LAND: "OH_LAND",
    OH_TOTAL: "OH_TOTAL",
    OH_IMPROVEMENT: "OH_IMPROVEMENT",
  };
  const rawParcelWhere = (totalField, landField) => `${totalField} > 0 AND ${landField} IS NOT NULL AND ${landField} >= 0 AND ${landField} <= ${totalField}`;
  const sourceDefinitions = [
    {
      key: "franklin",
      label: "Franklin County Auditor",
      countyNames: ["Franklin"],
      url: "https://gis.franklincountyohio.gov/hosting/rest/services/ParcelFeatures/Parcel_Features/MapServer/0",
      objectIdField: "OBJECTID",
      pageSize: 1000,
      downloadBatchSize: 500,
      outFields: "OBJECTID,PARCELID,LOWPARCELID,SITEADDRESS,ZIPCD,CLASSCD,CLASSDSCRP,PCLASS,CAUV,HOMSTD,OWNEROCCUPIED,RESSTRTYP,RESFLRAREA,LNDVALUEBASE,BLDVALUEBASE,TOTVALUEBASE,CNTTXBLVAL,LNDVALUETIF,BLDVALUETIF,TOTVALUETIF,LNDVALUEEXP,BLDVALUEEXP,TOTVALUEEXP,EXPLUC",
      taxableWhere: `${rawParcelWhere("TOTVALUEBASE", "LNDVALUEBASE")} AND (CLASSDSCRP IS NULL OR UPPER(CLASSDSCRP) NOT LIKE '%EXEMPT%')`,
      rawValueFields: { land: "LNDVALUEBASE", total: "TOTVALUEBASE" },
      statisticScales: { averageLand: ASSESSMENT_RATIO, averageTotal: ASSESSMENT_RATIO, avg_land: ASSESSMENT_RATIO, avg_total: ASSESSMENT_RATIO },
      fieldMap: {
        ...FIELD_MAP,
        OH_LAND: "LNDVALUEBASE",
        OH_TOTAL: "TOTVALUEBASE",
        OH_IMPROVEMENT: "BLDVALUEBASE",
      },
      typeWhere: {
        agricultural: "(CLASSCD >= '100' AND CLASSCD <= '199') OR CAUV = 'Y'",
        nonAgricultural: "(CLASSCD IS NULL OR CLASSCD < '100' OR CLASSCD > '199') AND (CAUV IS NULL OR CAUV <> 'Y')",
        sfh: "UPPER(CLASSDSCRP) LIKE 'SINGLE FAMILY%' OR UPPER(CLASSDSCRP) LIKE 'ONE FAMILY%'",
        nonSfh: "CLASSDSCRP IS NULL OR (UPPER(CLASSDSCRP) NOT LIKE 'SINGLE FAMILY%' AND UPPER(CLASSDSCRP) NOT LIKE 'ONE FAMILY%')",
      },
      normalizeProperties: (attributes) => {
        const landRaw = numberOrNull(attributes.LNDVALUEBASE);
        const totalRaw = numberOrNull(attributes.TOTVALUEBASE);
        const classCode = normalizeCode(attributes.CLASSCD);
        const classDescription = normalizeCode(attributes.CLASSDSCRP);
        const land = landRaw === null ? null : landRaw * ASSESSMENT_RATIO;
        const total = totalRaw === null ? null : totalRaw * ASSESSMENT_RATIO;
        return {
          ...attributes,
          OBJECTID: attributes.OBJECTID ?? attributes.ObjectID,
          OH_SOURCE: "Franklin County Auditor",
          OH_COUNTY: "Franklin",
          OH_PARCEL_ID: stringValue(attributes.PARCELID),
          OH_ADDRESS: stringValue(attributes.SITEADDRESS),
          OH_LAND: land,
          OH_TOTAL: total,
          OH_IMPROVEMENT: land !== null && total !== null ? total - land : null,
          OH_RAW_LAND: landRaw,
          OH_RAW_IMPROVEMENT: numberOrNull(attributes.BLDVALUEBASE),
          OH_RAW_TOTAL: totalRaw,
          OH_VALUE_BASIS: "Franklin base appraisal × Ohio 35% assessment ratio",
          OH_CLASS: classCode,
          OH_CLASS_DESCRIPTION: stringValue(attributes.CLASSDSCRP),
          OH_AGRICULTURAL: (Number(classCode) >= 100 && Number(classCode) <= 199) || normalizeCode(attributes.CAUV) === "Y",
          OH_SFH: classDescription.startsWith("SINGLE FAMILY") || classDescription.startsWith("ONE FAMILY"),
          OH_HOMESTEAD: normalizeCode(attributes.HOMSTD) === "Y" || normalizeCode(attributes.OWNEROCCUPIED) === "Y",
          OH_EXEMPT: /EXEMPT/.test(classDescription),
        };
      },
    },
    {
      key: "central-ohio",
      label: "Central Ohio regional parcel layer",
      countyNames: ["Delaware", "Fairfield", "Licking"],
      url: "https://maps.columbus.gov/arcgis/rest/services/CityServices/KeyLayers/MapServer/3",
      objectIdField: "OBJECTID",
      pageSize: 1000,
      downloadBatchSize: 500,
      where: "COUNTY IN ('Delaware', 'Fairfield', 'Licking')",
      whereForGeography: (geography) => {
        const county = stringValue(geography?.properties?.COUNTY).replace(/\s+County$/i, "");
        return county && ["Delaware", "Fairfield", "Licking"].includes(county)
          ? `COUNTY = ${sqlString(county)}`
          : null;
      },
      outFields: "OBJECTID,COUNTY,PARCEL_CD,PARCELID,LOWPARCELID,SITEADDRESS,ZIPCD,CLASSCD,CLASSDSCRP,PCLASS,CAUV,HOMSTD,OWNEROCCUPIED,RESSTRTYP,RESFLRAREA,LNDVALUEBASE,BLDVALUEBASE,TOTVALUEBASE,CNTTXBLVAL",
      taxableWhere: `${rawParcelWhere("TOTVALUEBASE", "LNDVALUEBASE")} AND (CLASSDSCRP IS NULL OR UPPER(CLASSDSCRP) NOT LIKE '%EXEMPT%')`,
      rawValueFields: { land: "LNDVALUEBASE", total: "TOTVALUEBASE" },
      statisticScales: { averageLand: ASSESSMENT_RATIO, averageTotal: ASSESSMENT_RATIO, avg_land: ASSESSMENT_RATIO, avg_total: ASSESSMENT_RATIO },
      fieldMap: {
        ...FIELD_MAP,
        OH_LAND: "LNDVALUEBASE",
        OH_TOTAL: "TOTVALUEBASE",
        OH_IMPROVEMENT: "BLDVALUEBASE",
      },
      typeWhere: {
        agricultural: "(CLASSCD >= '100' AND CLASSCD <= '199') OR CAUV = 'Y'",
        nonAgricultural: "(CLASSCD IS NULL OR CLASSCD < '100' OR CLASSCD > '199') AND (CAUV IS NULL OR CAUV <> 'Y')",
        sfh: "UPPER(CLASSDSCRP) LIKE 'SINGLE FAMILY%' OR UPPER(CLASSDSCRP) LIKE 'ONE FAMILY%'",
        nonSfh: "CLASSDSCRP IS NULL OR (UPPER(CLASSDSCRP) NOT LIKE 'SINGLE FAMILY%' AND UPPER(CLASSDSCRP) NOT LIKE 'ONE FAMILY%')",
      },
      normalizeProperties: (attributes) => {
        const landRaw = numberOrNull(attributes.LNDVALUEBASE);
        const totalRaw = numberOrNull(attributes.TOTVALUEBASE);
        const classCode = normalizeCode(attributes.CLASSCD);
        const classDescription = normalizeCode(attributes.CLASSDSCRP);
        const land = landRaw === null ? null : landRaw * ASSESSMENT_RATIO;
        const total = totalRaw === null ? null : totalRaw * ASSESSMENT_RATIO;
        return {
          ...attributes,
          OBJECTID: attributes.OBJECTID ?? attributes.ObjectID,
          OH_SOURCE: "Central Ohio regional parcel layer",
          OH_COUNTY: stringValue(attributes.COUNTY),
          OH_PARCEL_ID: stringValue(attributes.PARCELID || attributes.PARCEL_CD),
          OH_ADDRESS: stringValue(attributes.SITEADDRESS),
          OH_LAND: land,
          OH_TOTAL: total,
          OH_IMPROVEMENT: land !== null && total !== null ? total - land : null,
          OH_RAW_LAND: landRaw,
          OH_RAW_IMPROVEMENT: numberOrNull(attributes.BLDVALUEBASE),
          OH_RAW_TOTAL: totalRaw,
          OH_VALUE_BASIS: "Regional base appraisal × Ohio 35% assessment ratio",
          OH_CLASS: classCode,
          OH_CLASS_DESCRIPTION: stringValue(attributes.CLASSDSCRP),
          OH_AGRICULTURAL: (Number(classCode) >= 100 && Number(classCode) <= 199) || normalizeCode(attributes.CAUV) === "Y",
          OH_SFH: classDescription.startsWith("SINGLE FAMILY") || classDescription.startsWith("ONE FAMILY"),
          OH_HOMESTEAD: normalizeCode(attributes.HOMSTD) === "Y" || normalizeCode(attributes.OWNEROCCUPIED) === "Y",
          OH_EXEMPT: /EXEMPT/.test(classDescription),
        };
      },
    },
    {
      key: "cuyahoga",
      label: "Cuyahoga County Fiscal Office",
      countyNames: ["Cuyahoga"],
      url: "https://gis.cuyahogacounty.gov/server/rest/services/CCFO/Parcel_Fabric_Taxparcels/FeatureServer/0",
      objectIdField: "ObjectID",
      pageSize: 2000,
      downloadBatchSize: 1000,
      outFields: "ObjectID,parcel_id,parcel_addr,parcel_street,parcel_suffix,par_addr_all,parcel_city,parcel_year,parcel_type,tax_assessed_land,tax_assessed_improvement,tax_assessed_total,tax_market_total,certified_exempt_total,property_class,prop_class_desc,tax_luc,tax_luc_description,res_bldg_count,res_styles,homestead_flag,tax_district,net_tax_total",
      taxableWhere: "tax_assessed_total > 0 AND tax_assessed_land IS NOT NULL AND tax_assessed_land >= 0 AND tax_assessed_land <= tax_assessed_total AND (prop_class_desc IS NULL OR UPPER(prop_class_desc) NOT LIKE '%EXEMPT%')",
      rawValueFields: { land: "tax_assessed_land", total: "tax_assessed_total" },
      fieldMap: {
        ...FIELD_MAP,
        OH_LAND: "tax_assessed_land",
        OH_TOTAL: "tax_assessed_total",
        OH_IMPROVEMENT: "tax_assessed_improvement",
      },
      typeWhere: {
        agricultural: "property_class = 'A' OR UPPER(tax_luc_description) LIKE '%CAUV%'",
        nonAgricultural: "(property_class IS NULL OR property_class <> 'A') AND (tax_luc_description IS NULL OR UPPER(tax_luc_description) NOT LIKE '%CAUV%')",
        sfh: "UPPER(tax_luc_description) LIKE '1-FAMILY%' OR UPPER(tax_luc_description) LIKE 'ONE FAMILY%'",
        nonSfh: "tax_luc_description IS NULL OR (UPPER(tax_luc_description) NOT LIKE '1-FAMILY%' AND UPPER(tax_luc_description) NOT LIKE 'ONE FAMILY%')",
      },
      normalizeProperties: (attributes) => {
        const land = numberOrNull(attributes.tax_assessed_land);
        const total = numberOrNull(attributes.tax_assessed_total);
        const classDescription = stringValue(attributes.prop_class_desc);
        const useDescription = stringValue(attributes.tax_luc_description);
        return {
          ...attributes,
          OBJECTID: attributes.OBJECTID ?? attributes.ObjectID,
          OH_SOURCE: "Cuyahoga County Fiscal Office",
          OH_COUNTY: "Cuyahoga",
          OH_PARCEL_ID: stringValue(attributes.parcel_id),
          OH_ADDRESS: stringValue(attributes.par_addr_all || [attributes.parcel_addr, attributes.parcel_street, attributes.parcel_suffix].filter(Boolean).join(" ")),
          OH_LAND: land,
          OH_TOTAL: total,
          OH_IMPROVEMENT: land !== null && total !== null ? total - land : null,
          OH_RAW_LAND: land,
          OH_RAW_IMPROVEMENT: numberOrNull(attributes.tax_assessed_improvement),
          OH_RAW_TOTAL: total,
          OH_VALUE_BASIS: "Fiscal Office assessed land and total values",
          OH_CLASS: normalizeCode(attributes.property_class),
          OH_CLASS_DESCRIPTION: classDescription || useDescription,
          OH_AGRICULTURAL: normalizeCode(attributes.property_class) === "A" || /CAUV|AGRICULTURAL/i.test(useDescription),
          OH_SFH: /^(1-FAMILY|ONE FAMILY)/i.test(useDescription),
          OH_HOMESTEAD: Number(attributes.homestead_flag) === 1,
          OH_EXEMPT: /EXEMPT/i.test(classDescription) || (numberOrNull(attributes.certified_exempt_total) || 0) > 0,
        };
      },
    },
    {
      key: "hamilton",
      label: "Hamilton County CAGIS / Auditor parcel layer",
      countyNames: ["Hamilton"],
      url: "https://cagisonline.hamilton-co.org/arcgis/rest/services/HCE/Cadastral/MapServer/0",
      objectIdField: "OBJECTID",
      pageSize: 1000,
      downloadBatchSize: 500,
      outFields: "OBJECTID,PARCELID,NAME,ADDRNO,ADDRST,ADDRSF,CLASS,EXLUCODE,NUM_UNITS,HMSD_FLAG,MKTLND,MKTIMP,MKTCAU,MKT_TOTAL_VAL,ANNUAL_TAXES,TAXES_PAID,TAXDST_DIS,SCHOOL_CODE_DIS",
      taxableWhere: "MKT_TOTAL_VAL > 0 AND MKTLND IS NOT NULL AND MKTLND >= 0 AND MKTLND <= MKT_TOTAL_VAL",
      rawValueFields: { land: "MKTLND", total: "MKT_TOTAL_VAL" },
      statisticScales: { averageLand: ASSESSMENT_RATIO, averageTotal: ASSESSMENT_RATIO, avg_land: ASSESSMENT_RATIO, avg_total: ASSESSMENT_RATIO },
      fieldMap: {
        ...FIELD_MAP,
        OH_LAND: "MKTLND",
        OH_TOTAL: "MKT_TOTAL_VAL",
        OH_IMPROVEMENT: "MKTIMP",
      },
      typeWhere: {
        agricultural: "CLASS >= 100 AND CLASS <= 199",
        nonAgricultural: "CLASS IS NULL OR CLASS < 100 OR CLASS > 199",
        sfh: "CLASS >= 510 AND CLASS <= 519",
        nonSfh: "CLASS IS NULL OR CLASS < 510 OR CLASS > 519",
      },
      normalizeProperties: (attributes) => {
        const landRaw = numberOrNull(attributes.MKTLND);
        const totalRaw = numberOrNull(attributes.MKT_TOTAL_VAL);
        const propertyClass = Number(attributes.CLASS);
        const land = landRaw === null ? null : landRaw * ASSESSMENT_RATIO;
        const total = totalRaw === null ? null : totalRaw * ASSESSMENT_RATIO;
        return {
          ...attributes,
          OBJECTID: attributes.OBJECTID ?? attributes.ObjectID,
          OH_SOURCE: "Hamilton County CAGIS / Auditor",
          OH_COUNTY: "Hamilton",
          OH_PARCEL_ID: stringValue(attributes.PARCELID),
          OH_ADDRESS: [attributes.ADDRNO, attributes.ADDRST, attributes.ADDRSF].map(stringValue).filter(Boolean).join(" "),
          OH_LAND: land,
          OH_TOTAL: total,
          OH_IMPROVEMENT: land !== null && total !== null ? total - land : null,
          OH_RAW_LAND: landRaw,
          OH_RAW_IMPROVEMENT: numberOrNull(attributes.MKTIMP),
          OH_RAW_TOTAL: totalRaw,
          OH_VALUE_BASIS: "CAGIS market appraisal × Ohio 35% assessment ratio",
          OH_CLASS: Number.isFinite(propertyClass) ? String(propertyClass) : "",
          OH_CLASS_DESCRIPTION: stringValue(attributes.EXLUCODE),
          OH_AGRICULTURAL: Number.isFinite(propertyClass) && propertyClass >= 100 && propertyClass <= 199,
          OH_SFH: Number.isFinite(propertyClass) && propertyClass >= 510 && propertyClass <= 519,
          OH_HOMESTEAD: normalizeCode(attributes.HMSD_FLAG) === "Y",
          OH_EXEMPT: false,
        };
      },
    },
  ];
  const SOURCES = sourceDefinitions.map((source) => ({
    ...source,
    fieldMap: { ...FIELD_MAP, ...source.fieldMap },
    sfhWhere: `(${source.typeWhere.nonAgricultural}) AND (${source.typeWhere.sfh}) AND ${source.rawValueFields.total} > ${source.rawValueFields.land}`,
    normalizeProperties: source.normalizeProperties,
  }));
  const PROPERTY_TYPES = [
    {
      key: "agricultural",
      label: "Agricultural / CAUV class proxy",
      definition: "Uses Ohio county class codes, CAUV enrollment, or the county land-use classification where supplied. Feeds differ; this is a classification proxy, not a legal exemption or taxability decision.",
      where: "OH_AGRICULTURAL = 1",
      whereBySource: Object.fromEntries(SOURCES.map((source) => [source.key, source.typeWhere.agricultural])),
      matches: ({ properties }) => isAgricultural(properties),
    },
    {
      key: "vacant",
      label: "No positive modeled improvement value",
      definition: "Non-agricultural records whose modeled total assessment does not exceed modeled land assessment; a value-based unimproved proxy.",
      where: "OH_AGRICULTURAL <> 1 AND OH_TOTAL <= OH_LAND",
      whereBySource: Object.fromEntries(SOURCES.map((source) => [source.key, `(${source.typeWhere.nonAgricultural}) AND ${source.fieldMap.OH_TOTAL} <= ${source.fieldMap.OH_LAND}`])),
      matches: ({ properties, improved }) => !isAgricultural(properties) && !improved,
    },
    {
      key: "sfh",
      label: "Single-family residential class proxy",
      definition: "County class or land-use codes that indicate single-family residential parcels, plus positive modeled improvements. Classification differs by county and does not verify detached form or owner occupancy.",
      where: "OH_SFH = 1 AND OH_TOTAL > OH_LAND",
      whereBySource: Object.fromEntries(SOURCES.map((source) => [source.key, `(${source.typeWhere.nonAgricultural}) AND (${source.typeWhere.sfh}) AND ${source.fieldMap.OH_TOTAL} > ${source.fieldMap.OH_LAND}`])),
      matches: ({ properties }) => isSfh(properties),
    },
    {
      key: "other",
      label: "Other improved property",
      definition: "Remaining non-agricultural records with positive modeled improvements.",
      where: "OH_AGRICULTURAL <> 1 AND OH_TOTAL > OH_LAND AND OH_SFH <> 1",
      whereBySource: Object.fromEntries(SOURCES.map((source) => [source.key, `(${source.typeWhere.nonAgricultural}) AND ${source.fieldMap.OH_TOTAL} > ${source.fieldMap.OH_LAND} AND (${source.typeWhere.nonSfh})`])),
      matches: ({ properties, improved }) => !isAgricultural(properties) && improved && !isSfh(properties),
    },
  ];
  SOURCES.forEach((source) => { delete source.typeWhere; });

  const countyNameFromGeoid = new Map(Object.entries(COUNTY_FIPS).map(([name, geoid]) => [geoid, name]));
  const urbanCache = new Map();
  const countyWhere = `STATE = '39' AND GEOID IN (${COUNTY_GEOIDS.map(sqlString).join(",")})`;
  const countyDistrict = (label, layerId, field, prefix) => ({
    label,
    choiceLabel: "District",
    load: (signal) => loadArcgisGeography({
      serviceUrl: `${TIGER_LEGISLATIVE}/${layerId}`,
      where: "STATE = '39'",
      outFields: `${field},STATE`,
      maxAllowableOffset: DISTRICT_OFFSET,
      value: (properties) => properties[field],
      label: (_properties, value) => `${prefix} - ${value}`,
    }, signal),
  });

  const acknowledgementsHtml = `
    <li><a href="${SOURCES[0].url}" target="_blank" rel="noopener">Franklin County Auditor parcel service</a> — parcel polygons and base appraisal attributes</li>
    <li><a href="${SOURCES[2].url}" target="_blank" rel="noopener">Cuyahoga County Fiscal Office parcel service</a> — parcel fabric with assessed-value and exemption fields</li>
    <li><a href="${SOURCES[3].url}" target="_blank" rel="noopener">Hamilton County CAGIS / Auditor parcel service</a> — CAGIS parcel polygons and source appraisal attributes</li>
    <li><a href="${SOURCES[1].url}" target="_blank" rel="noopener">Central Ohio regional parcel service</a> — Delaware, Fairfield, and Licking coverage; Franklin records are excluded here to avoid double counting</li>
    <li><a href="https://tigerweb.geo.census.gov/" target="_blank" rel="noopener">U.S. Census Bureau TIGERweb</a> — selected Ohio county and place boundaries plus 2026-vintage legislative and 119th Congress boundaries</li>`;

  function taxJurisdictionDetails(properties) {
    return {
      county: null,
      municipality: null,
      rate: PLACEHOLDER_RATE,
      jurisdiction: "Ohio selected-county coverage",
    };
  }

  window.ParcelStates.register({
    id: "OH",
    name: "Ohio",
    center: [40.3, -82.8],
    zoom: 7,
    brand: {
      eyebrow: "Ohio property insights",
      dataNote: "Four live parcel services; currently six counties, with mixed source valuation bases",
      acknowledgementsHtml,
    },
    tax: {
      description: "Ohio coverage starts with Franklin, Cuyahoga, Hamilton, Delaware, Fairfield, and Licking counties. Market appraisals are converted to a modeled 35%-of-market assessed base where needed; Cuyahoga's reported assessed values are used directly. Tax estimates remain illustrative.",
      scopeLabel: "Illustrative tax on modeled assessment (placeholder rate)",
      shortLabel: "Illustrative Property Tax",
      rateNote: `No certified parcel-level composite rates are configured. The ${(PLACEHOLDER_RATE * 1000).toFixed(1)}-mill placeholder is illustrative, and modeled assessed values for three county services use the statutory 35% market-value ratio; tax-dollar results are not official estimates.`,
    },
    parcels: {
      analysisUrl: SOURCES[0].url,
      analysisSources: SOURCES,
      strictCountySources: true,
      analysisGeometry: "polygon",
      shapesUrl: SOURCES[0].url,
      shapesCarryAttributes: true,
      allowAllGeographies: false,
      generalizeShapes: true,
      outFields: "OBJECTID,OH_LAND,OH_TOTAL,OH_IMPROVEMENT,OH_PARCEL_ID,OH_COUNTY,OH_CLASS,OH_CLASS_DESCRIPTION,OH_AGRICULTURAL,OH_SFH,OH_HOMESTEAD,OH_EXEMPT,OH_SOURCE,OH_ADDRESS,OH_RAW_LAND,OH_RAW_IMPROVEMENT,OH_RAW_TOTAL,OH_VALUE_BASIS",
      taxableWhere: "OH_TOTAL > 0 AND OH_LAND IS NOT NULL AND OH_LAND >= 0 AND OH_LAND <= OH_TOTAL",
      objectIdField: "OBJECTID",
      pageSize: 1000,
      downloadBatchSize: 500,
      percentileExpressions: false,
    },
    fields: {
      land: "OH_LAND",
      improvement: "OH_LAND",
      improvementCount: "OH_LAND",
      total: "OH_TOTAL",
      improvementFromTotalMinusLand: true,
    },
    values: (properties) => ({
      land: numberOrNull(properties.OH_LAND),
      improvement: numberOrNull(properties.OH_IMPROVEMENT),
      total: numberOrNull(properties.OH_TOTAL),
    }),
    jurisdictionGroupBy: null,
    taxJurisdictionDetails,
    sfh: {
      where: "OH_SFH = 1 AND OH_TOTAL > OH_LAND",
      whereBySource: Object.fromEntries(SOURCES.map((source) => [source.key, `(${source.sfhWhere || "1=0"}) AND ${source.fieldMap.OH_TOTAL} > ${source.fieldMap.OH_LAND}`])),
      matches: (properties) => isSfh(properties),
      definition: "County-specific class/use-code proxy for improved single-family parcels; it does not independently verify detached housing or owner occupancy.",
    },
    propertyTypes: PROPERTY_TYPES,
    occupancy: {
      groups: [{ key: "", label: "Not reported" }],
      definition: "Some source layers publish homestead indicators, but the schema and meaning are not consistent enough to report a statewide occupancy split.",
    },
    geographies: {
      stateSenate: countyDistrict("Ohio State Senate districts (2026 TIGERweb vintage)", 1, "SLDU", "Ohio Senate"),
      stateHouse: countyDistrict("Ohio State House districts (2026 TIGERweb vintage)", 2, "SLDL", "Ohio House"),
      congressional: countyDistrict("U.S. congressional districts (119th Congress)", 4, "CD119", "U.S."),
      county: {
        label: "Counties with parcel-service coverage",
        choiceLabel: "County",
        load: (signal) => loadArcgisGeography({
          serviceUrl: TIGER_COUNTIES,
          where: countyWhere,
          outFields: "GEOID,STATE,NAME,COUNTY",
          maxAllowableOffset: AREA_OFFSET,
          value: (properties) => properties.GEOID,
          label: (properties) => properties.NAME,
          county: (properties) => countyNameFromGeoid.get(String(properties.GEOID)) || properties.NAME.replace(/ County$/i, ""),
        }, signal),
        // The source set is restricted to this exact county. Avoid a costly county-polygon
        // spatial filter; Central Ohio adds its county-name predicate per source.
        attributeFilter: (feature) => COUNTY_FIPS[countyNameFromGeoid.get(String(feature.properties.raw.GEOID))] ? "1=1" : null,
      },
      municipality: {
        label: "Ohio incorporated places",
        choiceLabel: "Place",
        load: (signal) => loadArcgisGeography({
          serviceUrl: TIGER_PLACES,
          where: "STATE = '39'",
          outFields: "GEOID,STATE,NAME,BASENAME,PLACE",
          maxAllowableOffset: AREA_OFFSET,
          value: (properties) => properties.GEOID,
          label: (properties) => properties.BASENAME || properties.NAME,
        }, signal),
      },
    },
    geographyOrder: ["stateSenate", "stateHouse", "congressional", "county", "municipality"],
    defaultGeography: "county",
    exportDistricts: [
      { type: "stateSenate", header: "STATE_SENATE_DISTRICT", description: "2026 TIGERweb Ohio Senate district containing the parcel centroid." },
      { type: "stateHouse", header: "STATE_HOUSE_DISTRICT", description: "2026 TIGERweb Ohio House district containing the parcel centroid." },
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
      title: (properties) => properties.OH_ADDRESS || properties.OH_PARCEL_ID || "Selected parcel",
      sortKey: (properties) => [properties.OH_COUNTY, properties.OH_PARCEL_ID],
      rows: (properties, { formatCurrency }) => [
        ["County", properties.OH_COUNTY],
        ["Parcel ID", properties.OH_PARCEL_ID],
        ["Address", properties.OH_ADDRESS],
        ["Data source", properties.OH_SOURCE],
        ["Assessment basis", properties.OH_VALUE_BASIS],
        ["Parcel class / use", properties.OH_CLASS_DESCRIPTION || properties.OH_CLASS],
        ["Agricultural proxy", properties.OH_AGRICULTURAL ? "Yes" : "No / not identified"],
        ["Land modeled assessment", `${formatCurrency(properties.OH_LAND)}${percentOf(properties.OH_LAND, properties.OH_TOTAL)}`],
        ["Improvement modeled assessment (total − land)", `${formatCurrency(properties.OH_IMPROVEMENT)}${percentOf(properties.OH_IMPROVEMENT, properties.OH_TOTAL)}`],
        ["Total modeled assessment", `${formatCurrency(properties.OH_TOTAL)}${Number(properties.OH_TOTAL) ? " (100%)" : ""}`],
        ["Source land value", properties.OH_RAW_LAND === null ? null : formatCurrency(properties.OH_RAW_LAND)],
        ["Source total value", properties.OH_RAW_TOTAL === null ? null : formatCurrency(properties.OH_RAW_TOTAL)],
        ["Homestead indicator", properties.OH_HOMESTEAD ? "Yes" : "No / unavailable"],
      ],
    },
    csv: {
      headers: ["COUNTY", "PARCEL_ID", "ADDRESS", "SOURCE", "VALUE_BASIS", "CLASS", "CLASS_DESCRIPTION", "AGRICULTURAL_PROXY", "HOMESTEAD_INDICATOR", "RAW_LAND", "RAW_IMPROVEMENT", "RAW_TOTAL", "MODELED_ASSESSED_LAND", "MODELED_ASSESSED_IMPROVEMENT", "MODELED_ASSESSED_TOTAL"],
      row: (properties) => [
        properties.OH_COUNTY, properties.OH_PARCEL_ID, properties.OH_ADDRESS, properties.OH_SOURCE, properties.OH_VALUE_BASIS,
        properties.OH_CLASS, properties.OH_CLASS_DESCRIPTION, properties.OH_AGRICULTURAL ? "Y" : "N", properties.OH_HOMESTEAD ? "Y" : "N",
        properties.OH_RAW_LAND, properties.OH_RAW_IMPROVEMENT, properties.OH_RAW_TOTAL,
        properties.OH_LAND, properties.OH_IMPROVEMENT, properties.OH_TOTAL,
      ],
    },
    report: {
      title: "PARCEL ANALYSIS - OHIO - SELECTED-COUNTY SPLIT-RATE SCENARIO",
      accountNoun: "parcel records",
      unitDescription: "The live-service pilot currently covers Franklin, Cuyahoga, Hamilton, Delaware, Fairfield, and Licking counties; it is not a statewide Ohio parcel roll.",
      caveats: [
        "The four connected parcel services overlap. The Central Ohio regional source is restricted to Delaware, Fairfield, and Licking; Franklin data is taken only from the Franklin County Auditor service to prevent double counting.",
        "Franklin, Central Ohio, and Hamilton publish base/market appraisal values that are scaled by Ohio's statutory 35% assessment ratio. Cuyahoga supplies assessed land, improvement, and total attributes directly. The resulting assessment base is modeled and not independently reconciled against every county's certified roll, CAUV treatment, exemption, abatements, or tax credits.",
        `A uniform ${(PLACEHOLDER_RATE * 1000).toFixed(1)}-mill rate is an illustrative placeholder, not a certified county or parcel rate. Current-tax and revenue-neutral outputs are not official tax estimates.`,
        "Coverage is limited to six urban counties. County-level parcel counts are from live services and may change; districts and places may intersect counties without source coverage, so those geography totals represent only covered parcels.",
        "Explicit exemption classes are filtered where the source clearly identifies them, but positive-value filters are not legal determinations of taxability. Exemptions, abatements, CAUV adjustments, delinquency status, and parcel-specific credits are not fully reconciled across the four feeds.",
        "Property classes, land-use descriptions, CAUV codes, and homestead indicators differ by service. Agricultural, vacant, and single-family categories are proxies; Hamilton's class-code interpretation and county-specific class mappings need review against each auditor's data dictionary.",
        "Census TIGERweb place and district boundaries are analytical geographies, not survey or authoritative tax-boundary determinations. Parcel membership uses parcel centroids.",
        "The Cuyahoga hosted FeatureServer does not provide low-zoom map export; parcel shapes are drawn at zoom 14 and above. Other connected layers are also queried live and can be subject to service downtime or schema updates.",
      ],
      rateDefinition: "The illustrative rate is a common placeholder applied to the modeled assessed-value base; it does not represent Ohio statutory rates or actual tax bills.",
      sfhNotes: "County-specific class/use-code proxy for improved single-family property; detached form and owner occupancy are not independently verified.",
      sourceLines: SOURCES.map((source) => `${source.label}: ${source.url}`),
      csvColumnNotes: [
        "MODELED_ASSESSED_LAND, MODELED_ASSESSED_IMPROVEMENT, and MODELED_ASSESSED_TOTAL drive the model; improvement is derived as total minus land to ensure reconciliation.",
        "RAW_LAND, RAW_IMPROVEMENT, RAW_TOTAL, and VALUE_BASIS preserve the original feed values and identify whether values were assessed directly or modeled at 35% of source-reported market/base appraisal.",
        "County and parcel identifiers are normalized for export across the four distinct source schemas; agricultural and homestead columns are classification indicators only, not legal determinations.",
      ],
    },
  });
})();

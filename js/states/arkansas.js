"use strict";

// Arkansas: AGISO publishes matching statewide CAMA parcel points and polygons.
// Points drive statistics and geography membership; polygon shapes are joined by
// the shared county and parcel identifiers (pattern C).
(() => {
  const POINTS_URL = "https://gis.arkansas.gov/arcgis/rest/services/FEATURESERVICES/Planning_Cadastre/FeatureServer/0";
  const SHAPES_URL = "https://gis.arkansas.gov/arcgis/rest/services/FEATURESERVICES/Planning_Cadastre/FeatureServer/6";
  const TIGER_LEGISLATIVE = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Legislative/MapServer";
  const TIGER_COUNTIES = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/55";
  const TIGER_PLACES = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/25";
  const TAXABLE_WHERE = "totalvalue > 0 AND landvalue IS NOT NULL AND countyfips IS NOT NULL AND countyid IS NOT NULL AND parcelid IS NOT NULL";
  const DISTRICT_OFFSET = 0.00003;
  const AREA_OFFSET = 0.0002;

  const parcelType = (properties) => String(properties.parceltype || "").trim().toUpperCase();
  const isAgricultural = (properties) => parcelType(properties).startsWith("A");
  const isResidentialImproved = (properties) => parcelType(properties) === "RI";
  const isImproved = (properties) => properties.impvalue !== null
    && properties.impvalue !== undefined
    && Number(properties.impvalue) > 0;
  const NOT_AGRICULTURAL = "(parceltype IS NULL OR parceltype NOT LIKE 'A%')";
  const IMPROVED = "impvalue > 0";
  const SFH_WHERE = `${IMPROVED} AND parceltype = 'RI'`;

  const PROPERTY_TYPES = [
    {
      key: "agricultural",
      label: "Agricultural (parcel-code proxy)",
      definition: "ParcelType codes beginning with A (observed codes include AI, AM, and AV). The source does not provide a statewide land-use description, so this is a code-based proxy.",
      where: "parceltype LIKE 'A%'",
      matches: ({ properties }) => isAgricultural(properties),
    },
    {
      key: "vacant",
      label: "No reported improvements",
      definition: "Non-agricultural proxy parcels with no positive reported improvement value; this includes records whose improvement value is missing.",
      where: `${NOT_AGRICULTURAL} AND (impvalue IS NULL OR impvalue <= 0)`,
      matches: ({ properties, improved }) => !isAgricultural(properties) && !improved,
    },
    {
      key: "sfh",
      label: "Residential improved (SFH proxy)",
      definition: "Improved parcels with ParcelType RI. This is a broad residential-improved proxy, not a verified detached single-family classification.",
      where: SFH_WHERE,
      matches: ({ properties }) => isResidentialImproved(properties) && isImproved(properties),
    },
    {
      key: "other",
      label: "Other improved property",
      definition: "Remaining non-agricultural improved parcels, including all classes other than the RI residential-improved proxy.",
      where: `${IMPROVED} AND ${NOT_AGRICULTURAL} AND (parceltype IS NULL OR parceltype <> 'RI')`,
      matches: ({ properties, improved }) => !isAgricultural(properties) && improved && !isResidentialImproved(properties),
    },
  ];

  // Placeholder only: replace with certified county and local rates before citing estimates.
  const PLACEHOLDER_COUNTY_RATE = 0.0065;
  function taxJurisdictionDetails(properties) {
    const name = String(properties.county || "").trim();
    const code = String(properties.countyfips || "").trim();
    const county = name ? `${titleCase(name)} County` : code ? `County ${code}` : "Unknown county";
    return {
      county,
      municipality: null,
      rate: name || code ? PLACEHOLDER_COUNTY_RATE : null,
      jurisdiction: county,
    };
  }

  const districtGeography = (label, layerId, field, prefix) => ({
    label,
    choiceLabel: "District",
    load: (signal) => loadArcgisGeography({
      serviceUrl: `${TIGER_LEGISLATIVE}/${layerId}`,
      where: "STATE = '05'",
      outFields: `${field},STATE`,
      maxAllowableOffset: DISTRICT_OFFSET,
      value: (properties) => properties[field],
      label: (properties, value) => `${prefix} - ${value}`,
    }, signal),
  });

  const parcelKey = (properties) => {
    const countyId = String(properties.countyid || "").trim();
    const parcelId = String(properties.parcelid || "").trim();
    return countyId && parcelId ? `${countyId}|${parcelId}` : "";
  };

  const acknowledgementsHtml = `
    <li><a href="${POINTS_URL}" target="_blank" rel="noopener">Arkansas GIS Office parcel centroids</a> — CAMA parcel attributes and source-reported values</li>
    <li><a href="${SHAPES_URL}" target="_blank" rel="noopener">Arkansas GIS Office parcel polygons</a> — parcel geometry, joined to centroids by county and parcel identifiers</li>
    <li><a href="https://tigerweb.geo.census.gov/" target="_blank" rel="noopener">U.S. Census Bureau TIGERweb</a> — congressional and state legislative districts; counties, places, and 2020 urban areas</li>`;

  const optional = (value) => (value === null || value === undefined || value === "" ? null : value);
  const percentOf = (part, total) => (Number(total) ? ` (${((Number(part) / Number(total)) * 100).toFixed(0)}%)` : "");
  const formatDate = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const date = new Date(Number(value));
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  };
  const urbanCache = new Map();

  window.ParcelStates.register({
    id: "AR",
    name: "Arkansas",
    center: [34.8, -92.3],
    zoom: 7,
    brand: {
      eyebrow: "Arkansas property insights",
      dataNote: "Parcel data provided by the Arkansas GIS Office; county coverage may be partial",
      acknowledgementsHtml,
    },
    tax: {
      description: "Load Arkansas parcels with positive source-reported total value and a reported land value. Current tax uses a statewide placeholder applied to TotalValue, not certified county rates or parcel tax bills.",
      scopeLabel: "Illustrative county property tax (placeholder rate)",
      shortLabel: "Illustrative Property Tax",
      rateNote: `Certified Arkansas jurisdictional rates are not configured. Every county currently uses an illustrative ${(PLACEHOLDER_COUNTY_RATE * 1000).toFixed(1)}-mill placeholder applied to source-reported TotalValue; replace it before citing tax-dollar results.`,
    },
    parcels: {
      analysisUrl: POINTS_URL,
      analysisGeometry: "point",
      shapesUrl: SHAPES_URL,
      shapeWhere: TAXABLE_WHERE,
      shapeOutFields: "objectid,countyfips,countyid,parcelid",
      shapeJoin: { shapeKey: parcelKey, pointKey: parcelKey },
      generalizeShapes: true,
      outFields: "objectid,globalid,countyfips,countyid,parcelid,parcellgl,adrlabel,adrcity,adrzip5,parceltype,assessvalue,impvalue,landvalue,totalvalue,taxcode,taxarea,camakey,county,dataprov,camaprov,camadate,pubdate,sourceref,sourcedate,subdivision,nbhd,str,section,township,range",
      taxableWhere: TAXABLE_WHERE,
      objectIdField: "objectid",
      pageSize: 200,
      pointPageSize: 200,
      downloadBatchSize: 200,
    },
    fields: { land: "landvalue", improvement: "impvalue", improvementCount: "impvalue", total: "totalvalue" },
    values: (properties) => ({
      land: Number(properties.landvalue),
      improvement: properties.impvalue === null || properties.impvalue === undefined ? null : Number(properties.impvalue),
      total: Number(properties.totalvalue),
    }),
    jurisdictionGroupBy: "countyfips,county",
    taxJurisdictionDetails,
    sfh: {
      where: SFH_WHERE,
      matches: (properties) => isResidentialImproved(properties) && isImproved(properties),
      definition: "Proxy only: positive improvement value and ParcelType RI (residential improved). The source does not identify detached single-family homes separately.",
    },
    propertyTypes: PROPERTY_TYPES,
    occupancy: {
      groups: [{ key: "", label: "Not reported" }],
      definition: "The statewide parcel service does not provide an owner-occupancy or homestead field.",
    },
    geographies: {
      stateSenate: districtGeography("Arkansas State Senate districts (2024; 2026 Census vintage)", 5, "SLDU", "AR Senate"),
      stateHouse: districtGeography("Arkansas State House districts (2024; 2026 Census vintage)", 6, "SLDL", "AR House"),
      congressional: districtGeography("U.S. congressional districts (119th Congress; 2026 Census vintage)", 4, "CD119", "U.S."),
      county: {
        label: "Counties",
        choiceLabel: "County",
        verifyAttributeFilter: true,
        load: (signal) => loadArcgisGeography({
          serviceUrl: TIGER_COUNTIES,
          where: "STATE = '05'",
          outFields: "NAME,STATE,GEOID",
          maxAllowableOffset: AREA_OFFSET,
          value: (properties) => properties.GEOID,
          label: (properties) => properties.NAME,
          county: (properties) => properties.NAME,
        }, signal),
        attributeFilter: (feature) => {
          const geoId = String(feature.properties.raw.GEOID || "");
          const countyFips = geoId.length >= 5 ? geoId.slice(-3) : "";
          return countyFips ? `countyfips = ${sqlString(countyFips)}` : null;
        },
      },
      municipality: {
        label: "Incorporated places",
        choiceLabel: "Municipality",
        load: (signal) => loadArcgisGeography({
          serviceUrl: TIGER_PLACES,
          where: "STATE = '05'",
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
      { type: "stateSenate", header: "STATE_SENATE_DISTRICT", description: "2024 Arkansas State Senate district containing the parcel point." },
      { type: "stateHouse", header: "STATE_HOUSE_DISTRICT", description: "2024 Arkansas State House district containing the parcel point." },
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
      title: (properties) => String(properties.adrlabel || properties.parcelid || "Selected parcel").trim() || "Selected parcel",
      sortKey: (properties) => [properties.adrlabel, properties.parcelid],
      rows: (properties, { formatCurrency }) => [
        ["Parcel ID", optional(properties.parcelid)],
        ["Parcel class code", optional(properties.parceltype)],
        ["Situs label", optional(properties.adrlabel)],
        ["City", optional(properties.adrcity)],
        ["County", optional(properties.county)],
        ["Land value", `${formatCurrency(properties.landvalue)}${percentOf(properties.landvalue, properties.totalvalue)}`],
        ["Improvement value", `${formatCurrency(properties.impvalue)}${percentOf(properties.impvalue, properties.totalvalue)}`],
        ["Total reported value", `${formatCurrency(properties.totalvalue)}${Number(properties.totalvalue) ? " (100%)" : ""}`],
        ["Separate reported AssessValue", optional(properties.assessvalue) === null ? null : formatCurrency(properties.assessvalue)],
        ["CAMA data date", formatDate(properties.camadate)],
      ],
    },
    csv: {
      headers: [
        "countyfips", "countyid", "parcelid", "parcellgl", "adrlabel", "adrcity", "adrzip5", "parceltype",
        "landvalue", "impvalue", "totalvalue", "assessvalue", "taxcode", "taxarea", "camakey", "county",
        "dataprov", "camaprov", "camadate", "pubdate", "sourceref", "sourcedate", "subdivision", "nbhd", "str", "section", "township", "range",
      ],
      row: (properties) => [
        properties.countyfips, properties.countyid, properties.parcelid, properties.parcellgl, properties.adrlabel, properties.adrcity,
        properties.adrzip5, properties.parceltype, Number(properties.landvalue), properties.impvalue === null || properties.impvalue === undefined
          ? null : Number(properties.impvalue), Number(properties.totalvalue), properties.assessvalue, properties.taxcode, properties.taxarea,
        properties.camakey, properties.county, properties.dataprov, properties.camaprov, properties.camadate, properties.pubdate,
        properties.sourceref, properties.sourcedate, properties.subdivision, properties.nbhd, properties.str, properties.section,
        properties.township, properties.range,
      ],
    },
    report: {
      title: "PARCEL ANALYSIS - ARKANSAS - SPLIT-RATE PROPERTY TAX SUMMARY",
      accountNoun: "parcels",
      unitDescription: "Each record is one AGISO parcel point; polygon outlines are joined by countyid and parcelid.",
      caveats: [
        `Certified Arkansas county and local tax rates are not configured; current tax applies an illustrative ${(PLACEHOLDER_COUNTY_RATE * 1000).toFixed(1)}-mill placeholder to source-reported TotalValue. These are not actual parcel tax bills.`,
        "The Arkansas GIS Office warns that the statewide publication may be incomplete within counties (for example, covering only a county section or only rural or urban parcels). Positive-value records occur in all 75 counties, but this does not establish complete assessor-roll coverage.",
        "The model uses source-reported LandValue, ImpValue, and TotalValue. AssessValue is a separate field: in the live feed it is positive for only 68.6% of positive-TotalValue records and its ratio to TotalValue varies by parcel type. The model does not treat it as a complete, uniform taxable base or infer component assessments from it.",
        "No parcel tax bills, exemption indicator, or owner-occupancy/homestead field is provided. The positive-value filter is not a determination of legal taxability and does not apply exemptions or credits.",
        "Property classes are approximate: ParcelType codes beginning with A are used as an agricultural proxy, RI is used as a broad residential-improved/SFH proxy, and remaining classes are grouped by reported improvement value. This is not a verified land-use or detached-home classification.",
        "CAMA data dates vary by county. Parcel boundaries are approximate cadastral representations and are not legal survey boundaries.",
        "The hosted FeatureServer has no low-zoom map image; parcel outlines are drawn at zoom 14+. Census TIGERweb boundaries are used for counties, places, and 2026-vintage legislative and congressional districts.",
      ],
      rateDefinition: "Rates are shown as a percentage of source-reported TotalValue ($ per $100), not the separate AssessValue field. Current tax is an illustrative county-level placeholder, not a certified rate or actual tax bill.",
      sfhNotes: "Benchmark proxy: positive improvement value and ParcelType RI (residential improved). The source does not distinguish detached homes from other residential improvements.",
      sourceLines: [`Arkansas GIS Office parcel points: ${POINTS_URL}`, `Arkansas GIS Office parcel polygons: ${SHAPES_URL}`],
      csvColumnNotes: [
        "countyfips, countyid, parcelid: source county and parcel identifiers; polygons are joined to points by countyid + parcelid.",
        "adrlabel, adrcity, adrzip5, parcellgl: source situs label, locality, ZIP, and legal description; owner names are not included.",
        "landvalue, impvalue, totalvalue: source-reported value components used in the model. assessvalue is a separate field with incomplete positive-value coverage and is not the model base.",
        "parceltype, taxcode, taxarea, camakey, dataprov, camaprov, camadate, pubdate, sourceref, sourcedate: source classification, tax/CAMA identifiers, providers, and update dates.",
      ],
    },
  });
})();
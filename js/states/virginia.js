"use strict";

// Virginia: the supplied assessor feed covers Essex County only. Treat this as a
// selected-locality pilot; statewide boundary choices are limited to districts
// that overlap Essex County so every listed geography has source parcel coverage.
(() => {
  const PARCEL_URL = "https://services7.arcgis.com/hPGyuBCaFm583AVs/arcgis/rest/services/Tax_Parcels_20230726/FeatureServer/5";
  const TIGER_LEGISLATIVE = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Legislative/MapServer";
  const TIGER_COUNTIES = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/55";
  const TIGER_PLACES = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/25";
  const STATE_FIPS = "51";
  const ESSEX_GEOID = "51057";
  const TAPPAHANNOCK_GEOID = "5177568";
  const PLACEHOLDER_RATE = 0.0065;
  const DISTRICT_OFFSET = 0.00003;
  const AREA_OFFSET = 0.0002;
  const TAXABLE_WHERE = "TotalParc > 0 AND TotalLand IS NOT NULL AND TotalLand >= 0 AND TotalImp IS NOT NULL AND TotalImp >= 0 AND TotalLand <= TotalParc AND TotalImp <= TotalParc";
  const OUT_FIELDS = [
    "FID", "GlobalID", "PID", "TaxJoinGIS", "TaxMap", "Address", "LegalDescr", "Zoning", "PrimaryUse",
    "LegalAcre", "GISacres", "TotalLand", "TotalImp", "TotalParc",
  ].join(",");

  const hasValue = (value) => value !== null && value !== undefined && value !== "";
  const numberOrNull = (value) => hasValue(value) && Number.isFinite(Number(value)) ? Number(value) : null;
  const optional = (value) => hasValue(value) ? value : null;
  const percentOf = (part, total) => Number(total) ? ` (${((Number(part) / Number(total)) * 100).toFixed(0)}%)` : "";
  const primaryUseCode = (properties) => String(properties.PrimaryUse || "").trim().toUpperCase();
  const isImproved = (properties) => (numberOrNull(properties.TotalImp) || 0) > 0;
  const isVacant = (properties, improved = isImproved(properties)) => primaryUseCode(properties).endsWith("V") || !improved;
  const isResidentialImproved = (properties) => primaryUseCode(properties).endsWith("R") && isImproved(properties);

  const VACANT_WHERE = "(UPPER(PrimaryUse) LIKE '%V' OR TotalImp <= 0)";
  const RESIDENTIAL_WHERE = "UPPER(PrimaryUse) LIKE '%R'";
  const OTHER_WHERE = "TotalImp > 0 AND (PrimaryUse IS NULL OR UPPER(PrimaryUse) NOT LIKE '%V') AND (PrimaryUse IS NULL OR UPPER(PrimaryUse) NOT LIKE '%R')";
  const PROPERTY_TYPES = [
    {
      key: "agricultural",
      label: "Agricultural class not reported",
      definition: "The source does not identify agricultural use or an agricultural assessment class. Agricultural parcels cannot be separated from other properties in this feed.",
      where: "1=0",
      matches: () => false,
    },
    {
      key: "vacant",
      label: "Vacant / no positive improvements",
      definition: "PrimaryUse codes ending in V, or records with no positive reported improvement value. This is a source-code/value proxy, not a legal vacant-land determination.",
      where: VACANT_WHERE,
      matches: ({ properties, improved }) => isVacant(properties, improved),
    },
    {
      key: "sfh",
      label: "Residential-use proxy (SFH benchmark)",
      definition: "Improved records with a PrimaryUse code ending in R. The source's Residential designation does not verify detached single-family form or owner occupancy.",
      where: `${RESIDENTIAL_WHERE} AND TotalImp > 0`,
      matches: ({ properties }) => isResidentialImproved(properties),
    },
    {
      key: "other",
      label: "Other improved property",
      definition: "Remaining improved records, including commercial, mobile-home, blank, and other PrimaryUse codes. Use codes do not establish tax class or legal use.",
      where: OTHER_WHERE,
      matches: ({ properties, improved }) => improved
        && !isVacant(properties, improved)
        && !isResidentialImproved(properties),
    },
  ];

  function taxJurisdictionDetails() {
    return {
      county: "Essex County",
      municipality: null,
      rate: PLACEHOLDER_RATE,
      jurisdiction: "Essex County (placeholder)",
    };
  }

  const districtGeography = (label, layerId, field, values, prefix) => ({
    label,
    choiceLabel: "District",
    load: (signal) => loadArcgisGeography({
      serviceUrl: `${TIGER_LEGISLATIVE}/${layerId}`,
      where: `STATE = ${sqlString(STATE_FIPS)} AND ${field} IN (${sqlList(values)})`,
      outFields: `${field},STATE`,
      maxAllowableOffset: DISTRICT_OFFSET,
      value: (properties) => properties[field],
      label: (_properties, value) => `${prefix} - ${value}`,
    }, signal),
  });

  const urbanCache = new Map();
  const acknowledgementsHtml = `
    <li><a href="${PARCEL_URL}" target="_blank" rel="noopener">Essex County, Virginia tax-parcel layer</a> — parcel polygons, appraised land/improvement/total values, and PrimaryUse codes</li>
    <li><a href="https://tigerweb.geo.census.gov/" target="_blank" rel="noopener">U.S. Census Bureau TIGERweb</a> — 2026 Virginia legislative districts, 119th Congress districts, Essex County, Tappahannock town, and 2020 urban areas</li>`;

  window.ParcelStates.register({
    id: "VA",
    name: "Virginia",
    center: [37.95, -76.92],
    zoom: 9,
    brand: {
      eyebrow: "Virginia property insights",
      dataNote: "Essex County pilot only; statewide parcel coverage is not available in the supplied feed",
      acknowledgementsHtml,
    },
    tax: {
      description: "The supplied Essex County feed reports appraised parcel values, not verified taxable assessments or parcel tax bills. Current tax and split-rate scenarios use an illustrative placeholder.",
      scopeLabel: "Illustrative Essex County property tax (placeholder rate)",
      shortLabel: "Illustrative Property Tax",
      rateNote: `Certified Essex County and Tappahannock rates are not configured. The ${(PLACEHOLDER_RATE * 1000).toFixed(1)}-mill placeholder is applied to source-reported TotalParc, which is not a verified taxable assessment; replace it before citing tax-dollar results.`,
    },
    parcels: {
      analysisUrl: PARCEL_URL,
      analysisGeometry: "polygon",
      shapesUrl: PARCEL_URL,
      shapesCarryAttributes: true,
      allowAllGeographies: false,
      generalizeShapes: true,
      outFields: OUT_FIELDS,
      taxableWhere: TAXABLE_WHERE,
      objectIdField: "FID",
      pageSize: 2000,
      downloadBatchSize: 500,
    },
    fields: {
      land: "TotalLand",
      improvement: "TotalImp",
      improvementCount: "TotalImp",
      total: "TotalParc",
    },
    values: (properties) => ({
      land: numberOrNull(properties.TotalLand),
      improvement: numberOrNull(properties.TotalImp),
      total: numberOrNull(properties.TotalParc),
    }),
    jurisdictionGroupBy: null,
    taxJurisdictionDetails,
    sfh: {
      where: `${RESIDENTIAL_WHERE} AND TotalImp > 0`,
      matches: (properties) => isResidentialImproved(properties),
      definition: "Benchmark proxy: positive reported improvements and a PrimaryUse code ending in R (Residential). The source does not identify detached single-family homes or owner occupancy.",
    },
    propertyTypes: PROPERTY_TYPES,
    occupancy: {
      groups: [{ key: "", label: "Not reported" }],
      definition: "The parcel layer does not report owner occupancy, homestead status, or a comparable field.",
    },
    geographies: {
      stateSenate: districtGeography("Virginia State Senate districts (2026 Census TIGERweb vintage)", 1, "SLDU", ["025"], "Virginia Senate"),
      stateHouse: districtGeography("Virginia House of Delegates districts (2026 Census TIGERweb vintage)", 2, "SLDL", ["067", "068"], "Virginia House of Delegates"),
      congressional: districtGeography("U.S. congressional districts (119th Congress)", 4, "CD119", ["01", "07"], "U.S. House"),
      county: {
        label: "Counties with parcel coverage",
        choiceLabel: "County",
        load: (signal) => loadArcgisGeography({
          serviceUrl: TIGER_COUNTIES,
          where: `STATE = ${sqlString(STATE_FIPS)} AND GEOID = ${sqlString(ESSEX_GEOID)}`,
          outFields: "GEOID,STATE,NAME,COUNTY",
          maxAllowableOffset: AREA_OFFSET,
          value: (properties) => properties.GEOID,
          label: (properties) => properties.NAME,
          county: (properties) => properties.NAME,
        }, signal),
        // The only connected parcel layer is published for Essex County and has no county field.
        attributeFilter: (feature) => String(feature.properties.raw.GEOID) === ESSEX_GEOID ? "1=1" : null,
      },
      municipality: {
        label: "Municipalities with parcel coverage",
        choiceLabel: "Municipality",
        load: (signal) => loadArcgisGeography({
          serviceUrl: TIGER_PLACES,
          where: `STATE = ${sqlString(STATE_FIPS)} AND GEOID = ${sqlString(TAPPAHANNOCK_GEOID)}`,
          outFields: "GEOID,STATE,BASENAME,NAME,PLACE",
          maxAllowableOffset: AREA_OFFSET,
          value: (properties) => properties.GEOID,
          label: (properties) => `${properties.BASENAME || properties.NAME} town`,
          county: () => "Essex County",
        }, signal),
      },
    },
    geographyOrder: ["stateSenate", "stateHouse", "congressional", "county", "municipality"],
    defaultGeography: "county",
    exportDistricts: [
      { type: "stateSenate", header: "STATE_SENATE_DISTRICT", description: "2026 Census TIGERweb Virginia Senate district containing the parcel polygon centroid; limited to Essex-overlapping District 25." },
      { type: "stateHouse", header: "STATE_HOUSE_DISTRICT", description: "2026 Census TIGERweb Virginia House of Delegates district containing the parcel polygon centroid; limited to Essex-overlapping Districts 67 and 68." },
      { type: "congressional", header: "CONGRESSIONAL_DISTRICT", description: "119th Congress district containing the parcel polygon centroid; limited to Essex-overlapping Districts 1 and 7." },
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
      title: (properties) => optional(properties.Address) || optional(properties.PID) || "Selected Essex County parcel",
      sortKey: (properties) => [properties.TaxMap, properties.PID, properties.FID],
      rows: (properties, { formatCurrency }) => [
        ["County", "Essex County"],
        ["Parcel ID", optional(properties.PID)],
        ["Tax map", optional(properties.TaxMap)],
        ["Site address", optional(properties.Address)],
        ["Legal description", optional(properties.LegalDescr)],
        ["Primary use code", optional(properties.PrimaryUse)],
        ["Zoning", optional(properties.Zoning)],
        ["Land appraised value", `${formatCurrency(properties.TotalLand)}${percentOf(properties.TotalLand, properties.TotalParc)}`],
        ["Improvement appraised value", `${formatCurrency(properties.TotalImp)}${percentOf(properties.TotalImp, properties.TotalParc)}`],
        ["Total parcel appraised value", `${formatCurrency(properties.TotalParc)}${Number(properties.TotalParc) ? " (100%)" : ""}`],
        ["Legal acres", numberOrNull(properties.LegalAcre)],
      ],
    },
    csv: {
      headers: ["FID", "GlobalID", "PID", "TaxJoinGIS", "TaxMap", "Address", "LegalDescr", "Zoning", "PrimaryUse", "LegalAcre", "GISacres", "TotalLand", "TotalImp", "TotalParc"],
      row: (properties) => [
        properties.FID, properties.GlobalID, properties.PID, properties.TaxJoinGIS, properties.TaxMap, properties.Address,
        properties.LegalDescr, properties.Zoning, properties.PrimaryUse, numberOrNull(properties.LegalAcre),
        numberOrNull(properties.GISacres), numberOrNull(properties.TotalLand), numberOrNull(properties.TotalImp),
        numberOrNull(properties.TotalParc),
      ],
    },
    report: {
      title: "PARCEL ANALYSIS - VIRGINIA - ESSEX COUNTY PILOT",
      accountNoun: "parcel records",
      unitDescription: "Each record is a geometry-bearing parcel feature from the supplied Essex County, Virginia layer. The layer does not provide statewide Virginia parcel coverage.",
      caveats: [
        "Coverage is limited to one county: the supplied parcel service is Essex County, not a statewide Virginia assessment roll. The live layer contains 10,255 features; 10,057 (98.1%) have positive TotalParc. County and municipal results cover Essex County and Tappahannock only. Legislative and congressional results include only the Essex County portion of districts that overlap the parcel feed, not statewide district totals.",
        "The publisher describes TotalLand, TotalImp, and TotalParc as values appraised by the Commissioner of the Revenue; the three components reconcile on all 10,057 positive-total records in the live audit. The parcel layer's name references a 2023 date, while its ArcGIS item title says it was updated in 2026; no explicit assessment/tax year or certified taxable/equalized value basis is supplied.",
        `A uniform ${(PLACEHOLDER_RATE * 1000).toFixed(1)}-mill rate is an illustrative placeholder, not a certified Essex County or Tappahannock rate or actual parcel tax bill. It is applied to source-reported TotalParc; tax-dollar and revenue-neutral outputs are not official estimates.`,
        "PrimaryUse codes identify Residential, Vacant, Commercial, or Mobile Home categories plus a relative-size component. A code ending in R is used only as a residential-improved SFH benchmark proxy; it does not verify detached housing. Codes ending in V or nonpositive improvements form the vacant proxy. Agricultural assessment/use is not separately identified; zoning is not treated as agricultural tax classification.",
        "The service has no parcel tax-bill, exemption, owner-occupancy, or homestead field. Positive and internally consistent values are an analysis filter, not a legal determination of taxability; exemptions, credits, and local levies are not modeled.",
        "The hosted FeatureServer has no low-zoom map image, so parcel polygons draw at zoom 14+. District membership is based on polygon centers. Census TIGERweb boundaries are analytical geographies and not a substitute for official tax or survey boundaries. Owner names and mailing addresses in the source are intentionally excluded from app queries, popups, and exports.",
      ],
      rateDefinition: "The illustrative 6.5-mill rate is applied to source-reported TotalParc ($ per $100); the layer does not provide a verified taxable base or parcel tax bills.",
      sfhNotes: "Benchmark proxy: improved parcels with a PrimaryUse code ending in R (Residential). This does not distinguish detached homes or verify owner occupancy.",
      sourceLines: [
        `Essex County parcel polygons and appraised values: ${PARCEL_URL}`,
        `U.S. Census Bureau TIGERweb 2026 Virginia legislative and 119th Congress boundaries: ${TIGER_LEGISLATIVE}`,
        `U.S. Census Bureau TIGERweb counties and places: ${TIGER_COUNTIES}; ${TIGER_PLACES}`,
        "U.S. Census Bureau TIGERweb 2020 urban areas: https://tigerweb.geo.census.gov/",
      ],
      csvColumnNotes: [
        "TotalLand, TotalImp, and TotalParc are source-described appraisal values; they reconciled for positive-total records in the live onboarding check. No explicit tax year or certified taxable-value basis is published in the layer metadata.",
        "PrimaryUse and Zoning are source classification fields used only for the documented broad residential and vacant proxies; they do not establish taxability, detached-home status, or agricultural assessment.",
        "Owner names and mailing addresses are omitted. PID, TaxJoinGIS, TaxMap, Address, and GlobalID are source parcel identifiers or situs fields; FID is unique only within this service.",
      ],
    },
  });
})();

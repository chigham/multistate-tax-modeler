"use strict";

// Montana: the Montana State Library cadastral OwnerParcel polygons carry selected
// Montana Department of Revenue parcel values and characteristics. The statewide layer
// has no point counterpart, so polygons drive statistics and drawing (pattern B).
(() => {
  const PARCELS_URL = "https://services.arcgis.com/qnjIrwR8z5Izc0ij/arcgis/rest/services/Cadastral_Application_Support/FeatureServer/5";
  const TIGER_LEGISLATIVE = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Legislative/MapServer";
  const TIGER_COUNTIES = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/55";
  const TIGER_PLACES = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/25";
  const TAXABLE_WHERE = "TotalValue > 0 AND TotalLandValue IS NOT NULL AND (PropType IS NULL OR PropType <> 'Exempt Property')";
  const DISTRICT_OFFSET = 0.00003;
  const AREA_OFFSET = 0.0002;

  const AGRICULTURAL_ACRE_FIELDS = [
    "ContinuousCropAcres", "FallowAcres", "FarmsiteAcres", "ForestAcres", "GrazingAcres", "WildHayAcres", "IrrigatedAcres",
  ];
  const AGRICULTURAL_WHERE = `(${AGRICULTURAL_ACRE_FIELDS.map((field) => `(${field} IS NOT NULL AND ${field} > 0)`).join(" OR ")})`;
  const NOT_AGRICULTURAL = `NOT ${AGRICULTURAL_WHERE}`;
  const IMPROVED = `${NOT_AGRICULTURAL} AND TotalBuildingValue > 0`;
  const SFH_WHERE = `${IMPROVED} AND PropType = 'Improved Property'`;

  const positiveAcreage = (properties) => AGRICULTURAL_ACRE_FIELDS.some((field) => Number(properties[field]) > 0);
  const isImproved = (properties) => properties.TotalBuildingValue !== null
    && properties.TotalBuildingValue !== undefined
    && Number(properties.TotalBuildingValue) > 0;
  const isSfhProxy = (properties) => !positiveAcreage(properties)
    && isImproved(properties)
    && String(properties.PropType || "").trim().toLowerCase() === "improved property";
  const PROPERTY_TYPES = [
    {
      key: "agricultural",
      label: "Agricultural acreage (proxy)",
      definition: "Parcels reporting positive crop, fallow, farmsite, forest, grazing, wild-hay, or irrigated acreage. This acreage-based proxy does not identify every agricultural parcel.",
      where: AGRICULTURAL_WHERE,
      matches: ({ properties }) => positiveAcreage(properties),
    },
    {
      key: "vacant",
      label: "Vacant / unimproved land",
      definition: "Non-agricultural proxy parcels with no reported building value.",
      where: `${NOT_AGRICULTURAL} AND (TotalBuildingValue IS NULL OR TotalBuildingValue <= 0)`,
      matches: ({ properties, improved }) => !positiveAcreage(properties) && !improved,
    },
    {
      key: "sfh",
      label: "Improved property (SFH proxy)",
      definition: "Improved parcels whose PropType is ‘Improved Property’. The source does not identify detached single-family homes separately, so this is a broad residential/other-improved proxy, not a true SFH count.",
      where: SFH_WHERE,
      matches: ({ properties }) => isSfhProxy(properties),
    },
    {
      key: "other",
      label: "Other improved property",
      definition: "All remaining non-agricultural parcels with positive building value, including apartments, condominiums, industrial, and other specialized property types.",
      where: `${IMPROVED} AND (PropType IS NULL OR PropType <> 'Improved Property')`,
      matches: ({ properties, improved }) => !positiveAcreage(properties)
        && improved
        && String(properties.PropType || "").trim().toLowerCase() !== "improved property",
    },
  ];

  // Placeholder only: replace with certified rates before using tax-dollar estimates.
  const PLACEHOLDER_COUNTY_RATE = 0.0065;
  function taxJurisdictionDetails(properties) {
    const name = String(properties.CountyName || "").trim();
    const county = name ? `${name} County` : "Unknown county";
    return { county, municipality: null, rate: name ? PLACEHOLDER_COUNTY_RATE : null, jurisdiction: county };
  }

  const districtGeography = (label, layerId, field, prefix) => ({
    label,
    choiceLabel: "District",
    load: (signal) => loadArcgisGeography({
      serviceUrl: `${TIGER_LEGISLATIVE}/${layerId}`,
      where: "STATE = '30'",
      outFields: `${field},STATE`,
      maxAllowableOffset: DISTRICT_OFFSET,
      value: (properties) => properties[field],
      label: (properties, value) => `${prefix} - ${value}`,
    }, signal),
  });

  const acknowledgementsHtml = `
    <li><a href="${PARCELS_URL}" target="_blank" rel="noopener">Montana State Library Montana Cadastral Framework</a> — parcel polygons and selected Montana Department of Revenue parcel values</li>
    <li><a href="https://tigerweb.geo.census.gov/" target="_blank" rel="noopener">U.S. Census Bureau TIGERweb</a> — January 2026 congressional and state legislative districts; 2020 counties and incorporated places; 2020 urban areas</li>`;

  const optional = (value) => (value === null || value === undefined || value === "" ? null : value);
  const percentOf = (part, total) => (Number(total) ? ` (${((Number(part) / Number(total)) * 100).toFixed(0)}%)` : "");
  const urbanCache = new Map();

  window.ParcelStates.register({
    id: "MT",
    name: "Montana",
    center: [46.9, -110.5],
    zoom: 6,
    brand: {
      eyebrow: "Montana property insights",
      dataNote: "Parcel polygons and reported values provided by the Montana State Library",
      acknowledgementsHtml,
    },
    tax: {
      description: "Load Montana parcels with a positive source-reported total value, excluding records labeled Exempt Property. Tax-dollar estimates use a statewide placeholder rate, not certified county, municipal, or special-district rates.",
      scopeLabel: "Illustrative county property tax (placeholder rate)",
      shortLabel: "Illustrative Property Tax",
      rateNote: `Certified Montana jurisdictional rates are not configured. Every county currently uses an illustrative ${(PLACEHOLDER_COUNTY_RATE * 1000).toFixed(1)}-mill placeholder; replace it before citing tax-dollar results.`,
    },
    parcels: {
      analysisUrl: PARCELS_URL,
      analysisGeometry: "polygon",
      shapesUrl: PARCELS_URL,
      shapesCarryAttributes: true,
      generalizeShapes: true,
      outFields: "OBJECTID,PARCELID,COUNTYCD,CountyName,CountyAbbr,TaxYear,PropertyID,AssessmentCode,Township,Range,Section,LegalDescriptionShort,Subdivision,AddressLine1,AddressLine2,CityStateZip,LevyDistrict,PropType,ContinuousCropAcres,FallowAcres,FarmsiteAcres,ForestAcres,GrazingAcres,WildHayAcres,IrrigatedAcres,NonQualAcres,TotalAcres,TotalBuildingValue,TotalLandValue,TotalValue",
      taxableWhere: TAXABLE_WHERE,
      objectIdField: "OBJECTID",
      pageSize: 2000,
      percentileExpressions: false,
    },
    fields: { land: "TotalLandValue", improvement: "TotalBuildingValue", improvementCount: "TotalBuildingValue", total: "TotalValue" },
    values: (properties) => ({
      land: Number(properties.TotalLandValue),
      improvement: properties.TotalBuildingValue === null || properties.TotalBuildingValue === undefined
        ? null
        : Number(properties.TotalBuildingValue),
      total: Number(properties.TotalValue),
    }),
    jurisdictionGroupBy: "CountyName",
    taxJurisdictionDetails,
    sfh: {
      where: SFH_WHERE,
      matches: isSfhProxy,
      definition: "Proxy only: positive building value and PropType = ‘Improved Property’. Montana’s source does not report a detached single-family building type.",
    },
    propertyTypes: PROPERTY_TYPES,
    occupancy: {
      groups: [{ key: "", label: "Not reported" }],
      definition: "The statewide parcel service does not provide an owner-occupancy field.",
    },
    geographies: {
      stateSenate: districtGeography("Montana State Senate districts (2024; 2026 Census vintage)", 5, "SLDU", "MT Senate"),
      stateHouse: districtGeography("Montana State House districts (2024; 2026 Census vintage)", 6, "SLDL", "MT House"),
      congressional: districtGeography("U.S. congressional districts (119th Congress; 2026 Census vintage)", 4, "CD119", "U.S."),
      county: {
        label: "Counties",
        choiceLabel: "County",
        verifyAttributeFilter: true,
        load: (signal) => loadArcgisGeography({
          serviceUrl: TIGER_COUNTIES,
          where: "STATE = '30'",
          outFields: "NAME,STATE,GEOID",
          maxAllowableOffset: AREA_OFFSET,
          value: (properties) => properties.GEOID,
          label: (properties) => properties.NAME,
          county: (properties) => properties.NAME,
        }, signal),
        attributeFilter: (feature) => {
          const name = String(feature.properties.raw.NAME || "").replace(/\s+County$/i, "").trim();
          return name ? `CountyName = ${sqlString(name)}` : null;
        },
      },
      municipality: {
        label: "Incorporated places",
        choiceLabel: "Municipality",
        load: (signal) => loadArcgisGeography({
          serviceUrl: TIGER_PLACES,
          where: "STATE = '30'",
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
      { type: "stateSenate", header: "STATE_SENATE_DISTRICT", description: "2024 Montana State Senate district containing the parcel centroid." },
      { type: "stateHouse", header: "STATE_HOUSE_DISTRICT", description: "2024 Montana State House district containing the parcel centroid." },
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
      title: (properties) => optional(properties.AddressLine1) || optional(properties.PARCELID) || "Selected parcel",
      sortKey: (properties) => [properties.AddressLine1, properties.PARCELID],
      rows: (properties, { formatCurrency }) => [
        ["Parcel ID", optional(properties.PARCELID)],
        ["Address", [properties.AddressLine1, properties.CityStateZip].filter(Boolean).join(", ") || null],
        ["County", optional(properties.CountyName)],
        ["Property type", optional(properties.PropType)],
        ["Tax year", optional(properties.TaxYear)],
        ["Land value", `${formatCurrency(properties.TotalLandValue)}${percentOf(properties.TotalLandValue, properties.TotalValue)}`],
        ["Building value", `${formatCurrency(properties.TotalBuildingValue)}${percentOf(properties.TotalBuildingValue, properties.TotalValue)}`],
        ["Total reported value", `${formatCurrency(properties.TotalValue)}${Number(properties.TotalValue) ? " (100%)" : ""}`],
        ["Total acres", Number(properties.TotalAcres) > 0 ? Number(properties.TotalAcres).toLocaleString() : null],
        ["Levy district", optional(properties.LevyDistrict)],
      ],
    },
    csv: {
      headers: [
        "PARCELID", "COUNTYCD", "CountyName", "CountyAbbr", "TaxYear", "PropertyID", "AssessmentCode", "AddressLine1", "AddressLine2", "CityStateZip",
        "Township", "Range", "Section", "Subdivision", "LegalDescriptionShort", "LevyDistrict", "PropType", "GISAcres", "TotalAcres",
        "ContinuousCropAcres", "FallowAcres", "FarmsiteAcres", "ForestAcres", "GrazingAcres", "WildHayAcres", "IrrigatedAcres", "NonQualAcres",
        "TotalLandValue", "TotalBuildingValue", "TotalValue",
      ],
      row: (properties) => [
        properties.PARCELID, properties.COUNTYCD, properties.CountyName, properties.CountyAbbr, properties.TaxYear, properties.PropertyID,
        properties.AssessmentCode, properties.AddressLine1, properties.AddressLine2, properties.CityStateZip, properties.Township, properties.Range,
        properties.Section, properties.Subdivision, properties.LegalDescriptionShort, properties.LevyDistrict, properties.PropType, properties.GISAcres,
        properties.TotalAcres, properties.ContinuousCropAcres, properties.FallowAcres, properties.FarmsiteAcres, properties.ForestAcres,
        properties.GrazingAcres, properties.WildHayAcres, properties.IrrigatedAcres, properties.NonQualAcres, Number(properties.TotalLandValue),
        properties.TotalBuildingValue === null || properties.TotalBuildingValue === undefined ? 0 : Number(properties.TotalBuildingValue), Number(properties.TotalValue),
      ],
    },
    report: {
      title: "PARCEL ANALYSIS - MONTANA - SPLIT-RATE PROPERTY TAX SUMMARY",
      accountNoun: "parcels",
      unitDescription: "Each record is one polygon in the Montana State Library statewide OwnerParcel layer.",
      caveats: [
        `Certified county and local tax rates are not configured; current tax uses an illustrative ${(PLACEHOLDER_COUNTY_RATE * 1000).toFixed(1)}-mill placeholder statewide. Tax-dollar estimates are not actual bills.`,
        "The layer exposes source-reported land, building, and total values but no tax-bill or taxable-value field. The model uses TotalValue as its value base; assessment class, taxability, exemptions, and local levies are not fully represented.",
        "Records labeled Exempt Property are excluded. Partial Exempt Property is not adjusted for its partial exemption.",
        "There is no owner-occupancy field or detached-home class. The SFH benchmark uses PropType = Improved Property as a broad proxy; the agricultural grouping uses reported acreage fields and can miss agricultural parcels.",
        "Parcel polygons are drawn at zoom 14+; the FeatureServer does not provide a low-zoom map image. District membership is assigned by polygon centroid.",
      ],
      rateDefinition: "Rates are percent of source-reported TotalValue ($ per $100). Current rate is an illustrative county-level placeholder.",
      sfhNotes: "Qualifying benchmark proxy: positive TotalBuildingValue and PropType = Improved Property. This is not a verified single-family classification.",
      sourceLines: [`Montana State Library OwnerParcel layer: ${PARCELS_URL}`],
      csvColumnNotes: [
        "PARCELID, PropertyID, AssessmentCode: source parcel identifiers and assessment code.",
        "CountyName, CountyCD, CountyAbbr, LevyDistrict, TaxYear: source jurisdiction and roll attributes.",
        "TotalLandValue, TotalBuildingValue, TotalValue: source-reported parcel values; they are not a tax bill or a verified taxable-value base.",
        "PropType and acreage fields: selected source property characteristics; acreage fields drive the agricultural proxy.",
      ],
    },
  });
})();

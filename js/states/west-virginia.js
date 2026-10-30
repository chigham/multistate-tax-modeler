"use strict";

// West Virginia: geometry is in the statewide parcel layer while 2026 CAMA
// account/value rows are in ParcelSummary. Join on CleanParcelID; query matching
// boundary keys and aggregate the non-spatial records locally by geography.
(() => {
  const PARCELS_URL = "https://services.wvgis.wvu.edu/arcgis/rest/services/Planning_Cadastre/WV_Parcels/MapServer/0";
  const SUMMARY_URL = "https://services.wvgis.wvu.edu/arcgis/rest/services/Planning_Cadastre/WV_Parcels/MapServer/11";
  const TIGER_LEGISLATIVE = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Legislative/MapServer";
  const TIGER_COUNTIES = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/55";
  const TIGER_PLACES = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/25";
  const TAX_YEAR = 2026;
  const TAXABLE_WHERE = `TaxYear = ${TAX_YEAR} AND TotalAppraisal > 0 AND LandAppraisal IS NOT NULL AND BuildingAppraisal IS NOT NULL AND LandAppraisal >= 0 AND BuildingAppraisal >= 0`;
  const PLACEHOLDER_RATE = 0.0065;
  const DISTRICT_OFFSET = 0.00003;
  const AREA_OFFSET = 0.0002;
  const LAND_VALUE_PER_ACRE_COLORS = [
    "#00441b", "#006d2c", "#238b45", "#74c476", "#ffff00",
    "#ffb000", "#ff6d00", "#e31a1c", "#7f0000",
  ];

  const hasValue = (value) => value !== null && value !== undefined && value !== "";
  const numberOrNull = (value) => hasValue(value) && Number.isFinite(Number(value)) ? Number(value) : null;
  const landValuePerAcre = (properties) => {
    const areaAcres = numberOrNull(properties.CALC_ACRE);
    const landValue = numberOrNull(properties.LandAppraisal);
    return areaAcres > 0 && landValue !== null ? landValue / areaAcres : null;
  };
  const propertyClass = (properties) => String(properties.PropertyClassCode || "").trim().toUpperCase();
  const landUseCode = (properties) => String(properties.LandUseCode || "").trim();
  const isAgricultural = (properties) => propertyClass(properties) === "F";
  const isImproved = (properties) => Number(properties.BuildingAppraisal) > 0;
  const isSfh = (properties) => !isAgricultural(properties) && isImproved(properties) && landUseCode(properties) === "101";
  const NOT_FARM = "(PropertyClassCode IS NULL OR PropertyClassCode <> 'F')";
  const IMPROVED = "BuildingAppraisal > 0";
  const SFH_WHERE = `${NOT_FARM} AND ${IMPROVED} AND LandUseCode = '101'`;

  const PROPERTY_TYPES = [
    {
      key: "agricultural",
      label: "Farm-class property",
      definition: "PropertyClassCode F is treated as an agricultural proxy. This assessment classification is not an independent determination of agricultural use or exemption status.",
      where: "PropertyClassCode = 'F'",
      matches: ({ properties }) => isAgricultural(properties),
    },
    {
      key: "vacant",
      label: "No positive building appraisal",
      definition: "Non-farm accounts without a positive BuildingAppraisal, including records classified as vacant by the assessor.",
      where: `${NOT_FARM} AND (BuildingAppraisal IS NULL OR BuildingAppraisal <= 0)`,
      matches: ({ properties, improved }) => !isAgricultural(properties) && !improved,
    },
    {
      key: "sfh",
      label: "Residential one-family (SFH proxy)",
      definition: "Non-farm accounts with a positive building appraisal and LandUseCode 101 (Residential 1 Family). The statewide data does not independently verify detached building form or owner occupancy.",
      where: SFH_WHERE,
      matches: ({ properties }) => isSfh(properties),
    },
    {
      key: "other",
      label: "Other improved property",
      definition: "All remaining non-farm accounts with positive building appraisal.",
      where: `${NOT_FARM} AND ${IMPROVED} AND (LandUseCode IS NULL OR LandUseCode <> '101')`,
      matches: ({ properties, improved }) => !isAgricultural(properties) && improved && !isSfh(properties),
    },
  ];

  function evaluateCondition(condition, properties) {
    return condition.split(/\s+OR\s+/i).some((term) => {
      const nullTest = term.match(/^([\w.]+)\s+IS\s+NULL$/i);
      if (nullTest) return !hasValue(properties[nullTest[1]]);
      const comparison = term.match(/^([\w.]+)\s*(<=|>=|<>|!=|=|<|>)\s*(?:([\w.]+)\s*\*\s*([\d.]+)|([\w.]+)|(-?[\d.]+)|'([^']*)')$/i);
      if (!comparison) return false;
      const [, field, operator, multiplierField, multiplier, otherField, numberValue, stringValue] = comparison;
      const left = properties[field];
      const right = multiplierField ? Number(properties[multiplierField]) * Number(multiplier)
        : otherField ? properties[otherField]
          : stringValue !== undefined ? stringValue : Number(numberValue);
      if (!hasValue(left) || !hasValue(right)) return false;
      const a = typeof right === "string" && !Number.isFinite(Number(right)) ? String(left) : Number(left);
      const b = typeof right === "string" && !Number.isFinite(Number(right)) ? String(right) : Number(right);
      switch (operator) {
        case "=": return a === b;
        case "<>":
        case "!=": return a !== b;
        case "<": return a < b;
        case "<=": return a <= b;
        case ">": return a > b;
        case ">=": return a >= b;
        default: return false;
      }
    });
  }

  function statisticValue(properties, expression) {
    const ratio = String(expression).match(/^CAST\(([\w.]+)\s+AS\s+FLOAT\)\s*\/\s*([\w.]+)$/i);
    if (ratio) {
      const numerator = numberOrNull(properties[ratio[1]]);
      const denominator = numberOrNull(properties[ratio[2]]);
      return numerator !== null && denominator ? numerator / denominator : null;
    }
    const conditional = String(expression).match(/^CASE\s+WHEN\s+(.+)\s+THEN\s+(-?[\d.]+)\s+ELSE\s+(-?[\d.]+)\s+END$/i);
    if (conditional) return Number(evaluateCondition(conditional[1], properties) ? conditional[2] : conditional[3]);
    return numberOrNull(properties[expression]);
  }

  function taxJurisdictionDetails(properties) {
    const name = String(properties.CountyName || "").trim();
    const county = name ? `${titleCase(name)} County` : "Unknown county";
    return {
      county,
      municipality: null,
      rate: name ? PLACEHOLDER_RATE : null,
      jurisdiction: county,
    };
  }

  function districtGeography(label, layerId, field, prefix) {
    return {
      label,
      choiceLabel: "District",
      load: (signal) => loadArcgisGeography({
        serviceUrl: `${TIGER_LEGISLATIVE}/${layerId}`,
        where: "STATE = '54'",
        outFields: `${field},STATE,NAME,GEOID`,
        maxAllowableOffset: DISTRICT_OFFSET,
        value: (properties) => properties[field],
        label: (properties, value) => `${prefix} - ${value}`,
      }, signal),
    };
  }

  const acknowledgementsHtml = `
    <li><a href="${PARCELS_URL}" target="_blank" rel="noopener">WVGISTC West Virginia parcel polygons</a> — parcel geometry and CleanParcelID join keys</li>
    <li><a href="${SUMMARY_URL}" target="_blank" rel="noopener">WVGISTC ParcelSummary (Tax Year ${TAX_YEAR})</a> — account records, county/class attributes, and land, building, and total appraisals; joined to geometry by CleanParcelID</li>
    <li><a href="https://tigerweb.geo.census.gov/" target="_blank" rel="noopener">U.S. Census Bureau TIGERweb</a> — 2026 state legislative and 119th Congress districts; 2020 counties, incorporated places, and urban areas</li>`;

  const optional = (value) => (value === null || value === undefined || value === "" ? null : value);
  const percentOf = (part, total) => (Number(total) ? ` (${((Number(part) / Number(total)) * 100).toFixed(0)}%)` : "");
  const urbanCache = new Map();

  window.ParcelStates.register({
    id: "WV",
    name: "West Virginia",
    center: [38.6, -80.6],
    zoom: 7,
    brand: {
      eyebrow: "West Virginia property insights",
      dataNote: "WVGISTC parcel polygons joined to Tax Year 2026 ParcelSummary records",
      acknowledgementsHtml,
    },
    tax: {
      description: "Load West Virginia account records with positive total appraisal and reported nonnegative land and building appraisals. Current tax uses a uniform illustrative placeholder rate, not certified county rates or parcel tax bills.",
      scopeLabel: "Illustrative county property tax (placeholder rate)",
      shortLabel: "Illustrative Property Tax",
      rateNote: `Certified West Virginia county rates are not configured. Every county currently uses an illustrative ${(PLACEHOLDER_RATE * 1000).toFixed(1)}-mill placeholder applied to TotalAppraisal; replace it before citing tax-dollar results.`,
    },
    parcels: {
      analysisUrl: PARCELS_URL,
      analysisGeometry: "polygon",
      shapesUrl: PARCELS_URL,
      shapesCarryAttributes: true,
      generalizeShapes: true,
      outFields: "OBJECTID,CleanParcelID,CountyID,COUNTY,FullPhysicalAddress,CALC_ACRE,ParcelID,CountyCode,CountyName,TaxYear,TaxDistrict,TaxClass,PropertyClassCode,PropertyClassDescription,LandUse,LandUseCode,OccupancyDescription,YearBuilt,DeededAcres,CalculatedAcres,LandAppraisal,BuildingAppraisal,TotalAppraisal",
      taxableWhere: TAXABLE_WHERE,
      objectIdField: "OBJECTID",
      pageSize: 2000,
      percentileExpressions: false,
      relatedTable: {
        url: SUMMARY_URL,
        rowIdField: "ID",
        keyField: "CleanParcelID",
        geometryKeyField: "CleanParcelID",
        geometryOutFields: "OBJECTID,CleanParcelID,CountyID,COUNTY,FullPhysicalAddress,CALC_ACRE",
        geometryWhere: "1=1",
        where: TAXABLE_WHERE,
        outFields: "ID,CleanParcelID,ParcelID,CountyCode,CountyName,TaxYear,TaxDistrict,TaxClass,PropertyClassCode,PropertyClassDescription,LandUse,LandUseCode,OccupancyDescription,YearBuilt,DeededAcres,CalculatedAcres,LandAppraisal,BuildingAppraisal,TotalAppraisal,FullPhysicalAddress",
        keysPerRequest: 1000,
        tablePageSize: 2000,
        queryConcurrency: 5,
        maxGeometryFeatures: 500000,
        maxRowsPerChunk: 20000,
        statisticValue,
      },
    },
    fields: { land: "LandAppraisal", improvement: "BuildingAppraisal", improvementCount: "BuildingAppraisal", total: "TotalAppraisal" },
    parcelVisualization: {
      key: "land-value-per-acre",
      label: "Land appraisal per parcel acre",
      description: "Color shows the sum of joined LandAppraisal values divided by the parcel polygon layer's GIS-calculated CALC_ACRE. Nine Jenks natural-breaks thresholds are calculated from every parcel in the selected geography and stay fixed while panning. Colors blend continuously between those breakpoints, from dark green (lower) through yellow and orange to dark red (higher). Parcels are drawn without outlines, so neighbors with similar values merge into continuous regions. Gray marks parcels without a valid area/value. Legend counts cover the whole selection. Selected underutilized parcels keep their orange highlight.",
      classCount: 9,
      colors: LAND_VALUE_PER_ACRE_COLORS,
      continuousRamp: true,
      noDataColor: "#8c8c8c",
      noDataLabel: "No valid parcel area/value",
      value: (properties) => {
        const accounts = properties.accounts || [];
        const areaAcres = numberOrNull(accounts[0]?.CALC_ACRE);
        const landValue = accounts.reduce((total, account) => total + (numberOrNull(account.LandAppraisal) || 0), 0);
        return areaAcres > 0 ? landValue / areaAcres : null;
      },
    },
    values: (properties) => ({
      land: numberOrNull(properties.LandAppraisal),
      improvement: numberOrNull(properties.BuildingAppraisal),
      total: numberOrNull(properties.TotalAppraisal),
    }),
    jurisdictionGroupBy: "CountyCode,CountyName",
    taxJurisdictionDetails,
    sfh: {
      where: SFH_WHERE,
      matches: isSfh,
      definition: "Proxy only: positive BuildingAppraisal and LandUseCode 101 (Residential 1 Family). This does not independently establish a detached home or owner occupancy.",
    },
    propertyTypes: PROPERTY_TYPES,
    occupancy: {
      groups: [{ key: "", label: "Not reported" }],
      definition: "Owner occupancy or homestead status is not modeled; OccupancyDescription is an assessment/use description, not a verified occupancy indicator.",
    },
    geographies: {
      stateSenate: districtGeography("West Virginia State Senate districts (2026 Census vintage)", 1, "SLDU", "WV Senate"),
      stateHouse: districtGeography("West Virginia House of Delegates districts (2026 Census vintage)", 2, "SLDL", "WV House"),
      congressional: districtGeography("U.S. congressional districts (119th Congress; 2026 Census vintage)", 4, "CD119", "U.S."),
      county: {
        label: "Counties",
        choiceLabel: "County",
        load: (signal) => loadArcgisGeography({
          serviceUrl: TIGER_COUNTIES,
          where: "STATE = '54'",
          outFields: "NAME,STATE,COUNTY,GEOID",
          maxAllowableOffset: AREA_OFFSET,
          value: (properties) => properties.GEOID,
          label: (properties) => properties.NAME,
          county: (properties) => properties.NAME,
        }, signal),
      },
      municipality: {
        label: "Incorporated places",
        choiceLabel: "Municipality",
        load: (signal) => loadArcgisGeography({
          serviceUrl: TIGER_PLACES,
          where: "STATE = '54'",
          outFields: "NAME,BASENAME,STATE,GEOID",
          maxAllowableOffset: AREA_OFFSET,
          value: (properties) => properties.GEOID,
          label: (properties) => properties.NAME,
        }, signal),
      },
    },
    geographyOrder: ["stateSenate", "stateHouse", "congressional", "county", "municipality"],
    defaultGeography: "stateHouse",
    exportDistricts: [
      { type: "stateSenate", header: "STATE_SENATE_DISTRICT", description: "2026 Census-vintage West Virginia State Senate district containing the parcel polygon center." },
      { type: "stateHouse", header: "STATE_HOUSE_DISTRICT", description: "2026 Census-vintage West Virginia House of Delegates district containing the parcel polygon center." },
      { type: "congressional", header: "CONGRESSIONAL_DISTRICT", description: "119th Congress U.S. district containing the parcel polygon center." },
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
      title: (properties) => optional(properties.FullPhysicalAddress) || optional(properties.ParcelID) || optional(properties.CleanParcelID) || "Selected parcel",
      sortKey: (properties) => [properties.FullPhysicalAddress, properties.ParcelID],
      rows: (properties, { formatCurrency }) => [
        ["Parcel ID", optional(properties.ParcelID) || optional(properties.CleanParcelID)],
        ["County", optional(properties.CountyName)],
        ["Property class", optional(properties.PropertyClassDescription) || optional(properties.PropertyClassCode)],
        ["Land use", optional(properties.LandUse)],
        ["Tax class / district", [properties.TaxClass, properties.TaxDistrict].filter(Boolean).join(" / ") || null],
        ["Year built", optional(properties.YearBuilt)],
        ["Deeded acres", optional(properties.DeededAcres)],
        ["Parcel shape acres (GIS)", numberOrNull(properties.CALC_ACRE)?.toLocaleString("en-US", { maximumFractionDigits: 2 })],
        ["Land appraisal", `${formatCurrency(properties.LandAppraisal)}${percentOf(properties.LandAppraisal, properties.TotalAppraisal)}`],
        ["Building appraisal", `${formatCurrency(properties.BuildingAppraisal)}${percentOf(properties.BuildingAppraisal, properties.TotalAppraisal)}`],
        ["Total appraisal", `${formatCurrency(properties.TotalAppraisal)}${Number(properties.TotalAppraisal) ? " (100%)" : ""}`],
      ],
    },
    csv: {
      headers: [
        "OBJECTID", "CleanParcelID", "ParcelID", "CountyID", "COUNTY", "CALC_ACRE", "CountyCode", "CountyName", "TaxYear", "TaxDistrict", "TaxClass",
        "PropertyClassCode", "PropertyClassDescription", "LandUse", "LandUseCode", "OccupancyDescription", "YearBuilt", "DeededAcres", "CalculatedAcres",
        "LandAppraisal", "BuildingAppraisal", "TotalAppraisal", "LandAppraisalPerGisAcre", "FullPhysicalAddress",
      ],
      row: (properties) => [
        properties.OBJECTID, properties.CleanParcelID, properties.ParcelID, properties.CountyID, properties.COUNTY, properties.CALC_ACRE, properties.CountyCode,
        properties.CountyName, properties.TaxYear, properties.TaxDistrict, properties.TaxClass, properties.PropertyClassCode,
        properties.PropertyClassDescription, properties.LandUse, properties.LandUseCode, properties.OccupancyDescription, properties.YearBuilt,
        properties.DeededAcres, properties.CalculatedAcres, numberOrNull(properties.LandAppraisal), numberOrNull(properties.BuildingAppraisal),
        numberOrNull(properties.TotalAppraisal), landValuePerAcre(properties), properties.FullPhysicalAddress,
      ],
    },
    report: {
      title: "PARCEL ANALYSIS - WEST VIRGINIA - SPLIT-RATE PROPERTY TAX SUMMARY",
      accountNoun: "assessment records",
      unitDescription: `Each record is a Tax Year ${TAX_YEAR} ParcelSummary account joined to parcel polygon geometry by CleanParcelID. If multiple assessment rows share a boundary key, each account is retained and displayed together on that polygon.`,
      caveats: [
        `Tax Year ${TAX_YEAR} ParcelSummary is non-spatial. The app selects parcel polygons by geography, checks their centers against the selected boundary, joins matching CleanParcelID values, and computes statistics from the joined assessment records in the browser because the ArcGIS dynamic join does not support pagination or grouped statistics.`,
        "The geometry layer describes itself as updated for Tax Year 2023, while the joined assessment table contains Tax Year 2026. CleanParcelID is the join key; unmatched table-only records have no geometry and are excluded, and unmatched geometry has no assessment record and is excluded.",
        "The optional land-appraisal-per-acre map divides summed Tax Year 2026 joined land appraisal by CALC_ACRE from the parcel geometry layer (updated for Tax Year 2023). It is an exploratory density comparison, not a contemporaneous assessor land rate; joined records sharing a parcel key are summed for the map color.",
        "A parcel key may relate to more than one assessment row. The model preserves those records rather than silently summing a one-to-many join as one account; source-record counts are not deduplicated ownership counts.",
        `Certified West Virginia county tax rates and parcel bills are not configured. Current tax and scenarios use an illustrative ${(PLACEHOLDER_RATE * 1000).toFixed(1)}-mill placeholder applied to TotalAppraisal; no tax credits or exemptions are independently verified.`,
        "PropertyClassCode F is an agricultural proxy; LandUseCode 101 is a residential one-family proxy. These fields do not establish legal agricultural treatment, detached-home status, or owner occupancy. Occupancy is not reported.",
        "Census TIGERweb 2026-vintage legislative/congressional and 2020 local boundaries are used for analysis, not legal surveys. Parcel center rather than full polygon overlap determines district membership.",
      ],
      rateDefinition: "The placeholder rate is percent of appraised value ($ per $100). It is illustrative and not an official county rate.",
      sfhNotes: "Qualifying residential benchmark proxy: positive BuildingAppraisal and LandUseCode 101 (Residential 1 Family). The source does not verify detached building form or owner occupancy.",
      sourceLines: [`WVGISTC WV parcel polygons: ${PARCELS_URL}`, `WVGISTC ParcelSummary, Tax Year ${TAX_YEAR}: ${SUMMARY_URL}`],
      csvColumnNotes: [
        "CleanParcelID links the boundary feature to a ParcelSummary account row; OBJECTID, physical address, and CALC_ACRE (GIS-calculated parcel acreage) are geometry/source attributes.",
        "LandAppraisalPerGisAcre is the joined account LandAppraisal divided by geometry-layer CALC_ACRE; the ratio combines Tax Year 2026 assessments with parcel geometry updated for Tax Year 2023.",
        "CountyCode, CountyName, TaxYear, TaxClass, PropertyClassCode/Description, LandUse/Code, OccupancyDescription, YearBuilt, and acreage fields are ParcelSummary attributes.",
        "LandAppraisal: land; BuildingAppraisal: improvements; TotalAppraisal: total. Dollar values are the source appraisal values for the reported tax year.",
      ],
    },
  });
})();

"use strict";

// MassGIS publishes assessor records stacked on parcel polygons. Include both
// documented parcel types (FEE and TAX); preserve each assessment record, including
// condominium records that may share a location or polygon.
(() => {
  const PARCELS_URL = "https://services1.arcgis.com/hGdibHYSPO59RG1h/arcgis/rest/services/Massachusetts_Property_Tax_Parcels/FeatureServer/0";
  const MUNICIPALITIES_URL = "https://services1.arcgis.com/hGdibHYSPO59RG1h/arcgis/rest/services/Massachusetts_Municipalities/FeatureServer/1";
  const TIGER_LEGISLATIVE = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Legislative/MapServer";
  const TIGER_COUNTIES = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/55";
  const TAXABLE_WHERE = "POLY_TYPE IN ('FEE', 'TAX') AND TOTAL_VAL > 0 AND LAND_VAL IS NOT NULL AND TOTAL_VAL >= LAND_VAL AND TOWN_ID IS NOT NULL";
  const IMPROVEMENT_SQL = "(TOTAL_VAL - LAND_VAL)";
  const PLACEHOLDER_RATE = 0.0065;
  const DISTRICT_OFFSET = 0.00003;
  const AREA_OFFSET = 0.0002;

  const optional = (value) => (value === null || value === undefined || value === "" ? null : value);
  const numberOrNull = (value) => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
  const normalizedText = (value) => String(value || "").trim().toUpperCase();
  const countyKey = (name) => normalizedText(name).replace(/\s+COUNTY$/, "");
  const countyLabel = (name) => name ? `${titleCase(countyKey(name))} County` : "Massachusetts";
  const useDescription = (properties) => normalizedText(properties.USE_DESC);
  const isAgricultural = (properties) => {
    const description = useDescription(properties);
    return ["AGRICULT", "HORTICULT", "FARM", "FOREST"].some((word) => description.includes(word));
  };
  const isImproved = (properties) => {
    const total = numberOrNull(properties.TOTAL_VAL);
    const land = numberOrNull(properties.LAND_VAL);
    return total !== null && land !== null && total - land > 0;
  };
  const isSingleFamilyProxy = (properties) => !isAgricultural(properties)
    && useDescription(properties).startsWith("SINGLE FAMILY RESIDENTIAL")
    && isImproved(properties);

  const AGRICULTURAL_WHERE = "(UPPER(USE_DESC) LIKE '%AGRICULT%' OR UPPER(USE_DESC) LIKE '%HORTICULT%' OR UPPER(USE_DESC) LIKE '%FARM%' OR UPPER(USE_DESC) LIKE '%FOREST%')";
  const NOT_AGRICULTURAL = "(USE_DESC IS NULL OR (UPPER(USE_DESC) NOT LIKE '%AGRICULT%' AND UPPER(USE_DESC) NOT LIKE '%HORTICULT%' AND UPPER(USE_DESC) NOT LIKE '%FARM%' AND UPPER(USE_DESC) NOT LIKE '%FOREST%'))";
  const IMPROVED = "TOTAL_VAL > LAND_VAL";
  const SFH_WHERE = `${NOT_AGRICULTURAL} AND UPPER(USE_DESC) LIKE 'SINGLE FAMILY RESIDENTIAL%' AND ${IMPROVED}`;

  const PROPERTY_TYPES = [
    {
      key: "agricultural",
      label: "Agriculture / horticulture / forest (description proxy)",
      definition: "USE_DESC contains an agriculture, horticulture, farm, or forest description. Assessor descriptions can vary and mixed-use records may be included; this is not a legal exemption or current-use determination.",
      where: AGRICULTURAL_WHERE,
      matches: ({ properties }) => isAgricultural(properties),
    },
    {
      key: "vacant",
      label: "No modeled improvements",
      definition: "Non-agricultural/resource descriptions with TOTAL_VAL minus LAND_VAL at or below zero. This value-based rule does not establish legal vacancy.",
      where: `${NOT_AGRICULTURAL} AND TOTAL_VAL <= LAND_VAL`,
      matches: ({ properties, improved }) => !isAgricultural(properties) && !improved,
    },
    {
      key: "sfh",
      label: "Single-family residential (use-description proxy)",
      definition: "Positive modeled non-land value and a USE_DESC beginning 'Single Family Residential'. It is not a building inspection, verified detached-home classification, or owner-occupancy determination.",
      where: SFH_WHERE,
      matches: ({ properties }) => isSingleFamilyProxy(properties),
    },
    {
      key: "other",
      label: "Other improved property",
      definition: "Remaining non-agricultural/resource assessment records with positive modeled non-land value.",
      where: `${NOT_AGRICULTURAL} AND ${IMPROVED} AND (USE_DESC IS NULL OR UPPER(USE_DESC) NOT LIKE 'SINGLE FAMILY RESIDENTIAL%')`,
      matches: ({ properties, improved }) => !isAgricultural(properties) && improved && !useDescription(properties).startsWith("SINGLE FAMILY RESIDENTIAL"),
    },
  ];

  const townById = new Map();
  const townIdsByCounty = new Map();
  let townMetadataPromise = null;
  async function loadTownMetadata(signal) {
    if (!townMetadataPromise) {
      townMetadataPromise = queryAllJson(MUNICIPALITIES_URL, {
        where: "1=1",
        outFields: "TOWN_ID,TOWN,COUNTY",
        returnGeometry: "false",
      }, signal, 1000, 1000).then((rows) => {
        townById.clear();
        townIdsByCounty.clear();
        rows.forEach(({ attributes = {} }) => {
          const id = String(attributes.TOWN_ID ?? "");
          const town = String(attributes.TOWN || "").trim();
          const county = String(attributes.COUNTY || "").trim();
          if (!id || !town || !county) return;
          townById.set(id, { town, county });
          const key = countyKey(county);
          const ids = townIdsByCounty.get(key) || [];
          ids.push(id);
          townIdsByCounty.set(key, ids);
        });
        return townById;
      }).catch((error) => {
        townMetadataPromise = null;
        townById.clear();
        townIdsByCounty.clear();
        throw error;
      });
    }
    return townMetadataPromise;
  }

  function taxJurisdictionDetails(properties) {
    const town = townById.get(String(properties.TOWN_ID ?? ""));
    const municipality = town?.town ? titleCase(town.town) : (properties.CITY ? titleCase(properties.CITY) : null);
    const county = countyLabel(town?.county);
    return {
      county,
      municipality,
      rate: PLACEHOLDER_RATE,
      jurisdiction: municipality ? `${county} — ${municipality}` : county,
    };
  }

  const districtGeography = (label, layerId, field, prefix) => ({
    label,
    choiceLabel: "District",
    load: (signal) => loadArcgisGeography({
      serviceUrl: `${TIGER_LEGISLATIVE}/${layerId}`,
      where: `STATE = '25' AND ${field} <> 'ZZZ'`,
      outFields: `${field},STATE,NAME`,
      maxAllowableOffset: DISTRICT_OFFSET,
      value: (properties) => properties[field],
      label: (properties, value) => properties.NAME || `${prefix} - ${value}`,
    }, signal),
  });

  const urbanCache = new Map();
  const acknowledgementsHtml = `
    <li><a href="${PARCELS_URL}" target="_blank" rel="noopener">MassGIS Property Tax Parcels</a> — Level 3 assessor parcel records and land/building/other/total assessed values</li>
    <li><a href="${MUNICIPALITIES_URL}" target="_blank" rel="noopener">MassGIS Municipalities</a> — town IDs and municipal boundaries</li>
    <li><a href="https://tigerweb.geo.census.gov/" target="_blank" rel="noopener">U.S. Census Bureau TIGERweb</a> — 2026 state legislative districts, 119th Congress districts, counties, and 2020 urban areas</li>`;
  const percentOf = (part, total) => (Number(total) ? ` (${((Number(part) / Number(total)) * 100).toFixed(0)}%)` : "");

  window.ParcelStates.register({
    id: "MA",
    name: "Massachusetts",
    center: [42.3, -71.8],
    zoom: 8,
    brand: {
      eyebrow: "Massachusetts property insights",
      dataNote: "MassGIS Level 3 assessor parcel records and assessed values",
      acknowledgementsHtml,
    },
    tax: {
      description: "Load MassGIS FEE and TAX assessment records with positive total value and a reported land value. Current tax uses a clearly labeled illustrative statewide rate because this parcel layer does not supply parcel tax bills.",
      scopeLabel: "Illustrative property tax (placeholder rate)",
      shortLabel: "Illustrative Property Tax",
      rateNote: `Certified Massachusetts municipal tax rates are not configured. Every town currently uses an illustrative ${(PLACEHOLDER_RATE * 1000).toFixed(1)}-mill placeholder; replace it before citing tax-dollar results.`,
    },
    parcels: {
      analysisUrl: PARCELS_URL,
      analysisGeometry: "polygon",
      shapesUrl: PARCELS_URL,
      shapesCarryAttributes: true,
      generalizeShapes: true,
      outFields: "OBJECTID,POLY_TYPE,MAP_PAR_ID,LOC_ID,TOWN_ID,PROP_ID,BLDG_VAL,LAND_VAL,OTHER_VAL,TOTAL_VAL,FY,LOT_SIZE,LS_DATE,LS_PRICE,USE_CODE,USE_DESC,SITE_ADDR,CITY,ZIP,OWN_CITY,OWN_STATE,OWN_ZIP,LOT_UNITS,YEAR_BUILT,BLD_AREA,UNITS,RES_AREA,STYLE,NUM_ROOMS,STORIES",
      taxableWhere: TAXABLE_WHERE,
      objectIdField: "OBJECTID",
      pageSize: 2000,
      percentileExpressions: false,
    },
    fields: {
      land: "LAND_VAL",
      improvement: "BLDG_VAL",
      improvementCount: "BLDG_VAL",
      total: "TOTAL_VAL",
      improvementFromTotalMinusLand: true,
    },
    values: (properties) => {
      const land = numberOrNull(properties.LAND_VAL);
      const total = numberOrNull(properties.TOTAL_VAL);
      return { land, improvement: land === null || total === null ? null : total - land, total };
    },
    jurisdictionGroupBy: "TOWN_ID",
    prepare: loadTownMetadata,
    taxJurisdictionDetails,
    sfh: {
      where: SFH_WHERE,
      matches: isSingleFamilyProxy,
      definition: "Positive TOTAL_VAL minus LAND_VAL and USE_DESC beginning 'Single Family Residential'; this is a use-description proxy, not a verified detached-home or owner-occupancy classification.",
    },
    propertyTypes: PROPERTY_TYPES,
    occupancy: {
      groups: [{ key: "", label: "Not reported" }],
      definition: "The statewide assessor parcel layer does not provide verified owner-occupancy or homestead status.",
    },
    geographies: {
      stateSenate: districtGeography("Massachusetts State Senate districts (2026 Census vintage)", 1, "SLDU", "MA Senate"),
      stateHouse: districtGeography("Massachusetts House districts (2026 Census vintage)", 2, "SLDL", "MA House"),
      congressional: districtGeography("U.S. congressional districts (119th Congress)", 4, "CD119", "U.S."),
      county: {
        label: "Counties",
        choiceLabel: "County",
        verifyAttributeFilter: true,
        load: async (signal) => {
          await loadTownMetadata(signal);
          return loadArcgisGeography({
            serviceUrl: TIGER_COUNTIES,
            where: "STATE = '25'",
            outFields: "NAME,STATE,GEOID",
            maxAllowableOffset: AREA_OFFSET,
            value: (properties) => properties.GEOID,
            label: (properties) => countyLabel(properties.NAME),
            county: (properties) => countyLabel(properties.NAME),
          }, signal);
        },
        attributeFilter: (feature) => {
          const ids = townIdsByCounty.get(countyKey(feature.properties.raw.NAME)) || [];
          return ids.length ? `TOWN_ID IN (${ids.map(Number).filter(Number.isFinite).join(", ")})` : null;
        },
      },
      municipality: {
        label: "Cities and towns",
        choiceLabel: "City or town",
        verifyAttributeFilter: true,
        load: async (signal) => {
          await loadTownMetadata(signal);
          return loadArcgisGeography({
            serviceUrl: MUNICIPALITIES_URL,
            where: "1=1",
            outFields: "TOWN_ID,TOWN,COUNTY,FIPS_STCO",
            maxAllowableOffset: AREA_OFFSET,
            value: (properties) => String(properties.TOWN_ID),
            label: (properties) => `${titleCase(properties.TOWN)} (${titleCase(properties.COUNTY)} County)`,
            county: (properties) => countyLabel(properties.COUNTY),
          }, signal);
        },
        attributeFilter: (feature) => {
          const townId = Number(feature.properties.raw.TOWN_ID);
          return Number.isFinite(townId) ? `TOWN_ID = ${townId}` : null;
        },
      },
    },
    geographyOrder: ["stateSenate", "stateHouse", "congressional", "county", "municipality"],
    defaultGeography: "stateHouse",
    exportDistricts: [
      { type: "stateSenate", header: "STATE_SENATE_DISTRICT", description: "2026 Census-vintage Massachusetts State Senate district containing the parcel centroid." },
      { type: "stateHouse", header: "STATE_HOUSE_DISTRICT", description: "2026 Census-vintage Massachusetts House district containing the parcel centroid." },
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
      title: (properties) => optional(properties.SITE_ADDR) || optional(properties.PROP_ID) || "Selected property record",
      sortKey: (properties) => [properties.SITE_ADDR, properties.PROP_ID, properties.OBJECTID],
      rows: (properties, { formatCurrency }) => {
        const details = taxJurisdictionDetails(properties);
        const modelValues = window.ParcelStates.get("MA").values(properties);
        return [
          ["Assessor record", optional(properties.PROP_ID)],
          ["Parcel map ID", optional(properties.MAP_PAR_ID)],
          ["Location ID", optional(properties.LOC_ID)],
          ["Municipality", details.municipality],
          ["County", details.county],
          ["Address", [properties.SITE_ADDR, properties.CITY, properties.ZIP].filter(Boolean).join(", ") || null],
          ["Parcel feature type", optional(properties.POLY_TYPE)],
          ["Use code / description", [properties.USE_CODE, properties.USE_DESC].filter(Boolean).join(" — ") || null],
          ["Assessment fiscal year", optional(properties.FY)],
          ["Land assessment", `${formatCurrency(properties.LAND_VAL)}${percentOf(properties.LAND_VAL, properties.TOTAL_VAL)}`],
          ["Main building assessment", optional(properties.BLDG_VAL) === null ? null : formatCurrency(properties.BLDG_VAL)],
          ["Other improvement assessment", optional(properties.OTHER_VAL) === null ? null : formatCurrency(properties.OTHER_VAL)],
          ["Modeled non-land value (total − land)", `${formatCurrency(modelValues.improvement)}${percentOf(modelValues.improvement, properties.TOTAL_VAL)}`],
          ["Total assessed value", `${formatCurrency(properties.TOTAL_VAL)}${Number(properties.TOTAL_VAL) ? " (100%)" : ""}`],
          ["Living / other units", optional(properties.UNITS)],
          ["Residential area", optional(properties.RES_AREA)],
          ["Lot size", [properties.LOT_SIZE, properties.LOT_UNITS].filter(Boolean).join(" ") || null],
          ["Year built", optional(properties.YEAR_BUILT)],
        ];
      },
    },
    csv: {
      headers: [
        "POLY_TYPE", "TOWN_ID", "PROP_ID", "MAP_PAR_ID", "LOC_ID", "SITE_ADDR", "CITY", "ZIP", "USE_CODE", "USE_DESC", "FY",
        "LAND_VAL", "BLDG_VAL", "OTHER_VAL", "MODEL_NONLAND_VALUE", "TOTAL_VAL", "UNITS", "RES_AREA", "LOT_SIZE", "LOT_UNITS", "YEAR_BUILT",
      ],
      row: (properties) => {
        const values = window.ParcelStates.get("MA").values(properties);
        return [
          properties.POLY_TYPE, properties.TOWN_ID, properties.PROP_ID, properties.MAP_PAR_ID, properties.LOC_ID,
          properties.SITE_ADDR, properties.CITY, properties.ZIP, properties.USE_CODE, properties.USE_DESC, properties.FY,
          Number(properties.LAND_VAL), properties.BLDG_VAL, properties.OTHER_VAL, values.improvement, Number(properties.TOTAL_VAL),
          properties.UNITS, properties.RES_AREA, properties.LOT_SIZE, properties.LOT_UNITS, properties.YEAR_BUILT,
        ];
      },
    },
    report: {
      title: "PARCEL ANALYSIS - MASSACHUSETTS - SPLIT-RATE PROPERTY TAX SUMMARY",
      accountNoun: "assessor records",
      unitDescription: "Each record is a MassGIS Level 3 assessor record stacked on a parcel polygon. Multiple condominium or other assessor records may share a location or polygon; records are not de-duplicated into unique physical lots.",
      caveats: [
        "The analysis includes MassGIS' documented FEE and TAX polygon types with positive TOTAL_VAL and LAND_VAL, excluding a small number of records where total is below land. MassGIS describes the assessment data as an 'as is' assessor extract; coverage, errors, and assessment fiscal years vary by town.",
        "MassGIS states that TOTAL_VAL may differ from LAND_VAL + BLDG_VAL + OTHER_VAL. The model uses TOTAL_VAL minus LAND_VAL as its non-land improvement component so the split-rate components reconcile to the reported total; BLDG_VAL and OTHER_VAL remain separately visible in parcel details.",
        `Certified municipal tax rates and parcel tax bills are not supplied by this layer. Current-tax estimates use an illustrative statewide ${(PLACEHOLDER_RATE * 1000).toFixed(1)}-mill placeholder, not actual tax bills or a validated taxable base.`,
        "USE_DESC descriptions containing agriculture, horticulture, farm, or forest are a broad classification proxy and may include mixed uses; they do not establish statutory eligibility. 'Single Family Residential' descriptions are used for the SFH benchmark, not verified detached homes or owner occupancy.",
        "Condominium and other multiple assessor records can be stacked on a single polygon/location, as intended by the MassGIS data model. Counts and summed values therefore describe assessment records, not necessarily unique mapped parcels or structures.",
        "MassGIS warns that assessor parcel maps represent property boundaries for mapping and analysis, not authoritative legal boundaries. The statewide parcel layer has no filtered low-zoom tile layer; interactive parcel vectors are used so selected-geography filtering remains accurate.",
        "Census TIGERweb 2026-vintage legislative and 119th Congress districts and MassGIS municipal boundaries are for analysis and mapping, not legal surveys.",
      ],
      rateDefinition: `Illustrative statewide placeholder rate of ${(PLACEHOLDER_RATE * 100).toFixed(2)}% of source-reported TOTAL_VAL; this is not a certified Massachusetts rate.`,
      sfhNotes: "Benchmark proxy: positive TOTAL_VAL minus LAND_VAL and a USE_DESC beginning 'Single Family Residential'. This is not a verified detached-home, building-type, or owner-occupancy classification.",
      sourceLines: [`MassGIS Level 3 Property Tax Parcels: ${PARCELS_URL}`, `MassGIS Municipalities: ${MUNICIPALITIES_URL}`, "U.S. Census Bureau TIGERweb boundaries: https://tigerweb.geo.census.gov/"],
      csvColumnNotes: [
        "POLY_TYPE: MassGIS FEE or TAX polygon type; both are included because the hosted layer's source expression explicitly includes both assessment-bearing parcel types.",
        "PROP_ID: assessor record identifier; MAP_PAR_ID and LOC_ID identify the mapped parcel/location. Multiple assessor records may share a polygon or location.",
        "LAND_VAL, BLDG_VAL, OTHER_VAL, and TOTAL_VAL: source assessor values; MODEL_NONLAND_VALUE is derived as TOTAL_VAL minus LAND_VAL because MassGIS notes the components may not sum to TOTAL_VAL.",
        "USE_CODE and USE_DESC: source-reported use classification; FY is the assessment fiscal-year vintage, which may differ by municipality.",
      ],
    },
  });
})();
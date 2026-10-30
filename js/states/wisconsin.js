"use strict";

// Wisconsin: the statewide parcel layer (V12) is polygons only, with assessment and tax-bill
// attributes on each polygon. There is no statewide parcel point layer, so:
//   - shapes carry their own attributes (one request draws and describes each parcel);
//   - county and municipality selections use attribute filters (CONAME, PLACENAME) and are exact;
//   - district selections use polygon intersection plus a boundary correction: parcels that touch the
//     district outline but whose centroid (LONGITUDE/LATITUDE) falls outside are excluded by OBJECTID.
// Current tax uses effective rates derived from reported gross tax bills (GRSPRPTA / CNTASSDVALUE).
(() => {
  const PARCELS_URL = "https://services3.arcgis.com/n6uYoouQZW75n5WI/arcgis/rest/services/Wisconsin_Statewide_Parcels_DB/FeatureServer/0";
  const LTSB = "https://services1.arcgis.com/FDsAtKBk8Hy4cAH0/arcgis/rest/services";
  const TAXABLE_WHERE = "CNTASSDVALUE > 0 AND (AUXCLASS IS NULL OR AUXCLASS NOT LIKE '%X%')";
  const DISTRICT_OFFSET = 0.00003;
  const AREA_OFFSET = 0.0002;

  const classes = (p) => String(p.PROPCLASS || "").split(",").map((value) => value.trim().toUpperCase()).filter(Boolean);
  const NOT_AG = "(PROPCLASS IS NULL OR PROPCLASS NOT LIKE '%4%')";
  const IMPROVED = `${NOT_AG} AND IMPVALUE > 0`;
  const SFH_WHERE = "PROPCLASS = '1' AND IMPVALUE > 0";
  const isSingleFamilyParcel = (p) => {
    const list = classes(p);
    return list.length === 1 && list[0] === "1" && Number(p.IMPVALUE) > 0;
  };

  const PROPERTY_TYPES = [
    {
      key: "agricultural",
      label: "Agricultural",
      definition: "Any parcel with property class 4 (agricultural), with or without buildings.",
      where: "PROPCLASS LIKE '%4%'",
      matches: ({ properties }) => classes(properties).includes("4"),
    },
    {
      key: "vacant",
      label: "Vacant / unimproved land",
      definition: "Any other parcel with no assessed improvement value (blank or $0).",
      where: `${NOT_AG} AND (IMPVALUE IS NULL OR IMPVALUE = 0)`,
      matches: ({ improved }) => !improved,
    },
    {
      key: "sfh",
      label: "Residential (class 1 only)",
      definition: "Improved parcels whose only property class is 1 (residential). Wisconsin's statewide data has no building type, so this includes single-family homes, duplexes, condominiums, and small apartment buildings.",
      where: `${IMPROVED} AND PROPCLASS = '1'`,
      matches: ({ properties }) => isSingleFamilyParcel(properties),
    },
    {
      key: "mixedUse",
      label: "Mixed residential / commercial",
      definition: "Improved parcels with both class 1 (residential) and class 2 (commercial).",
      where: `${IMPROVED} AND PROPCLASS LIKE '%1%' AND PROPCLASS LIKE '%2%'`,
      matches: ({ properties }) => classes(properties).includes("1") && classes(properties).includes("2"),
    },
    {
      key: "commercial",
      label: "Commercial",
      definition: "Remaining improved parcels with class 2 (commercial).",
      where: `${IMPROVED} AND PROPCLASS LIKE '%2%' AND PROPCLASS NOT LIKE '%1%'`,
      matches: ({ properties }) => classes(properties).includes("2"),
    },
    {
      key: "industrial",
      label: "Manufacturing",
      definition: "Remaining improved parcels with class 3 (manufacturing).",
      where: `${IMPROVED} AND PROPCLASS LIKE '%3%' AND PROPCLASS NOT LIKE '%2%'`,
      matches: ({ properties }) => classes(properties).includes("3"),
    },
    {
      key: "otherResidential",
      label: "Other residential",
      definition: "Remaining improved parcels with class 1 combined with undeveloped, forest, or other classes.",
      where: `${IMPROVED} AND PROPCLASS LIKE '%1%' AND PROPCLASS <> '1' AND PROPCLASS NOT LIKE '%2%' AND PROPCLASS NOT LIKE '%3%'`,
      matches: ({ properties }) => classes(properties).includes("1"),
    },
    {
      key: "undeveloped",
      label: "Undeveloped / forest (improved)",
      definition: "Remaining improved parcels with class 5, 5M, or 6.",
      where: `${IMPROVED} AND (PROPCLASS LIKE '%5%' OR PROPCLASS LIKE '%6%') AND PROPCLASS NOT LIKE '%1%' AND PROPCLASS NOT LIKE '%2%' AND PROPCLASS NOT LIKE '%3%'`,
      matches: ({ properties }) => classes(properties).some((value) => ["5", "5M", "6"].includes(value)),
    },
    {
      key: "other",
      label: "Other",
      definition: "Remaining improved parcels, mostly class 7 (other) or no class.",
      where: `${IMPROVED} AND (PROPCLASS IS NULL OR (PROPCLASS NOT LIKE '%1%' AND PROPCLASS NOT LIKE '%2%' AND PROPCLASS NOT LIKE '%3%' AND PROPCLASS NOT LIKE '%5%' AND PROPCLASS NOT LIKE '%6%'))`,
      matches: () => true,
    },
  ];

  const PROPERTY_CLASS_LABELS = {
    1: "Residential", 2: "Commercial", 3: "Manufacturing", 4: "Agricultural",
    5: "Undeveloped", "5M": "Agricultural forest", 6: "Productive forest", 7: "Other",
  };

  // Parcel CONAME values are upper case without periods ("ST CROIX").
  const parcelCountyName = (name) => String(name || "").trim().toUpperCase().replace(/^SAINT /, "ST ").replace(/\./g, "");
  const countyLabel = (coname) => `${titleCase(coname)} County`;
  const placeLabel = (placename) => titleCase(placename).replace(/ Of /g, " of ");
  const CTV_WORDS = { C: "CITY", V: "VILLAGE", T: "TOWN" };

  // ---------- Effective rates from reported tax bills ----------

  const rates = { byPlace: new Map(), byCounty: new Map(), state: null };
  let ratesPromise = null;

  async function loadRates(signal) {
    const statistics = JSON.stringify([
      { statisticType: "sum", onStatisticField: "GRSPRPTA", outStatisticFieldName: "tax" },
      { statisticType: "sum", onStatisticField: "CNTASSDVALUE", outStatisticFieldName: "base" },
    ]);
    const features = await queryAllJson(PARCELS_URL, {
      where: `${TAXABLE_WHERE} AND GRSPRPTA > 0`,
      outFields: "CONAME,PLACENAME",
      groupByFieldsForStatistics: "CONAME,PLACENAME",
      orderByFields: "CONAME,PLACENAME",
      outStatistics: statistics,
      returnGeometry: "false",
    }, signal, 2000);
    const countyTotals = new Map();
    let stateTax = 0;
    let stateBase = 0;
    features.forEach(({ attributes: a = {} }) => {
      const tax = Number(a.tax);
      const base = Number(a.base);
      if (!(tax > 0 && base > 0)) return;
      rates.byPlace.set(`${a.CONAME}|${a.PLACENAME}`, tax / base);
      const county = countyTotals.get(a.CONAME) || { tax: 0, base: 0 };
      county.tax += tax;
      county.base += base;
      countyTotals.set(a.CONAME, county);
      stateTax += tax;
      stateBase += base;
    });
    countyTotals.forEach(({ tax, base }, county) => rates.byCounty.set(county, tax / base));
    rates.state = stateBase > 0 ? stateTax / stateBase : null;
  }

  function taxJurisdictionDetails(p) {
    const county = p.CONAME ? countyLabel(p.CONAME) : "Unknown county";
    const municipality = p.PLACENAME ? placeLabel(p.PLACENAME) : null;
    const rate = rates.byPlace.get(`${p.CONAME}|${p.PLACENAME}`)
      ?? rates.byCounty.get(p.CONAME)
      ?? rates.state;
    return { county, municipality, rate, jurisdiction: municipality ? `${county} — ${municipality}` : county };
  }

  // ---------- Geographies ----------

  const districtGeography = (label, serviceName, field, prefix) => ({
    label,
    choiceLabel: "District",
    load: (signal) => loadArcgisGeography({
      serviceUrl: `${LTSB}/${serviceName}/FeatureServer/0`,
      outFields: field,
      maxAllowableOffset: DISTRICT_OFFSET,
      value: (p) => p[field],
      label: (p, value) => `${prefix} - ${value}`,
    }, signal),
  });

  const acknowledgementsHtml = `
    <li><a href="https://www.sco.wisc.edu/parcels/data/" target="_blank" rel="noopener">Wisconsin Statewide Parcel Map Initiative (V12)</a>, via the <a href="${PARCELS_URL}" target="_blank" rel="noopener">Wisconsin Statewide Parcels feature service</a> — parcel boundaries, assessments, and reported tax bills</li>
    <li><a href="https://gis-ltsb.hub.arcgis.com/" target="_blank" rel="noopener">Wisconsin Legislative Technology Services Bureau</a> — 2024 State Senate and Assembly districts, 2022 congressional districts, and cities, towns, and villages</li>
    <li><a href="https://data-wi-dnr.opendata.arcgis.com/" target="_blank" rel="noopener">Wisconsin DNR</a> — County Boundaries 24K</li>
    <li><a href="https://tigerweb.geo.census.gov/" target="_blank" rel="noopener">U.S. Census Bureau TIGERweb</a> — 2020 urban areas</li>`;

  const optional = (value) => (value === null || value === undefined || value === "" ? null : value);
  const percentOf = (part, total) => (Number(total) ? ` (${((Number(part) / Number(total)) * 100).toFixed(0)}%)` : "");
  const urbanCache = new Map();

  window.ParcelStates.register({
    id: "WI",
    name: "Wisconsin",
    center: [44.6, -89.9],
    zoom: 7,
    brand: {
      eyebrow: "Wisconsin property insights",
      dataNote: "Parcels provided by the Wisconsin Statewide Parcel Map Initiative",
      acknowledgementsHtml,
    },
    tax: {
      description: "Load Wisconsin parcels with a positive assessed value and no exempt (X) class. Current tax uses each municipality's effective rate from reported gross tax bills, which includes ALL LEVIES (school, municipal, county, technical college), not county tax alone.",
      scopeLabel: "Gross property tax, all levies (effective rate from reported bills)",
      shortLabel: "Property Tax (All Levies)",
      rateNote: "Municipalities without reported tax bills use their county's effective rate, or the statewide effective rate when the county reports none.",
    },
    parcels: {
      analysisUrl: PARCELS_URL,
      analysisGeometry: "polygon",
      shapesUrl: PARCELS_URL,
      shapesCarryAttributes: true,
      generalizeShapes: true,
      outFields: "OBJECTID,PARCELID,TAXPARCELID,SITEADRESS,ZIPCODE,PLACENAME,CONAME,PROPCLASS,AUXCLASS,CNTASSDVALUE,LNDVALUE,IMPVALUE,ESTFMKVALUE,GRSPRPTA,NETPRPTA,ASSDACRES,SCHOOLDIST,TAXROLLYEAR,LONGITUDE,LATITUDE",
      taxableWhere: TAXABLE_WHERE,
      objectIdField: "OBJECTID",
      pageSize: 2000,
      percentileExpressions: false,
      center: (p) => {
        const x = Number(p.LONGITUDE);
        const y = Number(p.LATITUDE);
        return p.LONGITUDE !== null && p.LATITUDE !== null && Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
      },
    },
    fields: { land: "LNDVALUE", improvement: "IMPVALUE", improvementCount: "IMPVALUE", total: "CNTASSDVALUE" },
    values: (p) => ({
      land: Number(p.LNDVALUE),
      improvement: p.IMPVALUE === null || p.IMPVALUE === undefined ? null : Number(p.IMPVALUE),
      total: Number(p.CNTASSDVALUE),
    }),
    jurisdictionGroupBy: "CONAME,PLACENAME",
    prepare: (signal) => {
      if (!ratesPromise) {
        ratesPromise = loadRates(signal).catch((error) => {
          ratesPromise = null;
          throw error;
        });
      }
      return ratesPromise;
    },
    taxJurisdictionDetails,
    sfh: {
      where: SFH_WHERE,
      matches: isSingleFamilyParcel,
      definition: "improved parcels whose only property class is 1 (residential); Wisconsin's statewide data has no building type, so duplexes, condos, and small apartment buildings are included",
    },
    propertyTypes: PROPERTY_TYPES,
    occupancy: {
      groups: [{ key: "", label: "Not reported" }],
      definition: "Wisconsin's statewide parcel data does not report owner occupancy, so all parcels are reported together.",
    },
    geographies: {
      stateSenate: districtGeography("Wisconsin State Senate districts (2024)", "WI_Senate_Districts_2024", "SEN2024", "WI Senate"),
      stateAssembly: districtGeography("Wisconsin State Assembly districts (2024)", "WI_Assembly_Districts_2024", "ASM2024", "WI Assembly"),
      congressional: districtGeography("U.S. congressional districts (2022)", "WI_Congressional_Districts_(2022)", "CON2021", "U.S."),
      county: {
        label: "Counties",
        choiceLabel: "County",
        load: (signal) => loadArcgisGeography({
          serviceUrl: "https://services5.arcgis.com/Ul9AyFFeFTjf08DW/arcgis/rest/services/WI_County_Bnd_24K_WGS/FeatureServer/0",
          outFields: "COUNTY_NAM",
          maxAllowableOffset: AREA_OFFSET,
          value: (p) => p.COUNTY_NAM,
          label: (p, value) => `${value} County`,
          county: (p) => countyLabel(parcelCountyName(p.COUNTY_NAM)),
        }, signal),
        attributeFilter: (feature) => `CONAME = ${sqlString(parcelCountyName(feature.properties.raw.COUNTY_NAM))}`,
      },
      municipality: {
        label: "Cities, villages, and towns",
        choiceLabel: "Municipality",
        verifyAttributeFilter: true,
        load: (signal) => loadArcgisGeography({
          serviceUrl: `${LTSB}/WI_Cities_Towns_and_Villages_Current/FeatureServer/0`,
          outFields: "CNTY_NAME,MCD_NAME,CTV",
          maxAllowableOffset: AREA_OFFSET,
          value: (p) => (p.MCD_NAME && CTV_WORDS[p.CTV] ? `${p.CNTY_NAME}|${p.CTV}|${p.MCD_NAME}` : null),
          label: (p) => `${titleCase(CTV_WORDS[p.CTV])} of ${p.MCD_NAME} (${p.CNTY_NAME} County)`,
          county: (p) => countyLabel(parcelCountyName(p.CNTY_NAME)),
        }, signal),
        attributeFilter: (feature) => {
          const raw = feature.properties.raw;
          return `CONAME = ${sqlString(parcelCountyName(raw.CNTY_NAME))} AND PLACENAME = ${sqlString(`${CTV_WORDS[raw.CTV]} OF ${String(raw.MCD_NAME).toUpperCase()}`)}`;
        },
      },
    },
    geographyOrder: ["stateSenate", "stateAssembly", "congressional", "county", "municipality"],
    defaultGeography: "stateAssembly",
    exportDistricts: [
      { type: "stateSenate", header: "STATE_SENATE_DISTRICT", description: "2024 Wisconsin State Senate district containing the parcel centroid." },
      { type: "stateAssembly", header: "STATE_ASSEMBLY_DISTRICT", description: "2024 Wisconsin State Assembly district containing the parcel centroid." },
      { type: "congressional", header: "CONGRESSIONAL_DISTRICT", description: "2022 U.S. congressional district containing the parcel centroid." },
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
      title: (p) => optional(p.SITEADRESS) || "Selected parcel",
      sortKey: (p) => [p.SITEADRESS, p.PARCELID],
      rows: (p, { formatCurrency }) => [
        ["Parcel ID", optional(p.PARCELID) || optional(p.TAXPARCELID)],
        ["Municipality", p.PLACENAME ? `${placeLabel(p.PLACENAME)}, ${countyLabel(p.CONAME)}` : null],
        ["Property class", classes(p).map((value) => PROPERTY_CLASS_LABELS[value] || value).join(", ") || null],
        ["Land assessment", `${formatCurrency(p.LNDVALUE)}${percentOf(p.LNDVALUE, p.CNTASSDVALUE)}`],
        ["Improvement assessment", `${formatCurrency(p.IMPVALUE)}${percentOf(p.IMPVALUE, p.CNTASSDVALUE)}`],
        ["Total assessment", `${formatCurrency(p.CNTASSDVALUE)}${Number(p.CNTASSDVALUE) ? " (100%)" : ""}`],
        ["Est. fair market value", p.ESTFMKVALUE ? formatCurrency(p.ESTFMKVALUE) : null],
        ["Reported gross tax", p.GRSPRPTA ? formatCurrency(p.GRSPRPTA) : null],
        ["School district", optional(p.SCHOOLDIST)],
      ],
    },
    csv: {
      headers: [
        "PARCELID", "TAXPARCELID", "SITEADRESS", "ZIPCODE", "PLACENAME", "CONAME", "PROPCLASS", "AUXCLASS",
        "ASSDACRES", "LNDVALUE", "IMPVALUE", "CNTASSDVALUE", "ESTFMKVALUE", "GRSPRPTA", "NETPRPTA",
        "SCHOOLDIST", "TAXROLLYEAR", "LONGITUDE", "LATITUDE",
      ],
      row: (p) => [
        p.PARCELID, p.TAXPARCELID, p.SITEADRESS, p.ZIPCODE, p.PLACENAME, p.CONAME, p.PROPCLASS, p.AUXCLASS,
        p.ASSDACRES, Number(p.LNDVALUE), p.IMPVALUE === null || p.IMPVALUE === undefined ? 0 : Number(p.IMPVALUE),
        Number(p.CNTASSDVALUE), p.ESTFMKVALUE, p.GRSPRPTA, p.NETPRPTA, p.SCHOOLDIST, p.TAXROLLYEAR, p.LONGITUDE, p.LATITUDE,
      ],
    },
    report: {
      title: "PARCEL ANALYSIS - WISCONSIN - SPLIT-RATE PROPERTY TAX SUMMARY",
      accountNoun: "parcels",
      unitDescription: "Each record is one parcel polygon in the Wisconsin statewide parcel layer. Parcels in district selections are assigned by centroid.",
      caveats: [
        "Current tax is modeled with effective rates derived from reported gross tax bills (GRSPRPTA / CNTASSDVALUE) for each county and municipality. This covers ALL property tax levies (school, municipal, county, technical college), not county tax alone.",
        "Some counties do not report tax bills in the statewide parcel data. Their municipalities use the county effective rate, or the statewide effective rate when the county reports none.",
        "Includes taxable parcels only: assessed value above $0 and no exempt (X) auxiliary class.",
        "Assessed values are local assessments and are not equalized across municipalities. Lottery and gaming credits, first-dollar credits, and special assessments are not modeled.",
        "Wisconsin's statewide data has no building type or owner occupancy, so the residential benchmark is a proxy and occupancy is not reported.",
      ],
      rateDefinition: "Rates are percent of assessed value ($ per $100). Current rate is the effective rate of the parcel's municipality.",
      sfhNotes: "Qualifying residential benchmark count: improved parcels whose only property class is 1 (residential). Wisconsin's statewide data has no building type, so this proxy includes duplexes, condominiums, and small apartment buildings.",
      sourceLines: [`Wisconsin Statewide Parcels (V12 parcel polygons): ${PARCELS_URL}`],
      csvColumnNotes: [
        "PARCELID, TAXPARCELID: parcel identifiers.",
        "SITEADRESS, ZIPCODE, PLACENAME, CONAME: address and jurisdiction attributes.",
        "PROPCLASS, AUXCLASS, ASSDACRES, SCHOOLDIST, TAXROLLYEAR: selected parcel characteristics.",
        "LNDVALUE: land assessment; IMPVALUE: improvement assessment (blank values are exported as 0); CNTASSDVALUE: total assessment.",
        "ESTFMKVALUE: estimated fair market value; GRSPRPTA / NETPRPTA: reported gross / net property tax.",
        "LONGITUDE, LATITUDE: parcel centroid used for district assignment.",
      ],
    },
  });
})();

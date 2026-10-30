"use strict";

// Indiana: the public Gateway Real Property county files carry assessed values;
// current IGIO parcel polygons provide geometry. Join the per-county fixed-width
// file to statewide polygons by the 25-column Parcel Number / state_parcel_id.
(() => {
  const PARCELS_URL = "https://gisdata.in.gov/server/rest/services/Hosted/Parcel_Boundaries_of_Indiana_Current/FeatureServer/0";
  const COUNTIES_URL = "https://gisdata.in.gov/server/rest/services/Hosted/County_Boundaries_of_Indiana_Current/FeatureServer/0";
  const TAX_YEAR = 2025;
  const PAY_YEAR = 2026;
  const PLACEHOLDER_RATE = 0.0065;
  const DISTRICT_OFFSET = 0.00003;
  const AREA_OFFSET = 0.0002;

  const COUNTY_NAMES = [
    "Adams", "Allen", "Bartholomew", "Benton", "Blackford", "Boone", "Brown", "Carroll", "Cass", "Clark",
    "Clay", "Clinton", "Crawford", "Daviess", "Dearborn", "Decatur", "DeKalb", "Delaware", "Dubois", "Elkhart",
    "Fayette", "Floyd", "Fountain", "Franklin", "Fulton", "Gibson", "Grant", "Greene", "Hamilton", "Hancock",
    "Harrison", "Hendricks", "Henry", "Howard", "Huntington", "Jackson", "Jasper", "Jay", "Jefferson", "Jennings",
    "Johnson", "Knox", "Kosciusko", "LaGrange", "Lake", "LaPorte", "Lawrence", "Madison", "Marion", "Marshall",
    "Martin", "Miami", "Monroe", "Montgomery", "Morgan", "Newton", "Noble", "Ohio", "Orange", "Owen", "Parke",
    "Perry", "Pike", "Porter", "Posey", "Pulaski", "Putnam", "Randolph", "Ripley", "Rush", "St. Joseph", "Scott",
    "Shelby", "Spencer", "Starke", "Steuben", "Sullivan", "Switzerland", "Tippecanoe", "Tipton", "Union",
    "Vanderburgh", "Vermillion", "Vigo", "Wabash", "Warren", "Warrick", "Washington", "Wayne", "Wells", "White", "Whitley",
  ];
  const COUNTY_CODE_BY_NAME = new Map(COUNTY_NAMES.map((name, index) => [normalizeName(name), String(index + 1).padStart(2, "0")]));
  const FAMILY_CLASS_CODES = new Set(["510", "511", "512", "513", "514", "515"]);
  const AGRICULTURAL_CLASS_RANGE = [100, 199];
  const TAXABLE_WHERE = "AV_TOTAL > 0 AND AV_LAND >= 0 AND AV_TOTAL >= AV_LAND";

  function normalizeName(value) {
    return String(value || "").trim().replace(/\s+County$/i, "").replace(/[.\s]/g, "").toLowerCase();
  }

  function countyDetails(geography) {
    const raw = geography?.properties?.raw || {};
    const countyName = String(raw.name || raw.NAME || geography?.properties?.COUNTY || "").trim().replace(/\s+County$/i, "");
    const countyCode = COUNTY_CODE_BY_NAME.get(normalizeName(countyName));
    const countyFips = String(raw.fips || raw.FIPS || raw.cnty_fips || raw.CNTY_FIPS || "").trim().padStart(5, "0");
    if (!countyCode || !countyFips || countyFips.length !== 5) {
      throw new Error(`Could not map ${countyName || "the selected county"} to its Indiana Gateway file and county FIPS.`);
    }
    return { countyName, countyCode, countyFips };
  }

  function archiveUrl({ countyName, countyCode }) {
    const gatewayCountyName = COUNTY_NAMES[Number(countyCode) - 1] || countyName;
    const fileName = countyCode === "01"
      ? "RealParcel_Adams_01_2025P2026.zip"
      : countyCode === "71"
        ? "realparcel_st.joseph_71_2025p2026.zip"
        : `realparcel_${gatewayCountyName}_${countyCode}_2025p2026.zip`;
    return `assets/indiana/${fileName}`;
  }

  function findTextFile(zipBytes) {
    const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
    const minOffset = Math.max(0, zipBytes.byteLength - 65557);
    let endOffset = -1;
    for (let offset = zipBytes.byteLength - 22; offset >= minOffset; offset -= 1) {
      if (view.getUint32(offset, true) === 0x06054b50) {
        endOffset = offset;
        break;
      }
    }
    if (endOffset < 0) throw new Error("Gateway county archive is not a valid ZIP file.");

    const entryCount = view.getUint16(endOffset + 10, true);
    let offset = view.getUint32(endOffset + 16, true);
    for (let index = 0; index < entryCount; index += 1) {
      if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("Gateway ZIP central directory is invalid.");
      const method = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      const name = new TextDecoder().decode(zipBytes.subarray(offset + 46, offset + 46 + nameLength));
      offset += 46 + nameLength + extraLength + commentLength;
      if (!name.toLowerCase().endsWith(".txt")) continue;

      if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("Gateway ZIP member header is invalid.");
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      return { method, compressedBytes: zipBytes.slice(dataStart, dataStart + compressedSize) };
    }
    throw new Error("Gateway county ZIP has no Real Property text file.");
  }

  function fixedInteger(value) {
    const text = value.trim();
    if (!text) return null;
    const number = Number(text);
    return Number.isSafeInteger(number) ? number : null;
  }

  function isAgricultural(properties) {
    const code = Number(properties.PropertyClassCode);
    return Number.isFinite(code) && code >= AGRICULTURAL_CLASS_RANGE[0] && code <= AGRICULTURAL_CLASS_RANGE[1];
  }

  function isSfh(properties) {
    return FAMILY_CLASS_CODES.has(String(properties.PropertyClassCode || "").trim())
      && Number(properties.AV_TOTAL) > Number(properties.AV_LAND);
  }

  const NOT_AGRICULTURAL = "(PropertyClassCode IS NULL OR PropertyClassCode < 100 OR PropertyClassCode > 199)";
  const IMPROVED = "AV_TOTAL > AV_LAND";
  const FAMILY_CLASS_LIST = [...FAMILY_CLASS_CODES].map((code) => `'${code}'`).join(", ");
  const SFH_WHERE = `${IMPROVED} AND PropertyClassCode IN (${FAMILY_CLASS_LIST})`;

  const PROPERTY_TYPES = [
    {
      key: "agricultural",
      label: "Agricultural / resource assessment classes",
      definition: "DLGF property class codes 100–199 (agricultural and classified resource-land classes). This is an assessment-class proxy, not a legal exemption determination.",
      where: "PropertyClassCode >= 100 AND PropertyClassCode <= 199",
      matches: ({ properties }) => isAgricultural(properties),
    },
    {
      key: "vacant",
      label: "No positive improvement appraisal",
      definition: "Non-agricultural parcel records whose total appraisal does not exceed land appraisal. This is a value-based vacant/unimproved proxy.",
      where: `${NOT_AGRICULTURAL} AND AV_TOTAL <= AV_LAND`,
      matches: ({ properties, improved }) => !isAgricultural(properties) && !improved,
    },
    {
      key: "sfh",
      label: "Residential one-family class proxy",
      definition: "Improved records in DLGF property classes 510–515, identified in the Gateway/DLGF class scheme as one-family dwelling classes. Detached form and owner occupancy are not independently verified.",
      where: SFH_WHERE,
      matches: ({ properties }) => isSfh(properties),
    },
    {
      key: "other",
      label: "Other improved property",
      definition: "All remaining non-agricultural records with positive modeled improvements, including other residential, commercial, industrial, and utility classes.",
      where: `${NOT_AGRICULTURAL} AND ${IMPROVED} AND (PropertyClassCode IS NULL OR PropertyClassCode NOT IN (${FAMILY_CLASS_LIST}))`,
      matches: ({ properties, improved }) => !isAgricultural(properties) && improved && !isSfh(properties),
    },
  ];

  function evaluateCondition(condition, properties) {
    return condition.split(/\s+OR\s+/i).some((term) => {
      const nullTest = term.match(/^([\w.]+)\s+IS\s+NULL$/i);
      if (nullTest) return properties[nullTest[1]] === null || properties[nullTest[1]] === undefined;
      const comparison = term.match(/^([\w.]+)\s*(<=|>=|<>|!=|=|<|>)\s*(?:([\w.]+)\s*\*\s*([\d.]+)|([\w.]+)|(-?[\d.]+)|'([^']*)')$/i);
      if (!comparison) return false;
      const [, field, operator, multiplierField, multiplier, otherField, numberValue, stringValue] = comparison;
      const left = properties[field];
      const right = multiplierField ? Number(properties[multiplierField]) * Number(multiplier)
        : otherField ? properties[otherField]
          : stringValue !== undefined ? stringValue : Number(numberValue);
      if (left === null || left === undefined || right === null || right === undefined) return false;
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
      const numerator = Number(properties[ratio[1]]);
      const denominator = Number(properties[ratio[2]]);
      return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0 ? numerator / denominator : null;
    }
    const conditional = String(expression).match(/^CASE\s+WHEN\s+(.+)\s+THEN\s+(-?[\d.]+)\s+ELSE\s+(-?[\d.]+)\s+END$/i);
    if (conditional) return Number(evaluateCondition(conditional[1], properties) ? conditional[2] : conditional[3]);
    const value = Number(properties[expression]);
    return Number.isFinite(value) ? value : null;
  }

  function values(properties) {
    const land = numberOrNull(properties.AV_LAND);
    const total = numberOrNull(properties.AV_TOTAL);
    return { land, improvement: land !== null && total !== null ? total - land : null, total };
  }

  let cachedCountyCode = null;
  let cachedCountyPromise = null;
  async function loadCountyRecords(geography, signal) {
    const county = countyDetails(geography);
    if (county.countyCode === cachedCountyCode && cachedCountyPromise) return cachedCountyPromise;
    cachedCountyCode = county.countyCode;
    cachedCountyPromise = (async () => {
      const url = archiveUrl(county);
      const response = await fetch(url, { signal, headers: { Accept: "application/zip, application/octet-stream" } });
      if (!response.ok) throw new Error(`Gateway ${county.countyName} file could not be loaded (HTTP ${response.status}).`);
      const zipBytes = new Uint8Array(await response.arrayBuffer());
      const entry = findTextFile(zipBytes);
      let textStream;
      if (entry.method === 0) textStream = new Blob([entry.compressedBytes]).stream();
      else if (entry.method === 8 && typeof DecompressionStream === "function") {
        textStream = new Blob([entry.compressedBytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      } else {
        throw new Error("This browser cannot decompress the Indiana Gateway archive format.");
      }
      const reader = textStream.getReader();
      const decoder = new TextDecoder("windows-1252");
      const recordsByKey = new Map();
      let pending = "";
      let header = true;
      let skippedInvalid = 0;
      const consumeLine = (line) => {
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (header) {
          header = false;
          return;
        }
        if (!line || line.startsWith("TRAILER") || line.length !== 1286) {
          if (line && !line.startsWith("TRAILER")) skippedInvalid += 1;
          return;
        }
        const key = line.slice(0, 25).trim();
        const propertyClassCode = line.slice(193, 196).trim();
        const land = fixedInteger(line.slice(468, 480));
        const reportedImprovement = fixedInteger(line.slice(480, 492));
        const total = fixedInteger(line.slice(1274, 1286));
        if (!key || land === null || reportedImprovement === null || total === null
          || total <= 0 || land < 0 || total < land) {
          skippedInvalid += 1;
          return;
        }
        // The independently reported total differs from land + improvements on a small number
        // of source records; the model derives improvements as total - land to keep values additive.
        if (!recordsByKey.has(key)) {
          recordsByKey.set(key, {
            ParcelNumber: key,
            LocalParcelNumber: line.slice(25, 50).trim(),
            PropertyClassCode: propertyClassCode || null,
            AV_LAND: land,
            AV_IMPROVEMENTS_REPORTED: reportedImprovement,
            AV_TOTAL: total,
            CountyCode: county.countyCode,
            CountyFips: county.countyFips,
            CountyName: county.countyName,
          });
        }
      };
      try {
        while (true) {
          if (signal?.aborted) throw new DOMException("The request was aborted.", "AbortError");
          const { value, done } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          let newline;
          while ((newline = pending.indexOf("\n")) >= 0) {
            consumeLine(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
          }
        }
        pending += decoder.decode();
        if (pending) consumeLine(pending);
      } finally {
        reader.releaseLock();
      }
      if (skippedInvalid) console.warn(`Indiana Gateway ${county.countyName}: skipped ${skippedInvalid} incomplete or non-modelable fixed-width records.`);
      return [...recordsByKey.values()];
    })();
    cachedCountyPromise.catch(() => {
      if (cachedCountyCode === county.countyCode) {
        cachedCountyCode = null;
        cachedCountyPromise = null;
      }
    });
    return cachedCountyPromise;
  }

  function taxJurisdictionDetails(properties) {
    const county = String(properties.CountyName || "").trim();
    const countyLabel = county ? `${county} County` : "Unknown county";
    return {
      county: countyLabel,
      municipality: null,
      rate: county ? PLACEHOLDER_RATE : null,
      jurisdiction: countyLabel,
    };
  }

  const acknowledgementsHtml = `
    <li><a href="${PARCELS_URL}" target="_blank" rel="noopener">Indiana Geographic Information Office (IGIO) Data Harvest parcels</a> — current parcel polygons and state parcel IDs</li>
    <li><a href="https://gateway.ifionline.org/public/download.aspx" target="_blank" rel="noopener">Indiana Gateway Real Property files</a> — 2025 assessment-year (pay 2026) county fixed-width parcel records, downloaded as ZIP archives</li>
    <li><a href="https://tigerweb.geo.census.gov/" target="_blank" rel="noopener">U.S. Census Bureau TIGERweb</a> — 2020 urban areas for map highlights</li>`;

  const optional = (value) => (value === null || value === undefined || value === "" ? null : value);
  const numberOrNull = (value) => optional(value) === null || !Number.isFinite(Number(value)) ? null : Number(value);
  const percentOf = (part, total) => (Number(total) ? ` (${((Number(part) / Number(total)) * 100).toFixed(0)}%)` : "");
  const urbanCache = new Map();

  window.ParcelStates.register({
    id: "IN",
    name: "Indiana",
    center: [39.9, -86.2],
    zoom: 7,
    brand: {
      eyebrow: "Indiana property insights",
      dataNote: "Indiana Gateway Real Property files joined to IGIO Data Harvest parcel polygons",
      acknowledgementsHtml,
    },
    tax: {
      description: `Indiana parcel assessments are from assessment year ${TAX_YEAR} (taxes paid ${PAY_YEAR}). Load county parcel records with positive gross assessed value and nonnegative land value; current tax uses a uniform illustrative placeholder, not certified tax rates or bills.`,
      scopeLabel: "Illustrative county property tax (placeholder rate)",
      shortLabel: "Illustrative Property Tax",
      rateNote: `Certified Indiana county rates are not configured. Every county currently uses an illustrative ${(PLACEHOLDER_RATE * 1000).toFixed(1)}-mill placeholder applied to gross assessed value; replace it before citing tax-dollar results.`,
    },
    parcels: {
      analysisUrl: PARCELS_URL,
      analysisGeometry: "polygon",
      shapesUrl: PARCELS_URL,
      shapesCarryAttributes: true,
      allowAllGeographies: false,
      generalizeShapes: true,
      outFields: "objectid,state_parcel_id,parcel_id,local_id,county_fips,dlgf_prop_class_code,valid_tax_code,prop_add,esri_poname,dlgf_prop_address,latitude,longitude",
      taxableWhere: TAXABLE_WHERE,
      objectIdField: "objectid",
      pageSize: 2000,
      percentileExpressions: false,
      relatedTable: {
        loadRecords: loadCountyRecords,
        keyField: "ParcelNumber",
        geometryKeyField: "state_parcel_id",
        geometryOutFields: "objectid,state_parcel_id,parcel_id,local_id,county_fips,dlgf_prop_class_code,valid_tax_code,prop_add,esri_poname,dlgf_prop_address,latitude,longitude",
        geometryWhere: (geography) => `county_fips = ${sqlString(countyDetails(geography).countyFips)}`,
        statisticValue,
      },
    },
    fields: {
      land: "AV_LAND",
      improvement: "AV_IMPROVEMENTS_REPORTED",
      improvementCount: "AV_IMPROVEMENTS_REPORTED",
      total: "AV_TOTAL",
      improvementFromTotalMinusLand: true,
    },
    values,
    jurisdictionGroupBy: "CountyCode,CountyName",
    taxJurisdictionDetails,
    sfh: {
      where: SFH_WHERE,
      matches: isSfh,
      definition: "Proxy only: positive modeled improvements and DLGF property class 510–515 (residential one-family assessment classes). Detached form and owner occupancy are not independently verified.",
    },
    propertyTypes: PROPERTY_TYPES,
    occupancy: {
      groups: [{ key: "", label: "Not reported" }],
      definition: "Owner occupancy/homestead status is not interpreted from the Gateway Real Property file.",
    },
    geographies: {
      county: {
        label: "Counties",
        choiceLabel: "County",
        load: (signal) => loadArcgisGeography({
          serviceUrl: COUNTIES_URL,
          outFields: "name,fips,cnty_fips",
          maxAllowableOffset: AREA_OFFSET,
          value: (properties) => String(properties.fips || properties.cnty_fips || ""),
          label: (properties) => String(properties.name || "").replace(/\s+County$/i, ""),
          county: (properties) => String(properties.name || "").replace(/\s+County$/i, ""),
        }, signal),
        attributeFilter: (feature) => {
          const raw = feature.properties.raw || {};
          const fips = String(raw.fips || raw.FIPS || raw.cnty_fips || raw.CNTY_FIPS || "").trim();
          const fullFips = fips.length === 3 ? `18${fips}` : fips;
          return fullFips.length === 5 ? `county_fips = ${sqlString(fullFips)}` : null;
        },
      },
    },
    geographyOrder: ["county"],
    defaultGeography: "county",
    exportDistricts: [],
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
      title: (properties) => optional(properties.prop_add) || optional(properties.dlgf_prop_address) || optional(properties.ParcelNumber) || "Selected parcel",
      sortKey: (properties) => [properties.prop_add, properties.ParcelNumber],
      rows: (properties, { formatCurrency }) => {
        const { land, improvement, total } = values(properties);
        return [
          ["Parcel number", optional(properties.ParcelNumber) || optional(properties.state_parcel_id)],
          ["Local parcel number", optional(properties.LocalParcelNumber) || optional(properties.local_id)],
          ["County", optional(properties.CountyName)],
          ["Property class code", optional(properties.PropertyClassCode) || optional(properties.dlgf_prop_class_code)],
          ["Assessment year / pay year", `${TAX_YEAR} / ${PAY_YEAR}`],
          ["Land assessed value", `${formatCurrency(land)}${percentOf(land, total)}`],
          ["Modeled improvement value (total − land)", `${formatCurrency(improvement)}${percentOf(improvement, total)}`],
          ["Reported improvement value", numberOrNull(properties.AV_IMPROVEMENTS_REPORTED) === null ? null : formatCurrency(properties.AV_IMPROVEMENTS_REPORTED)],
          ["Gross assessed total", `${formatCurrency(total)}${Number(total) ? " (100%)" : ""}`],
        ];
      },
    },
    csv: {
      headers: ["ParcelNumber", "LocalParcelNumber", "CountyName", "CountyFips", "PropertyClassCode", "AssessmentYear", "PayYear", "AV_LAND", "AV_IMPROVEMENTS_REPORTED", "AV_TOTAL", "AV_IMPROVEMENTS_MODELED"],
      row: (properties) => {
        const { improvement } = values(properties);
        return [properties.ParcelNumber, properties.LocalParcelNumber, properties.CountyName, properties.CountyFips,
          properties.PropertyClassCode, TAX_YEAR, PAY_YEAR, numberOrNull(properties.AV_LAND),
          numberOrNull(properties.AV_IMPROVEMENTS_REPORTED), numberOrNull(properties.AV_TOTAL), improvement];
      },
    },
    report: {
      title: "PARCEL ANALYSIS - INDIANA - SPLIT-RATE PROPERTY TAX SUMMARY",
      accountNoun: "parcel assessment records",
      unitDescription: "Each record is a 2025 assessment-year Real Property entry from the selected county’s Indiana Gateway file, joined to IGIO current parcel polygons by the 25-character Parcel Number / state_parcel_id.",
      caveats: [
        `The Gateway source is assessment year ${TAX_YEAR}, used for taxes paid in ${PAY_YEAR}; the file is a county-submitted fixed-width assessment extract, not an independently verified taxable-value roll.`,
        "The model uses source-reported land assessed value and gross total assessed value; modeled improvements are derived as total minus land so split-rate components reconcile. The Gateway-reported improvement total is retained in popups/exports; a small number of records have component totals that do not exactly reconcile.",
        "A stratified sample of Gateway parcel numbers matched the IGIO state_parcel_id field across counties, but county-submitted assessment data and statewide parcel geometry are independently maintained. Unmatched file rows do not draw as polygons; county metrics are source-file record totals.",
        `Certified Indiana tax rates and parcel bills are not configured. Current tax and scenarios use an illustrative ${(PLACEHOLDER_RATE * 1000).toFixed(1)}-mill placeholder; exemptions, deductions, circuit-breaker credits, and tax-cap adjustments are not modeled.`,
        "DLGF property class codes 100–199 are an agricultural/resource proxy; codes 510–515 are a residential one-family proxy. These do not independently verify legal taxability or owner occupancy.",
        "Indiana Gateway county ZIPs include owner and mailing-address information in the original public records. The adapter reads and exports only parcel identifiers, class, jurisdiction, and assessment fields; however, bundled ZIP assets remain directly downloadable to anyone if this static site is published.",
        "Detailed CSV records are county-scoped; no state legislative or congressional district breakdown is offered. Census 2020 urban areas are used for on-map high-value urban highlights.",
      ],
      rateDefinition: "The placeholder rate is percent of gross assessed value ($ per $100). It is illustrative and not an official county rate.",
      sfhNotes: "Proxy only: positive modeled improvements and DLGF property class 510–515. Detached form and owner occupancy are not independently verified.",
      sourceLines: [`Indiana Gateway Real Property files, assessment year ${TAX_YEAR} / pay year ${PAY_YEAR}: county ZIP archives in assets/indiana`, `IGIO current parcel polygons: ${PARCELS_URL}`],
      csvColumnNotes: [
        "ParcelNumber is the Gateway 50 IAC 26 Parcel Number and joins to IGIO state_parcel_id; LocalParcelNumber is the county's local CAMA identifier.",
        "AV_LAND: current assessed land total (record positions 469–480); AV_IMPROVEMENTS_REPORTED: current assessed improvement total (positions 481–492); AV_TOTAL: current gross land-plus-improvement assessed value (positions 1275–1286).",
        "AV_IMPROVEMENTS_MODELED is derived as AV_TOTAL − AV_LAND so the split-rate model reconciles to gross total value; the Gateway-reported improvement figure is retained separately.",
      ],
    },
  });
})();

"use strict";

// Maryland: SDAT/iMAP account points (one per tax account) drive the analysis.
// Parcel shapes come from a separate polygon layer; low zooms use the iMAP MapServer image export.
(() => {
  const SHAPES_URL = "https://mdgeodata.md.gov/imap/rest/services/PlanningCadastre/MD_ParcelBoundaries/MapServer/0";
  const POINTS_URL = "https://mdgeodata.md.gov/imap/rest/services/PlanningCadastre/MD_PropertyData/MapServer/0";
  const COUNTY_BOUNDARY_SERVICE_URL =
    "https://mdgeodata.md.gov/imap/rest/services/Boundaries/MD_PoliticalBoundaries/FeatureServer/1";
  const TAXABLE_WHERE =
    "ACCTID IS NOT NULL AND ACCTID NOT IN ('ROW', 'UNK', 'GCE') AND NFMTTLVL > 0 AND EXCLASS IS NULL";

  const SFH_BUILDING_TYPES = ["DWEL Standard Unit", "DWEL Split Level", "DWEL Split Foyer"];
  const SFH_WHERE = `LU = 'R' AND SQFTSTRC > 0 AND DESCBLDG IN (${sqlList(SFH_BUILDING_TYPES)})`;
  const TOWNHOUSE_BUILDING_TYPES = ["DWEL Center Unit", "DWEL End Unit"];
  const AGRICULTURAL_LAND_USES = ["A", "MA"];
  const COMMERCIAL_LAND_USES = ["C", "CC", "CA", "EC"];
  const INDUSTRIAL_LAND_USES = ["I"];
  const MIXED_USE_LAND_USES = ["CR", "RC"];
  const COMMERCIAL_RELATED_LAND_USES = [...COMMERCIAL_LAND_USES, ...INDUSTRIAL_LAND_USES, ...MIXED_USE_LAND_USES];
  const NOT_AGRICULTURAL_WHERE = `(LU IS NULL OR LU NOT IN (${sqlList(AGRICULTURAL_LAND_USES)}))`;
  const IMPROVED_WHERE = `${NOT_AGRICULTURAL_WHERE} AND NFMIMPVL > 0`;
  const landUse = (properties) => String(properties.LU || "").trim().toUpperCase();

  function isSingleFamilyParcel(properties) {
    return landUse(properties) === "R"
      && Number(properties.SQFTSTRC) > 0
      && SFH_BUILDING_TYPES.includes(properties.DESCBLDG);
  }

  // Each account belongs to the first type whose rule matches. `where` and `matches` describe the same rule.
  const PROPERTY_TYPES = [
    {
      key: "agricultural",
      label: "Agricultural",
      definition: "Land use Agricultural or Marsh Land, with or without buildings.",
      where: `LU IN (${sqlList(AGRICULTURAL_LAND_USES)})`,
      matches: ({ properties }) => AGRICULTURAL_LAND_USES.includes(landUse(properties)),
    },
    {
      key: "vacant",
      label: "Vacant / unimproved land",
      definition: "Any other land use with no assessed improvement value (blank or $0).",
      where: `${NOT_AGRICULTURAL_WHERE} AND (NFMIMPVL IS NULL OR NFMIMPVL = 0)`,
      matches: ({ improved }) => !improved,
    },
    {
      key: "sfh",
      label: "Single-family homes",
      definition: `Improved residential accounts that meet the SFH benchmark rule: structure square footage > 0 and building type ${SFH_BUILDING_TYPES.join(", ")}.`,
      where: `${IMPROVED_WHERE} AND ${SFH_WHERE}`,
      matches: ({ properties }) => isSingleFamilyParcel(properties),
    },
    {
      key: "townhouse",
      label: "Townhouses / rowhouses",
      definition: `Improved accounts with land use Town House, or residential with building type ${TOWNHOUSE_BUILDING_TYPES.join(", ")}.`,
      where: `${IMPROVED_WHERE} AND (LU = 'TH' OR (LU = 'R' AND DESCBLDG IN (${sqlList(TOWNHOUSE_BUILDING_TYPES)})))`,
      matches: ({ properties }) => landUse(properties) === "TH"
        || (landUse(properties) === "R" && TOWNHOUSE_BUILDING_TYPES.includes(properties.DESCBLDG)),
    },
    {
      key: "condo",
      label: "Condominiums",
      definition: "Improved accounts with land use Residential Condominium (each unit is its own account).",
      where: `${IMPROVED_WHERE} AND LU = 'U'`,
      matches: ({ properties }) => landUse(properties) === "U",
    },
    {
      key: "otherResidential",
      label: "Other residential",
      definition: "Remaining improved residential accounts, such as mobile homes, rental dwellings, and accounts with no building type.",
      where: `${IMPROVED_WHERE} AND LU = 'R' AND (DESCBLDG IS NULL OR DESCBLDG NOT IN (${sqlList([...SFH_BUILDING_TYPES, ...TOWNHOUSE_BUILDING_TYPES])}) OR (DESCBLDG IN (${sqlList(SFH_BUILDING_TYPES)}) AND (SQFTSTRC IS NULL OR SQFTSTRC <= 0)))`,
      matches: ({ properties }) => landUse(properties) === "R",
    },
    {
      key: "apartments",
      label: "Apartments",
      definition: "Improved accounts with land use Apartments.",
      where: `${IMPROVED_WHERE} AND LU = 'M'`,
      matches: ({ properties }) => landUse(properties) === "M",
    },
    {
      key: "commercial",
      label: "Commercial",
      definition: "Improved accounts with land use Commercial, Commercial Condominium, Country Club, or Exempt Commercial.",
      where: `${IMPROVED_WHERE} AND LU IN (${sqlList(COMMERCIAL_LAND_USES)})`,
      matches: ({ properties }) => COMMERCIAL_LAND_USES.includes(landUse(properties)),
    },
    {
      key: "mixedUse",
      label: "Mixed use",
      definition: "Improved accounts with land use Commercial/Residential or Residential/Commercial.",
      where: `${IMPROVED_WHERE} AND LU IN (${sqlList(MIXED_USE_LAND_USES)})`,
      matches: ({ properties }) => MIXED_USE_LAND_USES.includes(landUse(properties)),
    },
    {
      key: "industrial",
      label: "Industrial",
      definition: "Improved accounts with land use Industrial.",
      where: `${IMPROVED_WHERE} AND LU IN (${sqlList(INDUSTRIAL_LAND_USES)})`,
      matches: ({ properties }) => INDUSTRIAL_LAND_USES.includes(landUse(properties)),
    },
    {
      key: "other",
      label: "Other",
      definition: "Remaining improved accounts, mostly land use Exempt without an exemption class.",
      where: `${IMPROVED_WHERE} AND (LU IS NULL OR LU NOT IN (${sqlList(["R", "TH", "U", "M", ...COMMERCIAL_RELATED_LAND_USES])}))`,
      matches: () => true,
    },
  ];

  const COUNTY_TAX_RATES = {
    "Allegany County": { base: 0.00975, municipalities: { Barton: 0.009133, Cumberland: 0.008195, Frostburg: 0.00861, Lonaconing: 0.008756, Luke: 0.008752, Midland: 0.009133, Westernport: 0.009133 } },
    "Anne Arundel County": { base: 0.00968, municipalities: { Annapolis: 0.00577, "Highland Beach": 0.00938 } },
    "Baltimore City": { base: 0.02248, municipalities: {} },
    "Baltimore County": { base: 0.011, municipalities: {} },
    "Calvert County": { base: 0.00967, municipalities: { "Chesapeake Beach": 0.00605, "North Beach": 0.00605 } },
    "Caroline County": { base: 0.0096, municipalities: { Denton: 0.009, Federalsburg: 0.0088, Greensboro: 0.009, Preston: 0.0095, Ridgely: 0.0091 } },
    "Carroll County": { base: 0.01018, municipalities: {} },
    "Cecil County": { base: 0.009724, municipalities: {} },
    "Charles County": { base: 0.01141, municipalities: { "Indian Head": 0.01112, "La Plata": 0.01023 } },
    "Dorchester County": { base: 0.0103, municipalities: { Cambridge: 0.009567, Hurlock: 0.009479 } },
    "Frederick County": { base: 0.0111, municipalities: { Frederick: 0.010125, Myersville: 0.009666 } },
    "Garrett County": { base: 0.01, municipalities: { "Mountain Lake Park": 0.009476 } },
    "Harford County": { base: 0.009779, municipalities: { Aberdeen: 0.008413, "Bel Air": 0.008413, "Havre de Grace": 0.008413 } },
    "Howard County": { base: 0.01044, municipalities: {} },
    "Kent County": { base: 0.01022, municipalities: {} },
    "Montgomery County": { base: 0.007176, municipalities: {} },
    "Prince George's County": { base: 0.01, municipalities: { "Berwyn Heights": 0.00867, Bladensburg: 0.00875, Bowie: 0.00878, Brentwood: 0.00919, "Capitol Heights": 0.00908, Cheverly: 0.00902, "College Park": 0.00968, "Colmar Manor": 0.00903, "Cottage City": 0.00929, "District Heights": 0.00923, "Eagle Harbor": 0.00999, Edmonston: 0.00908, "Fairmount Heights": 0.00937, "Forest Heights": 0.00893, Glenarden: 0.00892, Greenbelt: 0.00875, Hyattsville: 0.00884, "Landover Hills": 0.00907, Laurel: 0.00867, Morningside: 0.00909, "Mount Rainier": 0.00879, "New Carrollton": 0.00886, "North Brentwood": 0.0098, "Riverdale Park": 0.00882, "Seat Pleasant": 0.00885, "University Park": 0.00881, "Upper Marlboro": 0.0093 } },
    "Queen Anne's County": { base: 0.008, municipalities: { Centreville: 0.0067, Millington: 0.00715 } },
    "Somerset County": { base: 0.01, municipalities: {} },
    "St. Mary's County": { base: 0.009278, municipalities: {} },
    "Talbot County": { base: 0.00818, municipalities: { Easton: 0.00685, Oxford: 0.007, "Queen Anne": 0.007579, "St. Michaels": 0.00691, Trappe: 0.0072 } },
    "Washington County": { base: 0.00928, municipalities: { Boonsboro: 0.00803, "Clear Spring": 0.00803, Funkstown: 0.00803, Hagerstown: 0.00803, Hancock: 0.00803, Keedysville: 0.00803, Sharpsburg: 0.00803, Smithsburg: 0.00803, Williamsport: 0.00803 } },
    "Wicomico County": { base: 0.007799, municipalities: {} },
    "Worcester County": { base: 0.00815, municipalities: {} },
  };
  const COUNTY_BY_JURISDICTION = {
    ALLE: "Allegany County", ANNE: "Anne Arundel County", BACI: "Baltimore City", BACO: "Baltimore County",
    CALV: "Calvert County", CARO: "Caroline County", CARR: "Carroll County", CECI: "Cecil County",
    CHAR: "Charles County", DORC: "Dorchester County", FRED: "Frederick County", GARR: "Garrett County",
    HARF: "Harford County", HOWA: "Howard County", KENT: "Kent County", MONT: "Montgomery County",
    PRIN: "Prince George's County", QUEE: "Queen Anne's County", SOME: "Somerset County", STMA: "St. Mary's County",
    TALB: "Talbot County", WASH: "Washington County", WICO: "Wicomico County", WORC: "Worcester County",
  };

  // Parcel town names that differ from MUN_NAME in the municipality boundary layer.
  const PARCEL_TOWN_NAMES = {
    BOONSBORO: "BOONESBORO",
    BROOKEVILLE: "BROOKVILLE",
    "CHEVY CHASE SECTION 3": "CHEVY CHASE SEC. 3",
    "CHEVY CHASE SECTION 5": "CHEVY CHASE SEC. 5",
    "CHEVY CHASE TOWN": "CHEVY CHASE TOWN OF",
    FREDERICK: "FREDERICK CITY",
    "LOCH LYNN HEIGHTS": "LOCH LYNN",
    "MARTINS ADDITIONS": "MARTINS ADDITION",
    "NORTH CHEVY CHASE": "CHEVY CHASE NORTH",
    "ST. MICHAELS": "SAINT MICHAELS",
  };
  const MUNICIPALITY_NAMES_BY_PARCEL_TOWN = Object.fromEntries(
    Object.entries(PARCEL_TOWN_NAMES).map(([boundaryName, parcelName]) => [parcelName, boundaryName]),
  );

  function countyKeyFromStateName(value) {
    const name = String(value || "").trim();
    if (!name) return null;
    return name === "Baltimore City" ? name : `${name} County`;
  }

  function normalizeMunicipalityName(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/\bcity\b/g, "")
      .replace(/\bsaint\b/g, "st")
      .replace(/\./g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function municipalityNameFromParcelDescription(value) {
    const parts = String(value || "").trim().split(/\s+/);
    return parts.length > 1 ? parts.slice(1).join(" ") : null;
  }

  function municipalRateEntry(county, municipality) {
    if (!municipality) return null;
    const boundaryName = MUNICIPALITY_NAMES_BY_PARCEL_TOWN[String(municipality).trim().toUpperCase()];
    const municipalityName = normalizeMunicipalityName(boundaryName || municipality);
    return Object.entries(COUNTY_TAX_RATES[county]?.municipalities || {})
      .find(([name]) => normalizeMunicipalityName(name) === municipalityName) || null;
  }

  function taxRateForLocation(county, municipality) {
    const countyRates = COUNTY_TAX_RATES[county];
    if (!countyRates) return null;
    return municipalRateEntry(county, municipality)?.[1] ?? countyRates.base;
  }

  function taxJurisdictionDetails(properties) {
    const county = COUNTY_BY_JURISDICTION[String(properties.JURSCODE || "").toUpperCase()] || "Unknown county";
    const parcelMunicipality = properties.TOWNCODE ? municipalityNameFromParcelDescription(properties.DESCTOWN) : null;
    const rate = taxRateForLocation(county, parcelMunicipality);
    const countyRate = COUNTY_TAX_RATES[county]?.base ?? null;
    const municipality = municipalRateEntry(county, parcelMunicipality)?.[0] ?? null;
    const hasDistinctMunicipalRate = municipality && Number.isFinite(rate)
      && Number.isFinite(countyRate) && rate !== countyRate;
    const jurisdiction = hasDistinctMunicipalRate ? `${county} — ${municipality}` : county;
    return { county, municipality: hasDistinctMunicipalRate ? municipality : null, rate, jurisdiction };
  }

  // ---------- Geographies ----------

  function normalizeAssemblyDistrictValue(value) {
    const text = String(value ?? "").trim();
    const match = text.match(/^\s*(\d+)(?:[A-Z])?\s*$/i);
    return match ? match[1] : text;
  }

  function compareAssemblyDistrictValues(a, b) {
    const getParts = (value) => {
      const match = String(value ?? "").trim().match(/^(\d+)([A-Z])?$/i);
      if (!match) return { base: Number.NaN, suffix: "" };
      return { base: Number(match[1]), suffix: (match[2] || "").toUpperCase() };
    };
    const left = getParts(a);
    const right = getParts(b);
    if (Number.isFinite(left.base) && Number.isFinite(right.base) && left.base !== right.base) {
      return left.base - right.base;
    }
    if (left.base !== right.base) return String(a).localeCompare(String(b));
    const suffixOrder = { "": 0, A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, I: 9, J: 10 };
    return (suffixOrder[left.suffix] ?? 99) - (suffixOrder[right.suffix] ?? 99);
  }

  const COUNCIL_SOURCES = [
    { county: "Allegany County", serviceUrl: COUNTY_BOUNDARY_SERVICE_URL, where: "COUNTY = 'Allegany'", valueField: "COUNTY", outFields: "COUNTY", formatChoice: () => "At-large" },
    { county: "Anne Arundel County", serviceUrl: "https://gis.aacounty.org/arcgis/rest/services/OpenData/Political_OpenData/MapServer/4", valueField: "CNCLDIST", outFields: "CNCLDIST,COUNCILS", formatChoice: (p) => `${p.CNCLDIST}${p.COUNCILS ? ` (${p.COUNCILS})` : ""}` },
    { county: "Baltimore City", serviceUrl: "https://services1.arcgis.com/UWYHeuuJISiGmgXx/arcgis/rest/services/Baltimore_City_Council_District/FeatureServer/80", valueField: "AREA_NAME", outFields: "AREA_NAME" },
    { county: "Baltimore County", serviceUrl: "https://bcgis.baltimorecountymd.gov/arcgis/rest/services/Apps/MyNeighborhood/MapServer/13", valueField: "COUNCILMANIC_DISTRICTS", outFields: "COUNCILMANIC_DISTRICTS" },
    { county: "Calvert County", serviceUrl: "https://services2.arcgis.com/svdkKIzwWblQ8cKK/arcgis/rest/services/Local_Election_Districts/FeatureServer/281", valueField: "DISTRICT", outFields: "DISTRICT", formatChoice: (p) => `District ${p.DISTRICT}` },
    { county: "Carroll County", serviceUrl: "https://services.arcgis.com/Uf0DiYpD9NOFO5YH/ArcGIS/rest/services/CommissionerDistricts/FeatureServer/0", valueField: "COMMDIST", outFields: "COMMDIST", formatChoice: (p) => `District ${p.COMMDIST}` },
    { county: "Cecil County", serviceUrl: "https://cecilmaps.org/arcgis/rest/services/Hosted/Ceci_lCounty_Council_Districts_(effective_Feb_11_2022)/FeatureServer/0", valueField: "comm_distr", outFields: "comm_distr,district" },
    { county: "Caroline County", serviceUrl: COUNTY_BOUNDARY_SERVICE_URL, where: "COUNTY = 'Caroline'", valueField: "COUNTY", outFields: "COUNTY", formatChoice: () => "At-large" },
    { county: "Dorchester County", serviceUrl: "https://services7.arcgis.com/yqhlYKSnzjiOzQig/ArcGIS/rest/services/Council_District_Draft4/FeatureServer/0", valueField: "DIST_NAME", outFields: "DIST_NAME,DISTRICT" },
    { county: "Frederick County", serviceUrl: "https://fcgis.frederickcountymd.gov/server_pub/rest/services/Elections/Elections/MapServer/8", valueField: "COUNCIL_DIST", outFields: "COUNCIL_DIST", formatChoice: (p) => `District ${p.COUNCIL_DIST}` },
    { county: "Garrett County", serviceUrl: "https://services3.arcgis.com/Hj3vC5lmzqLyRabS/ArcGIS/rest/services/Board_of_Elections/FeatureServer/0", valueField: "Comm_Dist", outFields: "Comm_Dist", formatChoice: (p) => `District ${p.Comm_Dist}` },
    { county: "Harford County", serviceUrl: "https://services.arcgis.com/q8r0H9SbF6PzNpYE/ArcGIS/rest/services/2025_Harford_County_Election_Files_gdb/FeatureServer/2", valueField: "DISTRICT", outFields: "DISTRICT", formatChoice: (p) => `District ${p.DISTRICT}` },
    { county: "Montgomery County", serviceUrl: "https://geohub.montgomerycountymd.gov/mapping1/rest/services/Boundaries/Council_Districts_slim/FeatureServer/0", valueField: "COUNCIL", outFields: "COUNCIL", formatChoice: (p) => `District ${p.COUNCIL}` },
    { county: "Howard County", queryUrl: "https://hcgeoserver.howardcountymd.gov:8443/geoserver/general/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=general%3ACouncil_Districts&outputFormat=text%2Fjavascript&srsName=EPSG%3A4326&maxFeatures=50", jsonp: true, valueField: "DISTRICT20", formatChoice: (p) => `District ${p.DISTRICT20}` },
    { county: "Kent County", serviceUrl: COUNTY_BOUNDARY_SERVICE_URL, where: "COUNTY = 'Kent'", valueField: "COUNTY", outFields: "COUNTY", formatChoice: () => "At-large" },
    { county: "Prince George's County", serviceUrl: "https://gis.pgatlas.com/pgatlas/rest/services/Administrative/MapServer/100", valueField: "DISTRICT_NUMBER", outFields: "DISTRICT_NUMBER", formatChoice: (p) => `District ${p.DISTRICT_NUMBER}` },
    { county: "Charles County", serviceUrl: "https://services7.arcgis.com/3BMWkdyrt45RNCrq/arcgis/rest/services/CommDistricts_2022/FeatureServer/0", valueField: "COMM_DIST", outFields: "COMM_DIST", formatChoice: (p) => `District ${p.COMM_DIST}` },
    { county: "Queen Anne's County", serviceUrl: "assets/districts/Queen_Anne_CommissionerDistrictBoundaries.zip", format: "shapefile", valueField: "CC_Dist", formatChoice: (p) => `District ${p.CC_Dist}` },
    { county: "Somerset County", serviceUrl: "assets/districts/Somerset_Commissioner_Districts.zip", format: "shapefile", valueField: "Name", formatChoice: (p) => p.Name },
    { county: "St. Mary's County", serviceUrl: "https://gis.stmaryscountymd.gov/server/rest/services/Public/General1/MapServer/10", valueField: "DISTRICT", outFields: "DISTRICT", formatChoice: (p) => `District ${p.DISTRICT}` },
    { county: "Talbot County", serviceUrl: COUNTY_BOUNDARY_SERVICE_URL, where: "COUNTY = 'Talbot'", valueField: "COUNTY", outFields: "COUNTY", formatChoice: () => "At-large" },
    { county: "Washington County", serviceUrl: COUNTY_BOUNDARY_SERVICE_URL, where: "COUNTY = 'Washington'", valueField: "COUNTY", outFields: "COUNTY", formatChoice: () => "At-large" },
    { county: "Wicomico County", serviceUrl: "https://gisapps.wicomicocounty.org/server/rest/services/CouncilmanisAdoptedDec2_2025/MapServer/7", valueField: "DISTRICT", outFields: "DISTRICT", supportsPagination: false, formatChoice: (p) => `District ${p.DISTRICT}` },
    { county: "Worcester County", serviceUrl: "https://wcg-gisweb.co.worcester.md.us/arcgis/rest/services/Election_Districts_Map_MIL1/MapServer/14", valueField: "DISTRICT", outFields: "DISTRICT", formatChoice: (p) => `District ${p.DISTRICT}` },
  ];

  function councilQueryUrl(source) {
    if (source.queryUrl) return source.queryUrl;
    const params = new URLSearchParams({
      where: source.where || "1=1",
      outFields: source.outFields,
      returnGeometry: "true",
      outSR: "4326",
      f: "geojson",
    });
    if (source.supportsPagination !== false) params.set("resultRecordCount", "3000");
    return `${source.serviceUrl}/query?${params.toString()}`;
  }

  let jsonpRequestId = 0;
  function loadCouncilJsonp(source, signal) {
    return new Promise((resolve, reject) => {
      const callbackName = `multistateHowardCouncil${++jsonpRequestId}`;
      const script = document.createElement("script");
      let settled = false;
      const cleanup = () => {
        script.remove();
        delete window[callbackName];
        signal.removeEventListener("abort", handleAbort);
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const handleAbort = () => finish(reject, new DOMException("The request was aborted.", "AbortError"));
      window[callbackName] = (payload) => finish(resolve, payload);
      script.onerror = () => finish(reject, new Error("The Howard County district service could not be loaded."));
      signal.addEventListener("abort", handleAbort, { once: true });
      const url = new URL(councilQueryUrl(source));
      url.searchParams.set("outputFormat", "text/javascript");
      url.searchParams.set("srsName", "EPSG:4326");
      url.searchParams.set("format_options", `callback:${callbackName}`);
      script.src = url.toString();
      document.head.append(script);
    });
  }

  function compareCountyDistricts(a, b) {
    const [countyA, districtA = ""] = a.properties.GEOGRAPHY_LABEL.split(" — ");
    const [countyB, districtB = ""] = b.properties.GEOGRAPHY_LABEL.split(" — ");
    const countyComparison = countyA.localeCompare(countyB);
    if (countyComparison) return countyComparison;
    const numberA = Number(districtA.match(/District (\d+)/)?.[1]);
    const numberB = Number(districtB.match(/District (\d+)/)?.[1]);
    if (Number.isFinite(numberA) && Number.isFinite(numberB)) return numberA - numberB;
    if (Number.isFinite(numberA)) return -1;
    if (Number.isFinite(numberB)) return 1;
    return districtA.localeCompare(districtB);
  }

  // A broken county service is skipped so the remaining counties still load.
  async function loadCountyCouncilChoices(signal, { counties } = {}) {
    const sources = counties ? COUNCIL_SOURCES.filter((source) => counties.has(source.county)) : COUNCIL_SOURCES;
    const responses = await Promise.all(sources.map(async (source) => {
      try {
        let payload;
        if (source.format === "shapefile") {
          if (typeof shp !== "function") throw new Error("The shapefile parser did not load.");
          const response = await fetch(source.serviceUrl, { signal });
          if (!response.ok) throw new Error(`Service returned ${response.status}.`);
          payload = await shp(await response.arrayBuffer());
        } else if (source.jsonp) {
          payload = await loadCouncilJsonp(source, signal);
        } else {
          payload = await fetchJson(councilQueryUrl(source), {}, signal);
        }
        if (payload.error || payload.type !== "FeatureCollection") {
          throw new Error(payload.error?.message || "The district service did not return GeoJSON.");
        }
        return { source, payload };
      } catch (error) {
        if (error.name === "AbortError") throw error;
        console.warn(`Skipping ${source.county} district service:`, error);
        return null;
      }
    }));

    const features = responses.filter(Boolean).flatMap(({ source, payload }) => normalizeGeographyFeatures(
      (payload.features || []).filter((feature) => feature.properties?.[source.valueField]),
      {
        value: (p) => `${source.county}:${p[source.valueField]}`,
        label: (p) => `${source.county} — ${source.formatChoice?.(p) || `District ${p[source.valueField]}`}`,
        county: () => source.county,
        tag: (p) => source.formatChoice?.(p) || `District ${p[source.valueField]}`,
      },
    ));
    if (!features.length) throw new Error("No county district services returned usable boundaries.");
    return features.sort(compareCountyDistricts);
  }

  const assemblyConfig = {
    serviceUrl: "https://mdgeodata.md.gov/imap/rest/services/Boundaries/MD_ElectionBoundaries/FeatureServer/1",
    outFields: "DISTRICT",
    paginate: false,
    value: (p) => p.DISTRICT,
    label: (p, value) => `MD - ${value}`,
    expand: (value) => [normalizeAssemblyDistrictValue(value)],
    compare: (a, b) => compareAssemblyDistrictValues(a.properties.GEOGRAPHY_VALUE, b.properties.GEOGRAPHY_VALUE),
  };
  const congressionalConfig = {
    serviceUrl: "https://mdgeodata.md.gov/imap/rest/services/Boundaries/MD_ElectionBoundaries/FeatureServer/0",
    outFields: "DISTRICT",
    paginate: false,
    value: (p) => p.DISTRICT,
    label: (p, value) => `U.S. - ${value}`,
  };
  const countyConfig = {
    serviceUrl: COUNTY_BOUNDARY_SERVICE_URL,
    outFields: "COUNTY",
    paginate: false,
    value: (p) => p.COUNTY,
    label: (p, value) => value,
    county: (p) => countyKeyFromStateName(p.COUNTY),
  };
  const municipalityConfig = {
    serviceUrl: "https://mdgeodata.md.gov/imap/rest/services/Boundaries/MD_PoliticalBoundaries/FeatureServer/5",
    outFields: "MUN_NAME",
    paginate: false,
    value: (p) => p.MUN_NAME,
    label: (p, value) => titleCase(value),
  };

  const acknowledgementsHtml = `
    <li><a href="https://imap.maryland.gov/" target="_blank" rel="noopener">Maryland iMAP</a> and <a href="https://geodata.md.gov/" target="_blank" rel="noopener">Maryland Geographic Information Office</a> — parcel boundaries and assessments, general assembly districts, congressional districts, counties, municipalities, urban-area boundaries, and at-large county boundaries for Allegany, Caroline, Kent, Talbot, and Washington counties</li>
    <li><a href="https://gis.aacounty.org/arcgis/rest/services/OpenData/Political_OpenData/MapServer/4" target="_blank" rel="noopener">Anne Arundel</a> — County Council Districts</li>
    <li><a href="https://services1.arcgis.com/UWYHeuuJISiGmgXx/arcgis/rest/services/Baltimore_City_Council_District/FeatureServer/80" target="_blank" rel="noopener">Baltimore</a> — City Council Districts</li>
    <li><a href="https://bcgis.baltimorecountymd.gov/arcgis/rest/services/Apps/MyNeighborhood/MapServer/13" target="_blank" rel="noopener">Baltimore</a> — County Councilmanic Districts</li>
    <li><a href="https://services2.arcgis.com/svdkKIzwWblQ8cKK/arcgis/rest/services/Local_Election_Districts/FeatureServer/281" target="_blank" rel="noopener">Calvert</a> — County Local Election Districts</li>
    <li><a href="https://services.arcgis.com/Uf0DiYpD9NOFO5YH/ArcGIS/rest/services/CommissionerDistricts/FeatureServer/0" target="_blank" rel="noopener">Carroll</a> — County Election Commissioner Districts</li>
    <li><a href="https://cecilmaps.org/arcgis/rest/services/Hosted/Ceci_lCounty_Council_Districts_(effective_Feb_11_2022)/FeatureServer/0" target="_blank" rel="noopener">Cecil</a> — County Council Districts, effective Feb 11, 2022</li>
    <li><a href="https://services7.arcgis.com/3BMWkdyrt45RNCrq/arcgis/rest/services/CommDistricts_2022/FeatureServer/0" target="_blank" rel="noopener">Charles</a> — County Commissioner Districts 2022</li>
    <li><a href="https://services7.arcgis.com/yqhlYKSnzjiOzQig/ArcGIS/rest/services/Council_District_Draft4/FeatureServer/0" target="_blank" rel="noopener">Dorchester</a> — County Council Districts 2021 Final Draft</li>
    <li><a href="https://fcgis.frederickcountymd.gov/server_pub/rest/services/Elections/Elections/MapServer/8" target="_blank" rel="noopener">Frederick</a> — County Council Districts</li>
    <li><a href="https://services3.arcgis.com/Hj3vC5lmzqLyRabS/ArcGIS/rest/services/Board_of_Elections/FeatureServer/0" target="_blank" rel="noopener">Garrett</a> — County Election Districts</li>
    <li><a href="https://services.arcgis.com/q8r0H9SbF6PzNpYE/ArcGIS/rest/services/2025_Harford_County_Election_Files_gdb/FeatureServer/2" target="_blank" rel="noopener">Harford</a> — County Councilmanic Districts 2025</li>
    <li><a href="https://hcgeoserver.howardcountymd.gov:8443/geoserver/web/" target="_blank" rel="noopener">Howard</a> — County Council Districts via WFS</li>
    <li><a href="https://geohub.montgomerycountymd.gov/mapping1/rest/services/Boundaries/Council_Districts_slim/FeatureServer/0" target="_blank" rel="noopener">Montgomery</a> — County Council Districts</li>
    <li><a href="https://gis.pgatlas.com/pgatlas/rest/services/Administrative/MapServer/100" target="_blank" rel="noopener">Prince George’s</a> — County Councilmanic Districts 2022</li>
    <li><a href="https://gis.stmaryscountymd.gov/server/rest/services/Public/General1/MapServer/10" target="_blank" rel="noopener">St. Mary’s</a> — County Commissioner Districts</li>
    <li><a href="https://gisapps.wicomicocounty.org/server/rest/services/CouncilmanisAdoptedDec2_2025/MapServer/7" target="_blank" rel="noopener">Wicomico</a> — County Councilmanic Districts, adopted Dec 2, 2025</li>
    <li><a href="https://wcg-gisweb.co.worcester.md.us/arcgis/rest/services/Election_Districts_Map_MIL1/MapServer/14" target="_blank" rel="noopener">Worcester</a> — County Election Districts 2023</li>
    <li><a href="https://gis.qac.org/gisdata/Boundaries/CommissionerDistrictBoundaries.zip" target="_blank" rel="noopener">Queen Anne’s County GIS</a> — commissioner districts, downloaded August 31, 2026</li>
    <li><strong>Somerset County Planning and Zoning</strong> — commissioner district shapefile, shared August 31, 2026</li>`;

  const optional = (value) => (value === null || value === undefined || value === "" ? null : value);
  const percentOf = (part, total) => (Number(total) ? ` (${((Number(part) / Number(total)) * 100).toFixed(0)}%)` : "");

  let urbanPromise = null;

  window.ParcelStates.register({
    id: "MD",
    name: "Maryland",
    center: [39.2, -76.7],
    zoom: 8,
    brand: {
      eyebrow: "Maryland property insights",
      dataNote: "Parcels provided by Maryland iMAP",
      acknowledgementsHtml,
    },
    tax: {
      description: "Load Maryland parcels with a positive appraised full value and no exemption class. This tool is for predicting COUNTY LEVEL REAL PROPERTY TAX only, not municipal, state, income, or specialty taxes.",
      scopeLabel: "County real property tax",
      shortLabel: "County Property Tax",
    },
    parcels: {
      analysisUrl: POINTS_URL,
      analysisGeometry: "point",
      shapesUrl: SHAPES_URL,
      shapeWhere: "ACCTID IS NULL OR ACCTID NOT IN ('ROW', 'UNK', 'GCE')",
      shapeOutFields: "OBJECTID",
      exportMapUrl: SHAPES_URL.replace(/\/0$/, ""),
      exportLayerId: 0,
      outFields: "OBJECTID,ACCTID,ADDRESS,STRTNUM,STRTDIR,STRTNAM,STRTTYP,STRTSFX,STRTUNT,CITY,ZIPCODE,DESCLU,LU,ACRES,SQFTSTRC,YEARBLT,NFMTTLVL,NFMLNDVL,NFMIMPVL,ZONING,BLDG_UNITS,OOI,JURSCODE,TOWNCODE,DESCTOWN,DESCBLDG",
      taxableWhere: TAXABLE_WHERE,
      objectIdField: "OBJECTID",
      pageSize: 1000,
      pointPageSize: 2000,
    },
    fields: { land: "NFMLNDVL", improvement: "NFMIMPVL", improvementCount: "NFMIMPVL", total: "NFMTTLVL" },
    values: (p) => ({
      land: Number(p.NFMLNDVL),
      improvement: p.NFMIMPVL === null || p.NFMIMPVL === undefined ? null : Number(p.NFMIMPVL),
      total: Number(p.NFMTTLVL),
    }),
    jurisdictionGroupBy: "JURSCODE,TOWNCODE,DESCTOWN",
    taxJurisdictionDetails,
    sfh: {
      where: SFH_WHERE,
      matches: isSingleFamilyParcel,
      definition: "residential with a structure and a detached building type (standard, split level or split foyer); townhouses, condos and mobile homes are not SFH",
    },
    propertyTypes: PROPERTY_TYPES,
    occupancy: {
      field: "OOI",
      ownerOccupiedKey: "H",
      groups: [
        { key: "H", label: "Owner-occupied (code H)" },
        { key: "N", label: "Not owner-occupied (code N)" },
        { key: "D", label: "Other occupancy code (D)" },
        { key: "", label: "Not reported" },
      ],
      definition: "SDAT owner-occupancy code. H = owner-occupied principal residence; N = not owner-occupied; D is reported separately because its meaning is not documented here; Not reported = blank.",
    },
    geographies: {
      assembly: {
        label: "Maryland General Assembly districts",
        choiceLabel: "District",
        load: (signal) => loadArcgisGeography(assemblyConfig, signal),
      },
      congressional: {
        label: "U.S. congressional districts",
        choiceLabel: "District",
        load: (signal) => loadArcgisGeography(congressionalConfig, signal),
      },
      county: {
        label: "Counties",
        choiceLabel: "County",
        load: (signal) => loadArcgisGeography(countyConfig, signal),
        attributeFilter: (feature) => {
          const countyKey = countyKeyFromStateName(feature.properties.raw?.COUNTY);
          const code = Object.keys(COUNTY_BY_JURISDICTION).find((key) => COUNTY_BY_JURISDICTION[key] === countyKey);
          return code ? `JURSCODE = '${code}'` : null;
        },
      },
      municipality: {
        label: "Municipalities",
        choiceLabel: "Municipality",
        load: (signal) => loadArcgisGeography(municipalityConfig, signal),
        attributeFilter: (feature) => {
          const name = String(feature.properties.raw?.MUN_NAME || "").trim().toUpperCase();
          if (!name) return null;
          if (name === "BALTIMORE CITY") return "JURSCODE = 'BACI'";
          // DESCTOWN is "<JURSCODE> <Town>", e.g. "CARO Denton".
          const townName = (PARCEL_TOWN_NAMES[name] || name).replace(/'/g, "''");
          return `TOWNCODE IS NOT NULL AND UPPER(DESCTOWN) LIKE '____ ${townName}'`;
        },
      },
      countyCouncil: {
        label: "County council / commissioner districts",
        choiceLabel: "county district",
        wideMenu: true,
        load: loadCountyCouncilChoices,
      },
    },
    geographyOrder: ["assembly", "congressional", "county", "municipality", "countyCouncil"],
    defaultGeography: "assembly",
    exportDistricts: [
      { type: "assembly", header: "LEGISLATIVE_DISTRICT", description: "Maryland General Assembly district containing the account point." },
      { type: "congressional", header: "CONGRESSIONAL_DISTRICT", description: "U.S. congressional district containing the account point." },
      { type: "countyCouncil", header: "COUNTY_COUNCIL_DISTRICT", perCounty: true, description: "County council or commissioner district containing the account point." },
    ],
    urban: {
      definition: "urban area (cluster with population greater than 2,000)",
      load: (signal) => {
        if (!urbanPromise) {
          const params = new URLSearchParams({ where: "1=1", outFields: "*", returnGeometry: "true", outSR: "4326", f: "geojson" });
          urbanPromise = fetchJson(`https://mdgeodata.md.gov/imap/rest/services/Boundaries/MD_CensusStatisticalBoundaries/FeatureServer/4/query?${params}`, {}, signal)
            .then((payload) => {
              if (payload.type !== "FeatureCollection") throw new Error("Urban-area service returned an invalid response.");
              return payload.features || [];
            })
            .catch((error) => {
              urbanPromise = null;
              throw error;
            });
        }
        return urbanPromise;
      },
    },
    popup: {
      title: (p) => optional(p.ADDRESS)
        || [p.STRTNUM, p.STRTDIR, p.STRTNAM, p.STRTTYP, p.STRTSFX, p.STRTUNT].filter(Boolean).join(" ")
        || "Selected parcel",
      sortKey: (p) => [p.ADDRESS, p.STRTUNT],
      rows: (p, { formatCurrency }) => [
        ["Account", optional(p.ACCTID)],
        ["City / ZIP", [p.CITY, p.ZIPCODE].filter(Boolean).join(" ") || null],
        ["Land use", optional(p.DESCLU)],
        ["Land assessment", `${formatCurrency(p.NFMLNDVL)}${percentOf(p.NFMLNDVL, p.NFMTTLVL)}`],
        ["Improvement assessment", `${formatCurrency(p.NFMIMPVL)}${percentOf(p.NFMIMPVL, p.NFMTTLVL)}`],
        ["Total assessment", `${formatCurrency(p.NFMTTLVL)}${Number(p.NFMTTLVL) ? " (100%)" : ""}`],
        ["Zone", optional(p.ZONING)],
      ],
    },
    csv: {
      headers: [
        "ACCTID", "ADDRESS", "STRTNUM", "STRTDIR", "STRTNAM", "STRTTYP", "STRTSFX", "STRTUNT",
        "CITY", "ZIPCODE", "DESCLU", "LU", "DESCBLDG", "ACRES", "SQFTSTRC", "YEARBLT",
        "NFMLNDVL", "NFMIMPVL", "NFMTTLVL", "ZONING", "BLDG_UNITS", "OOI", "JURSCODE", "TOWNCODE", "DESCTOWN",
      ],
      row: (p) => [
        p.ACCTID, p.ADDRESS, p.STRTNUM, p.STRTDIR, p.STRTNAM, p.STRTTYP, p.STRTSFX, p.STRTUNT,
        p.CITY, p.ZIPCODE, p.DESCLU, p.LU, p.DESCBLDG, p.ACRES, p.SQFTSTRC, p.YEARBLT,
        Number(p.NFMLNDVL), p.NFMIMPVL === null || p.NFMIMPVL === undefined ? 0 : Number(p.NFMIMPVL), Number(p.NFMTTLVL),
        p.ZONING, p.BLDG_UNITS, p.OOI, p.JURSCODE, p.TOWNCODE, p.DESCTOWN,
      ],
    },
    report: {
      title: "PARCEL ANALYSIS - MARYLAND - SPLIT-RATE PROPERTY TAX SUMMARY",
      accountNoun: "accounts",
      unitDescription: "Each account is one point in the Maryland iMAP parcel points layer (condominium units are separate accounts).",
      caveats: [
        "Covers county real property tax only. State, municipal, and special district taxes are not included.",
        "Includes taxable accounts only: assessed value above $0 and no exemption class.",
        "Bills are assessed value x rate. Homestead Tax Credit caps, Homeowners' Tax Credits, assessment phase-ins, and other credits are not modeled, so actual bills (especially for long-held owner-occupied homes) can be lower, and the change for those owners can differ.",
        "County and municipal rates are the rates configured in this tool. Check them against current published rates before citing results.",
      ],
      rateDefinition: "Rates are percent of assessed value ($ per $100). Current rate is the county rate, or the rate applied inside a municipality where it differs.",
      sfhNotes: `Qualifying SFH parcel count: accounts with LU = R, SQFTSTRC > 0, and DESCBLDG one of ${SFH_BUILDING_TYPES.join(", ")}. Row/townhouses, condos, and mobile homes are excluded.`,
      sourceLines: [`Maryland iMAP parcel points (one per tax account): ${POINTS_URL}`],
      csvColumnNotes: [
        "ACCTID: tax account identifier.",
        "ADDRESS, street fields, CITY, ZIPCODE: address attributes from Maryland iMAP.",
        "DESCLU, LU, DESCBLDG, ACRES, SQFTSTRC, YEARBLT, ZONING, BLDG_UNITS, OOI: selected parcel characteristics.",
        "NFMLNDVL: land assessment; NFMIMPVL: improvement assessment (blank values are exported as 0); NFMTTLVL: total assessment.",
        "JURSCODE, TOWNCODE, DESCTOWN: source jurisdiction attributes.",
      ],
    },
  });
})();

#!/usr/bin/env node
"use strict";

// Audits downloaded Indiana Gateway Real Property ZIPs without emitting owner/address data.
// The field offsets are 1-based positions from Indiana 50 IAC 26, Parcel file layout.
const fs = require("node:fs");
const path = require("node:path");
const { createInflateRaw } = require("node:zlib");
const { Readable } = require("node:stream");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "assets", "indiana");
const GEOMETRY_QUERY = "https://gisdata.in.gov/server/rest/services/Hosted/Parcel_Boundaries_of_Indiana_Current/FeatureServer/0/query";
const SAMPLE_PER_COUNTY = 100;
const MAX_SAMPLE_KEYS = 1000;

function findTextEntry(zip) {
  const min = Math.max(0, zip.length - 65557);
  let eocd = -1;
  for (let offset = zip.length - 22; offset >= min; offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP end-of-central-directory record not found");

  const entries = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  for (let index = 0; index < entries; index += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid ZIP central-directory entry");
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;
    if (!name.toLowerCase().endsWith(".txt")) continue;

    if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Invalid ZIP local-file header");
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = zip.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) return Readable.from([compressed]);
    if (method === 8) return Readable.from([compressed]).pipe(createInflateRaw());
    throw new Error(`Unsupported ZIP compression method ${method}`);
  }
  throw new Error("ZIP contains no .txt member");
}

function parseInteger(slice) {
  const value = slice.trim();
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function inspectArchive(filePath) {
  const zip = fs.readFileSync(filePath);
  const input = findTextEntry(zip);
  const decoder = new TextDecoder("windows-1252");
  const state = {
    rowCount: 0,
    badWidth: 0,
    missingKey: 0,
    duplicateKey: 0,
    invalidValues: 0,
    negativeComponents: 0,
    totalMismatch: 0,
    positiveCount: 0,
    landSum: 0,
    improvementSum: 0,
    totalSum: 0,
    classes: new Map(),
    keys: [],
    seen: new Set(),
    randomState: 0x6d2b79f5,
  };
  let pending = "";
  let isHeader = true;
  const consumeLine = (line) => {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (isHeader) {
      isHeader = false;
      state.header = line.slice(0, 100);
      return;
    }
    if (!line || line.startsWith("TRAILER")) return;
    state.rowCount += 1;
    if (line.length !== 1286) state.badWidth += 1;

    const key = line.slice(0, 25).trim();
    if (!key) state.missingKey += 1;
    else {
      if (state.seen.has(key)) state.duplicateKey += 1;
      else {
        state.seen.add(key);
        // Deterministic reservoir sampling: test keys from throughout the county file.
        state.randomState = (Math.imul(state.randomState, 1664525) + 1013904223) >>> 0;
        if (state.keys.length < SAMPLE_PER_COUNTY) state.keys.push(key);
        else {
          const sampleIndex = Math.floor((state.randomState / 0x100000000) * state.seen.size);
          if (sampleIndex < SAMPLE_PER_COUNTY) state.keys[sampleIndex] = key;
        }
      }
    }

    const classCode = line.slice(193, 196).trim();
    if (classCode) state.classes.set(classCode, (state.classes.get(classCode) || 0) + 1);
    const land = parseInteger(line.slice(468, 480));
    const improvement = parseInteger(line.slice(480, 492));
    const total = parseInteger(line.slice(1274, 1286));
    if (land === null || improvement === null || total === null) {
      state.invalidValues += 1;
      return;
    }
    if (land < 0 || improvement < 0) state.negativeComponents += 1;
    if (land + improvement !== total) state.totalMismatch += 1;
    if (total > 0) state.positiveCount += 1;
    state.landSum += land;
    state.improvementSum += improvement;
    state.totalSum += total;
  };

  for await (const chunk of input) {
    pending += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      consumeLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
  }
  pending += decoder.decode();
  if (pending) consumeLine(pending);

  return {
    name: path.basename(filePath),
    size: fs.statSync(filePath).size,
    ...state,
    seen: undefined,
    classes: [...state.classes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
  };
}

async function checkGeometryMatches(keys) {
  const found = new Set();
  for (let start = 0; start < keys.length; start += MAX_SAMPLE_KEYS) {
    const batch = keys.slice(start, start + MAX_SAMPLE_KEYS);
    const where = `state_parcel_id IN (${batch.map((key) => `'${key.replaceAll("'", "''")}'`).join(",")})`;
    const response = await fetch(GEOMETRY_QUERY, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ where, outFields: "state_parcel_id", returnGeometry: "false", f: "json" }),
      signal: AbortSignal.timeout(120000),
    });
    const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(payload.error?.message || `Geometry service returned HTTP ${response.status}`);
    (payload.features || []).forEach(({ attributes }) => found.add(attributes.state_parcel_id));
  }
  return found.size;
}

(async () => {
  const files = fs.readdirSync(DATA_DIR).filter((name) => name.toLowerCase().endsWith(".zip")).sort();
  const results = [];
  for (const name of files) {
    const result = await inspectArchive(path.join(DATA_DIR, name));
    const matched = await checkGeometryMatches(result.keys);
    result.sampleMatch = `${matched}/${result.keys.length}`;
    delete result.keys;
    results.push(result);
    console.log([
      result.name,
      `records=${result.rowCount}`,
      `widthErrors=${result.badWidth}`,
      `missingKeys=${result.missingKey}`,
      `duplicateKeys=${result.duplicateKey}`,
      `positiveTotal=${result.positiveCount}`,
      `totalMismatches=${result.totalMismatch}`,
      `keySampleMatch=${result.sampleMatch}`,
      `classes=${JSON.stringify(result.classes)}`,
    ].join(" | "));
  }
  const totals = results.reduce((sum, item) => {
    for (const field of ["rowCount", "badWidth", "missingKey", "duplicateKey", "invalidValues", "negativeComponents", "totalMismatch", "positiveCount", "landSum", "improvementSum", "totalSum", "size"]) {
      sum[field] += item[field];
    }
    const [matched, sampled] = item.sampleMatch.split("/").map(Number);
    sum.sampleMatched += matched || 0;
    sum.sampled += sampled || 0;
    return sum;
  }, { rowCount: 0, badWidth: 0, missingKey: 0, duplicateKey: 0, invalidValues: 0, negativeComponents: 0, totalMismatch: 0, positiveCount: 0, landSum: 0, improvementSum: 0, totalSum: 0, size: 0, sampleMatched: 0, sampled: 0 });
  console.log("STATEWIDE", JSON.stringify({ counties: results.length, ...totals, sampleJoinRate: totals.sampled ? totals.sampleMatched / totals.sampled : null, componentDifference: totals.landSum + totals.improvementSum - totals.totalSum }));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

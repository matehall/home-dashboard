const fs = require('fs');
const path = require('path');
const db = require('../server/db');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i];
    if (!part.startsWith('--')) continue;
    const key = part.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return value;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) {
    const asNumber = Number(text);
    return asNumber < 1e12 ? asNumber * 1000 : asNumber;
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseValue(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(String(value).replace(',', '.'));
  return Number.isNaN(num) ? null : num;
}

function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];

    if (ch === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (ch === ',' && !inQuotes) {
      cells.push(current);
      current = '';
      continue;
    }

    current += ch;
  }

  cells.push(current);
  return cells.map((cell) => cell.trim());
}

function parseCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];

  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index];
    });
    return row;
  });
}

function loadRows(filePath, format) {
  if (format === 'json') {
    const data = loadJson(filePath);
    if (!Array.isArray(data)) throw new Error('JSON input must be an array of rows');
    return data;
  }
  return parseCsv(filePath);
}

function normalizeMapping(rawMap) {
  if (Array.isArray(rawMap)) return rawMap;
  if (rawMap && typeof rawMap === 'object') {
    return Object.entries(rawMap).map(([source, cfg]) => ({
      source,
      ...(cfg || {}),
    }));
  }
  throw new Error('Mapping must be an array or object');
}

function findMapping(row, mappings, sourceColumn, topicColumn) {
  const sourceValue = row[sourceColumn];
  const topicValue = topicColumn ? row[topicColumn] : undefined;
  return mappings.find((entry) => {
    if (entry.source && sourceValue !== undefined && String(entry.source) === String(sourceValue)) return true;
    if (entry.item && sourceValue !== undefined && String(entry.item) === String(sourceValue)) return true;
    if (entry.topic && topicValue !== undefined && String(entry.topic) === String(topicValue)) return true;
    return false;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.input || args.i;
  if (!input) {
    throw new Error('Missing --input <file>');
  }

  const format = (args.format || 'csv').toLowerCase();
  const sourceColumn = args['source-column'] || 'source';
  const topicColumn = args['topic-column'] || 'topic';
  const valueColumn = args['value-column'] || 'value';
  const unitColumn = args['unit-column'] || 'unit';
  const timestampColumn = args['timestamp-column'] || 'timestamp';
  const defaultTopic = args['default-topic'] || 'openhab/import';
  const dryRun = Boolean(args['dry-run']);

  const mapPath = args.map || path.join(__dirname, 'openhab-sensor-map.example.json');
  const mappings = normalizeMapping(loadJson(mapPath));
  const rows = loadRows(input, format);

  let imported = 0;
  let skipped = 0;

  for (const row of rows) {
    const mapping = findMapping(row, mappings, sourceColumn, topicColumn);
    const ts = parseTimestamp(row[timestampColumn] ?? row.ts ?? row.time ?? row.date);
    const value = parseValue(row[valueColumn] ?? row.state ?? row.val);

    if (!mapping || ts === null || value === null) {
      skipped += 1;
      continue;
    }

    const sensor = mapping.sensor;
    const topic = mapping.topic || row[topicColumn] || defaultTopic;
    const unit = row[unitColumn] || mapping.unit || '';

    if (!dryRun) {
      // Keep the original timestamp from openHAB.
      await db.insertReading(sensor, topic, value, unit, ts);
    }

    imported += 1;
  }

  console.log(`Imported ${imported} rows${dryRun ? ' (dry-run)' : ''}. Skipped ${skipped}.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});

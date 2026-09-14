const express = require('express');
const path = require('path');

require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname)));

function parseDistanceMiles(text) {
  if (!text) return null;

  const patterns = [
    /(\d+(?:\.\d+)?)\s?(?:mi|miles)\b/i,
    /(\d+(?:\.\d+)?)\s?km\b/i,
    /distance[^\d]*(\d+(?:\.\d+)?)\s?(?:mi|miles)\b/i,
    /distance[^\d]*(\d+(?:\.\d+)?)\s?km\b/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;

    const value = Number(match[1]);
    if (Number.isNaN(value)) continue;

    if (/km/i.test(match[0])) {
      return value * 0.621371;
    }

    return value;
  }

  return null;
}

function extractStravaRouteId(routeUrl) {
  if (!routeUrl) return null;
  const match = routeUrl.match(/strava\.com\/routes\/(\d+)/i);
  return match ? match[1] : null;
}

const DEFAULT_CALENDAR_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRaM1ucFSxEH7Q0Xe-WlZjhU30N_7I4TRHBY8rj77A3Jkb4RNnXNP5crg9LCa3H-SoT8edQRrp_gvXt/pub?output=csv';

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      const next = text[i + 1];

      if (char === '"' && inQuotes && next === '"') {
        cell += '"';
        i += 1;
        continue;
      }

      if (char === '"') {
        inQuotes = !inQuotes;
        continue;
      }

      if (char === ',' && !inQuotes) {
        row.push(cell);
        cell = '';
        continue;
      }

      if ((char === '\n' || char === '\r') && !inQuotes) {
        if (char === '\r' && next === '\n') {
          i += 1;
        }
        row.push(cell);
        if (row.some((value) => String(value).trim() !== '')) {
          rows.push(row);
        }
        row = [];
        cell = '';
        continue;
      }

      cell += char;
    }

    row.push(cell);
    if (row.some((value) => String(value).trim() !== '')) {
      rows.push(row);
    }

    return rows;
  }

  function cleanCell(value) {
    return String(value ?? '').trim();
  }

  function normalizeDateOnly(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  }

  function parseFlexibleDate(value) {
    const text = cleanCell(value);
    if (!text) return null;

    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }

    const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) {
      return new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
    }

    const slashMatch = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (slashMatch) {
      const year = Number(slashMatch[3].length === 2 ? `20${slashMatch[3]}` : slashMatch[3]);
      return new Date(year, Number(slashMatch[1]) - 1, Number(slashMatch[2]));
    }

    return null;
  }

  function extractGoogleSheetId(sheetUrl) {
    const match = String(sheetUrl || '').match(/\/d\/([a-zA-Z0-9-_]+)/);
    return match ? match[1] : null;
  }

  function extractGoogleSheetGid(sheetUrl) {
    const match = String(sheetUrl || '').match(/[?&#]gid=(\d+)/);
    return match ? match[1] : '0';
  }

  function buildSheetCsvUrls(sheetUrl) {
    if (/format=csv/i.test(sheetUrl)) {
      return [sheetUrl];
    }

    if (/\/pub\?output=csv/i.test(sheetUrl)) {
      return [sheetUrl];
    }

    const sheetId = extractGoogleSheetId(sheetUrl);
    if (!sheetId) return [sheetUrl];

    const gid = extractGoogleSheetGid(sheetUrl);
    return [
      `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`,
      `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&gid=${gid}`
    ];
  }

  async function fetchText(url) {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'ride-announcement-generator/1.0'
      }
    });

    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }

    return response.text();
  }

  async function fetchSheetRows(sheetUrl) {
    const candidates = buildSheetCsvUrls(sheetUrl);

    for (const candidate of candidates) {
      try {
        const csvText = await fetchText(candidate);
        const rows = parseCsv(csvText);
        if (rows.length > 1) {
          return rows;
        }
      } catch (error) {
      }
    }

    return null;
  }

  function findHeaderIndex(headers, aliases) {
    const normalizedHeaders = headers.map((header) => cleanCell(header).toLowerCase());
    return normalizedHeaders.findIndex((header) => aliases.some((alias) => header.includes(alias)));
  }

  function getCellByAliases(headers, row, aliases) {
    const index = findHeaderIndex(headers, aliases);
    return index >= 0 ? cleanCell(row[index]) : '';
  }

  function getCurrentTomorrowDate() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    return tomorrow;
  }

  function rowText(row) {
    return row.map(cleanCell).join(' ').toLowerCase();
  }

  function getWeekdayName(date) {
    return date.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();
  }

  function getColumnIndexByWeekday(headers, weekdayName) {
    const normalized = headers.map((header) => cleanCell(header).toUpperCase());
    return normalized.findIndex((header) => header === weekdayName || header.includes(weekdayName));
  }

  function parseRideCell(cell) {
    const text = cleanCell(cell);
    if (!text) return { paces: '', leaders: '' };

    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length < 2) {
      return { paces: '', leaders: '' };
    }

    const detailLine = lines[1] || '';
    const detailParts = detailLine.split('/').map((part) => part.trim()).filter(Boolean);
    const pacePart = detailParts[2] || '';

    let pace = pacePart;
    let leaders = lines[2] || '';

    if (pace) {
      pace = pace.replace(/\s+/g, ' ').trim();
    }

    if (!leaders && lines.length > 2) {
      leaders = lines.slice(2).join(' ');
    }

    leaders = leaders.replace(/^[-•]+\s*/, '').trim();

    return {
      paces: normalizeMultiValue(pace),
      leaders: normalizeMultiValue(leaders)
    };
  }

  function isCalendarGrid(rows) {
    if (!rows || rows.length < 2) return false;
    const headerRow = rows[1] || [];
    return headerRow.some((cell) => /MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY/i.test(cleanCell(cell)));
  }

  function isRoadRideRow(headers, row) {
    const typeValue = getCellByAliases(headers, row, ['ride type', 'type', 'category', 'discipline']);
    const rideName = getCellByAliases(headers, row, ['ride name', 'ride', 'name', 'title']);
    const text = `${typeValue} ${rideName} ${rowText(row)}`.toLowerCase();
    return /\broad\b/.test(text);
  }

  function isRoadLabelRow(row) {
    return cleanCell(row[0]).toLowerCase() === 'road';
  }

  function isTomorrowRow(headers, row, tomorrow) {
    const dateValue = getCellByAliases(headers, row, ['date', 'day', 'when', 'ride date', 'event date']);
    const parsed = parseFlexibleDate(dateValue);
    if (parsed && normalizeDateOnly(parsed) === normalizeDateOnly(tomorrow)) {
      return true;
    }

    const text = rowText(row);
    const isoTomorrow = tomorrow.toISOString().slice(0, 10);
    const monthDayTomorrow = tomorrow.toLocaleDateString([], { month: 'numeric', day: 'numeric' }).replace(/\//g, '/');
    return text.includes(isoTomorrow) || text.includes(monthDayTomorrow) || text.includes(tomorrow.toLocaleDateString([], { weekday: 'long' }).toLowerCase());
  }

  function normalizeMultiValue(text) {
    return cleanCell(text)
      .split(/\r?\n|;/)
      .flatMap((part) => part.split(','))
      .map((part) => part.trim())
      .filter(Boolean)
      .join(', ');
  }

  function rowToCalendarDefaults(headers, row) {
    return {
      rideName: getCellByAliases(headers, row, ['ride name', 'ride', 'name', 'title']),
      paces: normalizeMultiValue(getCellByAliases(headers, row, ['paces', 'pace'])),
      leaders: normalizeMultiValue(getCellByAliases(headers, row, ['ride leaders', 'leaders', 'leader'])),
      location: cleanCell(getCellByAliases(headers, row, ['location', 'where', 'start location', 'start'])),
      routes: normalizeMultiValue(getCellByAliases(headers, row, ['routes', 'route', 'strava', 'route url', 'strava route'])),
      dateTime: cleanCell(getCellByAliases(headers, row, ['date time', 'datetime', 'date/time', 'when', 'ride time']))
    };
  }

  function applyFallbackCalendarDefaults() {
    const tomorrow = getCurrentTomorrowDate();
    tomorrow.setHours(18, 0, 0, 0);
    const pad = (value) => String(value).padStart(2, '0');
    return {
      rideName: 'Road Ride',
      paces: 'A',
      leaders: '',
      location: 'Purdue West Shopping Plaza',
      routes: '',
      dateTime: `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}T18:00`,
      source: 'fallback'
    };
  }

  app.get('/api/calendar/defaults', async (req, res) => {
    const sheetUrl = DEFAULT_CALENDAR_URL;

    try {
      const rows = await fetchSheetRows(sheetUrl);
      if (!rows || rows.length < 2) {
        return res.json(applyFallbackCalendarDefaults());
      }

      if (isCalendarGrid(rows)) {
        const headerRow = rows[1];
        const dataRows = rows.slice(2);
        const tomorrow = getCurrentTomorrowDate();
        const weekdayName = getWeekdayName(tomorrow);
        const colIndex = getColumnIndexByWeekday(headerRow, weekdayName);

        const roadRow = dataRows.find(isRoadLabelRow);
        if (roadRow && colIndex >= 0 && roadRow[colIndex]) {
          const parsed = parseRideCell(roadRow[colIndex]);
          const defaults = applyFallbackCalendarDefaults();
          return res.json({
            ...defaults,
            paces: parsed.paces || defaults.paces,
            leaders: parsed.leaders || defaults.leaders,
            source: 'sheet-grid',
            weekday: weekdayName
          });
        }

        return res.json(applyFallbackCalendarDefaults());
      }

      const headers = rows[0];
      const dataRows = rows.slice(1);
      const tomorrow = getCurrentTomorrowDate();

      const matchedRow = dataRows.find((row) => isTomorrowRow(headers, row, tomorrow) && isRoadRideRow(headers, row))
        || dataRows.find((row) => isRoadRideRow(headers, row))
        || dataRows.find((row) => isTomorrowRow(headers, row, tomorrow));

      if (!matchedRow) {
        return res.json(applyFallbackCalendarDefaults());
      }

      const defaults = rowToCalendarDefaults(headers, matchedRow);

      return res.json({
        ...applyFallbackCalendarDefaults(),
        ...defaults,
        source: 'sheet'
      });
    } catch (error) {
      return res.json(applyFallbackCalendarDefaults());
    }
  });

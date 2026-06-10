const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const db = new sqlite3.Database(path.join(DATA_DIR, 'dashboard.db'));

db.serialize(() => {
  db.run('PRAGMA journal_mode = WAL');
  db.run(`
    CREATE TABLE IF NOT EXISTS readings (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      sensor  TEXT    NOT NULL,
      topic   TEXT    NOT NULL,
      value   REAL    NOT NULL,
      unit    TEXT    NOT NULL DEFAULT '',
      ts      INTEGER NOT NULL
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_sensor_ts ON readings (sensor, ts)');
});

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

module.exports = {
  insertReading(sensor, topic, value, unit) {
    return run('INSERT INTO readings (sensor, topic, value, unit, ts) VALUES (?, ?, ?, ?, ?)', [sensor, topic, value, unit, Date.now()]);
  },

  getLatest() {
    return all(`
      SELECT r.sensor, r.topic, r.value, r.unit, r.ts
      FROM readings r
      INNER JOIN (
        SELECT sensor, MAX(ts) AS max_ts FROM readings GROUP BY sensor
      ) m ON r.sensor = m.sensor AND r.ts = m.max_ts
      ORDER BY r.sensor
    `);
  },

  getSensors() {
    return all('SELECT DISTINCT sensor, unit FROM readings ORDER BY sensor');
  },

  getHistory(sensor, from, to, resolution, aggregation = 'avg') {
    const agg = aggregation === 'sum' ? 'SUM(value)' : 'AVG(value)';

    // For raw, return all individual measurements
    if (resolution === 'raw') {
      return all(`
        SELECT ts, value, NULL AS aggregated FROM readings
        WHERE sensor = ? AND ts BETWEEN ? AND ?
        ORDER BY ts
      `, [sensor, from, to]);
    }

    // Build aggregated data + overlay raw data in same response
    let groupSql = 'ts / 3600000';
    if (resolution === 'day') groupSql = 'ts / 86400000';
    if (resolution === 'week') groupSql = 'ts / 604800000';
    if (resolution === 'month') groupSql = 'ts / 2592000000';
    if (resolution === 'year') groupSql = 'ts / 31536000000';

    return all(`
      SELECT ts, value, aggregated FROM (
        -- Raw data
        SELECT ts, value, 0 AS aggregated FROM readings
        WHERE sensor = ? AND ts BETWEEN ? AND ?
        
        UNION ALL
        
        -- Aggregated data
        SELECT
          (${groupSql}) * (CASE ${groupSql} WHEN ts / 3600000 THEN 3600000 WHEN ts / 86400000 THEN 86400000 WHEN ts / 604800000 THEN 604800000 WHEN ts / 2592000000 THEN 2592000000 WHEN ts / 31536000000 THEN 31536000000 END) AS ts,
          ${agg} AS value,
          1 AS aggregated
        FROM readings
        WHERE sensor = ? AND ts BETWEEN ? AND ?
        GROUP BY ${groupSql}
      )
      ORDER BY ts
    `, [sensor, from, to, sensor, from, to]);
  },

  pruneOlderThan(days) {
    const cutoff = Date.now() - days * 86400000;
    return run('DELETE FROM readings WHERE ts < ?', [cutoff]);
  }
};

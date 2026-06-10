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

  getHistory(sensor, from, to, resolution) {
    if (resolution === 'hour') {
      return all(`
        SELECT
          (ts / 3600000) * 3600000 AS ts,
          AVG(value)  AS value,
          MIN(value)  AS min,
          MAX(value)  AS max
        FROM readings
        WHERE sensor = ? AND ts BETWEEN ? AND ?
        GROUP BY ts / 3600000
        ORDER BY ts
      `, [sensor, from, to]);
    }

    if (resolution === 'day') {
      return all(`
        SELECT
          (ts / 86400000) * 86400000 AS ts,
          AVG(value)  AS value,
          MIN(value)  AS min,
          MAX(value)  AS max
        FROM readings
        WHERE sensor = ? AND ts BETWEEN ? AND ?
        GROUP BY ts / 86400000
        ORDER BY ts
      `, [sensor, from, to]);
    }

    return all(`
      SELECT ts, value FROM readings
      WHERE sensor = ? AND ts BETWEEN ? AND ?
      ORDER BY ts
    `, [sensor, from, to]);
  },

  pruneOlderThan(days) {
    const cutoff = Date.now() - days * 86400000;
    return run('DELETE FROM readings WHERE ts < ?', [cutoff]);
  }
};

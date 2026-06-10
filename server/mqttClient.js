const mqtt = require('mqtt');
const db = require('./db');

const SENSOR_MAP = [
  { topic: 'weatherstation/temp', field: 'temperature',        sensor: 'utetemperatur', unit: '°C'  },
  { topic: 'weatherstation/wind', field: 'speed_avg_adjusted', sensor: 'vind_avg',      unit: 'm/s' },
  { topic: 'weatherstation/wind', field: 'speed_gust_adjusted', sensor: 'vind_gust',     unit: 'm/s' },
  { topic: 'weatherstation/rain', field: 'rain',               sensor: 'regn',          unit: 'mm'  },
  { topic: 'panna/temp',          field: 'sensor1',            sensor: 'framledning',   unit: '°C'  },
  { topic: 'panna/temp',          field: 'smoke',              sensor: 'rok_temp',      unit: '°C'  },
  { topic: 'panna/temp',          field: 'sensor2',            sensor: 'panntemp',      unit: '°C'  },
  { topic: 'panna/temp',          field: 'sensor3',            sensor: 'returledning',  unit: '°C'  },
];

const TOPIC_SENSORS = SENSOR_MAP.reduce((acc, def) => {
  if (!acc[def.topic]) acc[def.topic] = [];
  acc[def.topic].push(def);
  return acc;
}, {});

const MQTT_HOST = process.env.MQTT_HOST || '192.168.1.8';
const MQTT_PORT = Number(process.env.MQTT_PORT) || 1883;
const MQTT_USER = process.env.MQTT_USER || 'openhabian';
const MQTT_PASS = process.env.MQTT_PASS || 'openhabian';

function startMqttClient(io) {
  const client = mqtt.connect(`mqtt://${MQTT_HOST}:${MQTT_PORT}`, {
    username: MQTT_USER,
    password: MQTT_PASS,
    clientId: `home-dashboard-${Math.random().toString(16).slice(2, 8)}`,
    reconnectPeriod: 5000,
  });

  client.on('connect', () => {
    console.log(`[mqtt] connected to ${MQTT_HOST}:${MQTT_PORT}`);
    client.subscribe([...new Set(SENSOR_MAP.map((s) => s.topic))], (err) => {
      if (err) console.error('[mqtt] subscribe error:', err);
    });
  });

  client.on('message', async (topic, payload) => {
    let json;
    try {
      json = JSON.parse(payload.toString());
    } catch {
      console.warn(`[mqtt] non-JSON payload on ${topic}`);
      return;
    }

    const defs = TOPIC_SENSORS[topic];
    if (!defs) return;

    for (const def of defs) {
      const value = json[def.field];
      const num = Number(value);
      if (value === undefined || value === null || Number.isNaN(num)) continue;

      try {
        await db.insertReading(def.sensor, topic, num, def.unit);
        io.emit('update', { sensor: def.sensor, value: num, unit: def.unit, ts: Date.now() });
      } catch (err) {
        console.error('[mqtt] failed to persist reading:', err.message);
      }
    }
  });

  client.on('reconnect', () => console.log('[mqtt] reconnecting…'));
  client.on('error', (err) => console.error('[mqtt] error:', err.message));
  client.on('offline', () => console.warn('[mqtt] offline'));
}

module.exports = { startMqttClient, SENSOR_MAP };

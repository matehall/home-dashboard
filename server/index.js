require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { startMqttClient } = require('./mqttClient');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const DIST_DIR = path.join(__dirname, '..', 'client', 'dist');
const HAS_DIST = fs.existsSync(DIST_DIR);

if (HAS_DIST) {
  app.use(express.static(DIST_DIR));
}

app.get('/api/sensors', async (_req, res, next) => {
  try { res.json(await db.getSensors()); } catch (err) { next(err); }
});

app.get('/api/latest', async (_req, res, next) => {
  try { res.json(await db.getLatest()); } catch (err) { next(err); }
});

app.get('/api/history', async (req, res, next) => {
  try {
    const { sensor, from, to, resolution = 'raw', aggregation = 'avg' } = req.query;
    if (!sensor) return res.status(400).json({ error: 'sensor is required' });

    const fromTs = from ? Number(from) : Date.now() - 24 * 60 * 60 * 1000;
    const toTs = to ? Number(to) : Date.now();
    res.json(await db.getHistory(sensor, fromTs, toTs, resolution, aggregation));
  } catch (err) { next(err); }
});

if (HAS_DIST) {
  app.get('*', (_req, res) => {
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
}

io.on('connection', async (socket) => {
  console.log(`[ws] client connected: ${socket.id}`);
  try {
    socket.emit('init', await db.getLatest());
  } catch (err) {
    console.error('[ws] failed to send initial data', err);
  }
  socket.on('disconnect', () => console.log(`[ws] client disconnected: ${socket.id}`));
});

startMqttClient(io);

server.listen(PORT, () => {
  console.log(`[server] Home Dashboard running on http://localhost:${PORT}`);
});

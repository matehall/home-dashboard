# Home Dashboard

Ett litet, självhostat dashboard för hemmets sensorer. Det visar aktuella värden live och låter mig bläddra i historik över temperatur, vind, regn och pannans temperaturer.

## Syfte

Sensordata från väderstationen och pannan skickas redan via MQTT (hanterat av openHAB på en Raspberry Pi, `openhabian`). Tanken med projektet är att:

- **Äga datan själv** – spara alla mätvärden i en lokal SQLite-databas, utan molntjänster.
- **Se läget direkt** – aktuella värden uppdateras live via WebSocket.
- **Kunna titta bakåt** – historik med zoom och panorering, från en timme upp till flera år, även för data som importerats från openHAB.
- **Hålla det enkelt** – en Node-process på hemmanätverket som både serverar API och frontend.

## Arkitektur

```
MQTT-broker ──► server/mqttClient.js ──► SQLite (server/data/dashboard.db)
 (openHAB)              │                          │
                        └─► Socket.io ─────────────┼─► React-klient (client/)
                                                   └─► REST /api/*
```

- **`server/`** – Express + Socket.io + MQTT-klient + SQLite.
  - `mqttClient.js` prenumererar på MQTT-topics och mappar JSON-fält till sensorer (`SENSOR_MAP`).
  - `db.js` äger databasschemat (tabellen `readings`) och all aggregering (rå, timme, dag, vecka, månad, år).
  - `index.js` exponerar REST-API, pushar nya värden via Socket.io och serverar byggd frontend från `client/dist`.
- **`client/`** – React 18 + Vite + Recharts. UI på svenska. Sensorerna är grupperade i *Väderstation* och *Panna / Värme*.
- **`scripts/`** – engångsverktyg, t.ex. import av historik från openHAB.
- **`deploy.sh`** – uppdaterar och startar om tjänsten på servern (pm2).

### Sensorer

| Sensor          | MQTT-topic            | Fält                  | Enhet |
|-----------------|-----------------------|-----------------------|-------|
| `utetemperatur` | `weatherstation/temp` | `temperature`         | °C    |
| `vind_avg`      | `weatherstation/wind` | `speed_avg_adjusted`  | m/s   |
| `vind_gust`     | `weatherstation/wind` | `speed_gust_adjusted` | m/s   |
| `regn`          | `weatherstation/rain` | `rain`                | mm    |
| `framledning`   | `panna/temp`          | `sensor1`             | °C    |
| `rok_temp`      | `panna/temp`          | `smoke`               | °C    |
| `panntemp`      | `panna/temp`          | `sensor2`             | °C    |
| `returledning`  | `panna/temp`          | `sensor3`             | °C    |

Vill man lägga till en sensor: lägg till en rad i `SENSOR_MAP` (`server/mqttClient.js`) och i `SENSOR_GROUPS` / `SENSOR_LABELS` (`client/src/App.jsx`).

## Kom igång

Krav: Node.js och en MQTT-broker som nås från servern.

### Server

```bash
cd server
cp .env.example .env     # fyll i MQTT_HOST, MQTT_PORT, MQTT_USER, MQTT_PASS, PORT
npm install
npm run dev              # eller: npm start
```

Databasen skapas automatiskt i `server/data/` vid första start.

### Klient

```bash
cd client
npm install
npm run dev              # Vite på http://localhost:5173
npm run build            # bygger till client/dist, som servern sedan serverar
```

Vite-dev-servern proxar `/api` och `/socket.io` till backend. Proxy-adressen är satt i `client/vite.config.js` (just nu `192.168.1.8:3000`) – ändra vid behov.

## API

| Endpoint | Beskrivning |
|----------|-------------|
| `GET /api/sensors` | Alla kända sensorer och deras enheter |
| `GET /api/latest`  | Senaste värdet per sensor |
| `GET /api/history?sensor=&from=&to=&resolution=&aggregation=` | Historik. `from`/`to` är epoch-millisekunder. `resolution`: `raw`, `hour`, `day`, `week`, `month`, `year`. `aggregation`: `avg` (standard) eller `sum` (t.ex. regn). |

Socket.io: servern skickar `init` (senaste värden) vid anslutning och `update` för varje nytt mätvärde.

## Importera historik från openHAB

```bash
cd server
npm run import:openhab -- --input export.csv --map ../scripts/openhab-sensor-map.example.json --dry-run
```

Kopiera `scripts/openhab-sensor-map.example.json` och byt ut `source`-värdena mot dina openHAB-itemnamn. Ta bort `--dry-run` för att faktiskt skriva till databasen. Flaggor för andra kolumnnamn och JSON-format finns i `scripts/import-openhab-history.js`.

## Deploy

På servern: `./deploy.sh` (git pull, installera, bygg klienten, starta om via pm2 under namnet `home-dashboard`).

## Datalagring

Allt ligger i `server/data/dashboard.db` (ingår inte i git). Ta backup på den filen. `db.pruneOlderThan(days)` finns för gallring men används inte automatiskt.

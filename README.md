# Home Dashboard

Ett litet, självhostat dashboard för hemmets sensorer. Det visar aktuella värden live och låter mig bläddra i historik över temperatur, vind, regn och pannans temperaturer.

## Syfte

Sensordata från väderstationen och pannan skickas redan via MQTT (hanterat av openHAB på en Raspberry Pi, `openhabian`). Tanken med projektet är att:

- **Äga datan själv** – spara alla mätvärden i en lokal SQLite-databas, utan molntjänster.
- **Se läget direkt** – aktuella värden uppdateras live via WebSocket.
- **Kunna titta bakåt** – historik med zoom och panorering, från en timme upp till flera år, även för data som importerats från openHAB.
- **Samla energin på ett ställe** – elbilsladdaren (NexBlue Edge 2) visas bredvid väder och panna.
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

### Elbilsladdare (NexBlue Edge 2)

`server/nexblue.js` pollar NexBlue OpenAPI (skrivskyddat, standard var 60:e sekund) och sparar `ev_effekt` (kW), `ev_energi_session` och `ev_energi_total` (kWh) samt `ev_status` i samma `readings`-tabell, så historik och diagram fungerar som för övriga sensorer. Övrig status (kabellås, strömgräns, ström/spänning per fas) visas i en panel och skickas via Socket.io-eventet `ev` och `GET /api/ev`.

- API:et har ingen historik – bara aktuell status – så historiken börjar när polling startar.
- API:et är NexBlues molntjänst (`https://api.nexblue.com/third_party`, standardvärde hämtat från Home Assistants NexBlue-integration), inte laddboxen direkt. Inloggning med NexBlue-kontot via `NEXBLUE_USERNAME`/`NEXBLUE_PASSWORD` i `server/.env`.
- Integrationen är **avstängd** om användarnamn/lösenord saknas. `NEXBLUE_MOCK=1` ger testdata som aldrig sparas i databasen.
- Start/stopp av laddning stöds av API:et men är medvetet inte implementerat (dashboarden saknar inloggning).
- NexBlue Zen (lastbalanseraren) saknas i det här API:et men läses via portalens API, se nedan.
- Betydelsen av `charging_state` (0–7) kommer från Home Assistant-integrationen och finns i `CHARGING_STATES` i `client/src/App.jsx`.

### Husets förbrukning (NexBlue Zen)

`server/zen.js` hämtar husets effekt från lastbalanseraren Zen via NexBlue-portalens API (`my.nexblue.com`), standard var 5:e minut (`NEXBLUE_PORTAL_POLL_SECONDS=300`), och sparar alla minutvärden som `hus_effekt` (kW) i `readings`. Förbrukningsklockan (`server/consumption.js`) räknar kvartsmedel av den sensorn, så panelen slutar visa testdata när värden finns. `hus_energi_total` (kWh) sparas när mätaren ändras (den stegar en gång per timme; kvartsenergi räknas alltid från effekten).

- **Inofficiellt och odokumenterat API** som kan ändras utan förvarning. Skrivskyddat: inga skrivande anrop görs. Utredning och endpoints finns i AgentOps-hubben (`projects/home-dashboard/agentops/investigations/2026-11-02-nexblue-portal-api-zen.md`).
- Inloggning med **portalkontot** via `NEXBLUE_PORTAL_USERNAME`/`NEXBLUE_PORTAL_PASSWORD` (kan vara ett annat konto än `NEXBLUE_USERNAME`) samt `NEXBLUE_DETECTOR_SN` (lastbalanserarens ID). Avstängd om något av de tre saknas. På Pi:n läses `.env` bredvid `docker-compose.yml` (inte `server/.env`, som bara används vid lokal körning); efter ändring: `docker compose up -d` i den katalogen. Ett `$` i lösenordet tolkas av docker compose som variabel och måste stå inom enkla citattecken eller skrivas `$$`. Lyckad hämtning syns i `docker logs` som `[zen] sparade N punkter …`.
- Vid start och efter avbrott fylls historik på bakåt, standard 24 timmar (`NEXBLUE_PORTAL_BACKFILL_HOURS`, högst 72). Token gäller 24 timmar; modulen loggar in på nytt vid behov och väntar 30 minuter efter tre avvisade inloggningar i rad så att kontot inte spärras.
- Testa mot riktiga kontot utan att röra databasen: `node scripts/nexblue-portal-test.js --sn <id> --date YYYY-MM-DD` (frågar efter lösenordet om det inte finns i miljön).

## Kom igång

Krav: Node.js och en MQTT-broker som nås från servern.

### Server

```bash
cd server
cp .env.example .env     # fyll i MQTT_HOST, MQTT_PORT, MQTT_USER, MQTT_PASS, PORT (och NEXBLUE_* för laddboxen)
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

## Docker på Raspberry Pi (arm64)

Push till `main` bygger en arm64-image via GitHub Actions och pushar den till `ghcr.io/matehall/home-dashboard`. Watchtower på Pi:n hämtar den nya imagen (var 5:e minut) och startar om containern.

På Pi:n (en gång):

1. Installera Docker, skapa en katalog och kopiera in `docker-compose.yml`.
2. Skapa `.env` bredvid (se `server/.env.example`). Använd Pi:ns/brokerns IP för `MQTT_HOST`, inte `localhost`.
3. Flytta ev. befintlig `dashboard.db` till `./data/`.
4. Är paketet privat: `docker login ghcr.io` (PAT med `read:packages`) och montera config i Watchtower (se kommentar i compose-filen).
5. `docker compose up -d`

`deploy.sh` (pm2) behålls tills Docker-flödet är verifierat.

## Tuya-brytare (valfritt)

Visar status (på/av, offline) och för brytare med energimätning effekt, spänning, ström och kWh. Skrivskyddat via Tuya Cloud API.
Skapa ett Cloud-projekt på iot.tuya.com, länka Smart Life-appen och fyll i `TUYA_ACCESS_ID`, `TUYA_ACCESS_SECRET`, `TUYA_UID` (och `TUYA_ENDPOINT` om du inte är i EU) i `.env`. `TUYA_MOCK=1` ger testdata. Se `server/.env.example`.

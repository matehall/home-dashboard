import { useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";

const API_BASE = "";
const SOCKET_URL = typeof window !== "undefined" ? window.location.origin : "http://192.168.1.8:3000";

const SENSOR_GROUPS = [
  {
    title: "Väderstation",
    sensors: ["utetemperatur", "vind_avg", "vind_gust", "regn"],
  },
  {
    title: "Panna / Värme",
    sensors: ["framledning", "rok_temp", "panntemp", "returledning"],
  },
];

const SENSOR_LABELS = {
  utetemperatur: "Utetemperatur",
  vind_avg: "AVG Vind",
  vind_gust: "GUST Vind",
  regn: "Regn",
  framledning: "Framledning",
  rok_temp: "Rök temp",
  panntemp: "Panntemperatur",
  returledning: "Returledning",
};

const TIME_RANGES = {
  "1h": { label: "1h", ms: 3600000, resolution: "raw" },
  "6h": { label: "6h", ms: 21600000, resolution: "raw" },
  "24h": { label: "24h", ms: 86400000, resolution: "hour" },
  "7d": { label: "7d", ms: 604800000, resolution: "day" },
  "30d": { label: "30d", ms: 2592000000, resolution: "day" },
  "1y": { label: "1 år", ms: 31536000000, resolution: "month" },
  "all": { label: "Alla", ms: null, resolution: "month" },
};

function formatAge(ts) {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s sedan`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m sedan`;
  const h = Math.floor(min / 60);
  return `${h}h sedan`;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
}

function formatChartLabel(ts, range) {
  const date = new Date(ts);
  if (range === "1h" || range === "6h" || range === "24h") {
    return date.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
  }
  if (range === "7d" || range === "30d") {
    return date.toLocaleDateString("sv-SE", { day: "2-digit", month: "2-digit" });
  }
  if (range === "1y") {
    return date.toLocaleDateString("sv-SE", { month: "short", year: "2-digit" });
  }
  return date.toLocaleDateString("sv-SE", { year: "numeric", month: "short", day: "2-digit" });
}

function CustomTooltip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const p = payload[0];
  return (
    <div className="custom-tooltip">
      <p style={{ color: "#fbbf24", fontWeight: "600", marginBottom: "4px" }}>
        {p.payload.label ?? p.payload.ts}
      </p>
      <p style={{ color: "#e5e7eb", margin: "4px 0" }}>
        <strong>{p.name}:</strong> {p.value.toFixed(1)}
      </p>
    </div>
  );
}

function SensorCard({ item }) {
  if (!item) return null;
  return (
    <div className="card">
      <div className="card-top">
        <span className="label">{SENSOR_LABELS[item.sensor] ?? item.sensor}</span>
        <span className="age">{formatAge(item.ts)}</span>
      </div>
      <div className="value-row">
        <span className="value">{Number(item.value).toFixed(1)}</span>
        <span className="unit">{item.unit}</span>
      </div>
      <div className="meta">Uppdaterad {formatTime(item.ts)}</div>
    </div>
  );
}

export default function App() {
  const [latest, setLatest] = useState({});
  const [connected, setConnected] = useState(false);
  const [historySensor, setHistorySensor] = useState("utetemperatur");
  const [range, setRange] = useState("24h");
  const [historyData, setHistoryData] = useState({ raw: [], aggregated: [] });
  const [chartType, setChartType] = useState("line");

  useEffect(() => {
    const socket = io(SOCKET_URL, { transports: ["websocket"] });
    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("init", (rows) => {
      const map = {};
      for (const row of rows) map[row.sensor] = row;
      setLatest(map);
    });
    socket.on("update", (row) => {
      setLatest((prev) => ({ ...prev, [row.sensor]: row }));
    });
    return () => socket.close();
  }, []);

  useEffect(() => {
    const now = Date.now();
    const timeRange = TIME_RANGES[range];
    const from = timeRange.ms ? now - timeRange.ms : 0;
    const useSum = historySensor === "regn" ? "sum" : "avg";
    
    fetch(`${API_BASE}/api/history?sensor=${encodeURIComponent(historySensor)}&from=${from}&to=${now}&resolution=${timeRange.resolution}&aggregation=${useSum}`)
      .then((r) => r.json())
      .then(setHistoryData)
      .catch(() => setHistoryData({ raw: [], aggregated: [] }));
  }, [historySensor, range]);

  // Format raw data for chart
  const rawChartData = useMemo(() => 
    historyData.raw?.map(row => ({
      ts: row.ts,
      label: formatChartLabel(row.ts, range),
      value: Number(row.value),
    })) || []
  , [historyData.raw, range]);

  // Format aggregated data for chart
  const aggChartData = useMemo(() => 
    historyData.aggregated?.map(row => ({
      ts: row.ts,
      label: formatChartLabel(row.ts, range),
      value: Number(row.value),
    })) || []
  , [historyData.aggregated, range]);

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>Home Dashboard</h1>
          <p>MQTT → SQLite → historik + live</p>
        </div>
        <div className={`status ${connected ? "up" : "down"}`}>{connected ? "Ansluten" : "Frånkopplad"}</div>
      </header>

      {SENSOR_GROUPS.map((group) => (
        <section key={group.title} className="section">
          <h2>{group.title}</h2>
          <div className="grid">
            {group.sensors.map((sensor) => (
              <SensorCard key={sensor} item={latest[sensor]} />
            ))}
          </div>
        </section>
      ))}

      <section className="section">
        <div className="chart-head">
          <h2>Historik</h2>
          <select value={historySensor} onChange={(e) => setHistorySensor(e.target.value)}>
            {Object.keys(SENSOR_LABELS).map((sensor) => (
              <option key={sensor} value={sensor}>{SENSOR_LABELS[sensor]}</option>
            ))}
          </select>
          <div className="range-buttons">
            {Object.entries(TIME_RANGES).map(([key, val]) => (
              <button key={key} className={range === key ? "active" : ""} onClick={() => setRange(key)}>
                {val.label}
              </button>
            ))}
          </div>
        </div>

        {/* Raw/Momentan data chart */}
        {rawChartData.length > 0 && (
          <div className="chart">
            <h3 style={{ margin: "0 0 12px 0", fontSize: "1rem", color: "#cbd5e1" }}>Momentana värden</h3>
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={rawChartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="ts"
                  type="number"
                  domain={["dataMin", "dataMax"]}
                  tickFormatter={(value) => formatChartLabel(value, range)}
                  hide={rawChartData.length > 40}
                />
                <YAxis />
                <Tooltip content={<CustomTooltip />} labelFormatter={(value) => formatChartLabel(value, range)} />
                <Legend />
                <Line type="monotone" dataKey="value" stroke="#94a3b8" dot={false} strokeWidth={1} name="Värde" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Aggregated data chart */}
        {aggChartData.length > 0 && (
          <div className="chart">
            <h3 style={{ margin: "0 0 12px 0", fontSize: "1rem", color: "#cbd5e1" }}>Aggregerat per timme</h3>
            <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
              <button 
                className={chartType === "line" ? "active" : ""} 
                onClick={() => setChartType("line")}
                style={{
                  border: "1px solid rgba(148,163,184,.3)",
                  background: chartType === "line" ? "#4f46e5" : "#111827",
                  color: "#e5e7eb",
                  borderRadius: "10px",
                  padding: "8px 12px",
                  cursor: "pointer",
                  fontSize: "0.9rem"
                }}
              >
                📈 Linje
              </button>
              <button 
                className={chartType === "bar" ? "active" : ""} 
                onClick={() => setChartType("bar")}
                style={{
                  border: "1px solid rgba(148,163,184,.3)",
                  background: chartType === "bar" ? "#4f46e5" : "#111827",
                  color: "#e5e7eb",
                  borderRadius: "10px",
                  padding: "8px 12px",
                  cursor: "pointer",
                  fontSize: "0.9rem"
                }}
              >
                📊 Stapel
              </button>
            </div>
            <ResponsiveContainer width="100%" height={280}>
              {chartType === "bar" ? (
                <BarChart data={aggChartData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis
                    dataKey="ts"
                    type="number"
                    domain={["dataMin", "dataMax"]}
                    tickFormatter={(value) => formatChartLabel(value, range)}
                    hide={aggChartData.length > 40}
                  />
                  <YAxis />
                  <Tooltip content={<CustomTooltip />} labelFormatter={(value) => formatChartLabel(value, range)} />
                  <Legend />
                  <Bar dataKey="value" fill="#4f46e5" name={historySensor === "regn" ? "Summa" : "Medel"} />
                </BarChart>
              ) : (
                <LineChart data={aggChartData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis
                    dataKey="ts"
                    type="number"
                    domain={["dataMin", "dataMax"]}
                    tickFormatter={(value) => formatChartLabel(value, range)}
                    hide={aggChartData.length > 40}
                  />
                  <YAxis />
                  <Tooltip content={<CustomTooltip />} labelFormatter={(value) => formatChartLabel(value, range)} />
                  <Legend />
                  <Line type="monotone" dataKey="value" stroke="#4f46e5" dot={false} strokeWidth={2} name={historySensor === "regn" ? "Summa" : "Medel"} />
                </LineChart>
              )}
            </ResponsiveContainer>
          </div>
        )}
      </section>
    </div>
  );
}

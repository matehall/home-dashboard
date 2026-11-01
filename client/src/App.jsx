import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  {
    title: "Elbilsladdare",
    sensors: ["ev_effekt", "ev_energi_session", "ev_energi_total"],
    extra: "ev",
  },
  {
    title: "Elpris",
    sensors: [],
    extra: "electricity",
    wide: true,
  },
  {
    title: "Robotdammsugare",
    sensors: ["vacuum_batteri", "vacuum_yta"],
    extra: "vacuum",
  },
  {
    title: "Inomhus & brytare",
    sensors: [],
    extra: "tuya",
    wide: true,
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
  ev_effekt: "Laddeffekt",
  ev_energi_session: "Energi (session)",
  ev_energi_total: "Energi (totalt)",
  vacuum_batteri: "Batteri",
  vacuum_yta: "Städad yta",
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

// Koderna hämtade från Home Assistants NexBlue-integration (sensor.py).
const CHARGING_STATES = {
  0: "Vilar",
  1: "Ansluten",
  2: "Laddar",
  3: "Klar",
  4: "Fel",
  5: "Väntar (lastbalansering)",
  6: "Väntar (fördröjd start)",
  7: "Väntar på bilen",
};
const PHASE_MODES = { 0: "Trefas", 1: "Enfas" };

function yesNo(v, yes, no) {
  return v === null || v === undefined ? "–" : v ? yes : no;
}

function EvPanel({ ev }) {
  if (!ev) return <div className="card ev-panel"><span className="meta">Ingen laddboxdata än</span></div>;
  const state = CHARGING_STATES[ev.charging_state] ?? `Kod ${ev.charging_state}`;
  const tone = ev.charging_state === 2 ? "charging" : ev.charging_state === 4 ? "error" : "idle";
  const amp = (v) => (v != null ? `${v}A` : "–");
  const chips = [
    ["Kabel", yesNo(ev.is_lock, "Låst", "Olåst")],
    ["Box", yesNo(ev.is_disable, "Av", "På")],
    ["Gräns", amp(ev.current_limit_a)],
    ["Säkring", amp(ev.circuit_fuse_a)],
    ["Kabel max", amp(ev.cable_current_limit_a)],
    ["Fas", PHASE_MODES[ev.phase_charging] ?? "–"],
  ];
  return (
    <div className={`card ev-panel ${tone}`}>
      <div className="ev-state">
        <span className="ev-dot" />
        <span className="ev-status">{state}</span>
        <span className="ev-serial">{ev.serial} · {formatAge(ev.ts)}</span>
      </div>
      {ev.current_a.length > 0 && (
        <div className="ev-phases">
          {ev.current_a.map((a, i) => (
            <div key={i} className="ev-phase">
              <span className="ph">L{i + 1}</span>
              <span className="ph-a">{a.toFixed(1)}<small>A</small></span>
              <span className="ph-v">{ev.voltage_v[i]}V</span>
            </div>
          ))}
        </div>
      )}
      <div className="ev-chips">
        {chips.map(([k, v]) => (<span key={k} className="chip"><em>{k}</em>{v}</span>))}
      </div>
    </div>
  );
}

// Koderna från python-miio (roborockvacuum.py), gäller Roborock S5.
const VACUUM_STATES = {
  1: "Startar", 2: "Frånkopplad från laddare", 3: "Redo", 4: "Fjärrstyrd", 5: "Städar",
  6: "Åker till laddaren", 7: "Manuellt läge", 8: "Laddar", 9: "Laddningsproblem", 10: "Pausad",
  11: "Punktstädning", 12: "Fel", 13: "Stänger av", 14: "Uppdaterar", 15: "Dockar",
  16: "Åker till mål", 17: "Zonstädning", 18: "Rumsstädning", 100: "Laddad",
};
const VACUUM_ERRORS = {
  1: "Lasersensor", 2: "Kollisionssensor", 3: "Hjul svävar", 4: "Stupsensor", 5: "Huvudborste fastnat",
  6: "Sidoborste fastnat", 7: "Hjul fastnat", 8: "Fastnat", 9: "Dammbehållare saknas", 10: "Filter blockerat",
  11: "Magnetfält", 12: "Lågt batteri", 13: "Laddningsproblem", 14: "Batterifel", 15: "Väggsensor smutsig",
  16: "Ställ på plant underlag", 17: "Sidoborste fel", 18: "Sugfläkt fel", 19: "Laddstation utan ström",
  21: "Laser blockerad", 22: "Laddkontakter smutsiga",
};
const VACUUM_FANS = { 101: "Tyst", 102: "Balanserad", 103: "Turbo", 104: "Max", 105: "Moppning" };
const VACUUM_ACTIVE = [4, 5, 7, 11, 16, 17, 18];

function VacuumPanel({ vacuum }) {
  if (!vacuum) return <div className="card ev-panel"><span className="meta">Ingen dammsugardata än</span></div>;
  const hasError = vacuum.error_code > 0;
  const state = hasError ? (VACUUM_ERRORS[vacuum.error_code] ?? `Fel ${vacuum.error_code}`) : (VACUUM_STATES[vacuum.state] ?? `Kod ${vacuum.state}`);
  const tone = hasError || vacuum.state === 12 ? "error" : VACUUM_ACTIVE.includes(vacuum.state) ? "charging" : "idle";
  const chips = [
    ["Batteri", `${vacuum.battery}%`],
    ["Senaste städ", `${Math.round(vacuum.clean_time_s / 60)} min`],
    ["Yta", `${vacuum.clean_area_m2.toFixed(1)} m²`],
    ["Sugkraft", VACUUM_FANS[vacuum.fan_power] ?? "–"],
  ];
  return (
    <div className={`card ev-panel ${tone}`}>
      <div className="ev-state">
        <span className="ev-dot" />
        <span className="ev-status">{state}</span>
        <span className="ev-serial">Roborock S5 · {formatAge(vacuum.ts)}</span>
      </div>
      <div className="ev-chips">
        {chips.map(([k, v]) => (<span key={k} className="chip"><em>{k}</em>{v}</span>))}
      </div>
    </div>
  );
}

const BATTERY_STATE = { low: "låg", middle: "medel", high: "hög" };

function DeviceDetails({ id, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    fetch(`${API_BASE}/api/tuya/devices/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => alive && setData(j))
      .catch((e) => alive && setError(e.message));
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => { alive = false; window.removeEventListener("keydown", onKey); };
  }, [id, onClose]);
  const status = data?.raw?.status;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="card-top">
          <span className="label">{data?.device?.name?.trim() ?? "Enhet"}</span>
          <button className="modal-close" onClick={onClose} aria-label="Stäng">×</button>
        </div>
        {error && <div className="meta">Kunde inte hämta: {error}</div>}
        {!data && !error && <div className="meta">Hämtar…</div>}
        {data && (
          <>
            <h4 className="modal-h">Värden</h4>
            <table className="kv">
              <tbody>
                {Object.entries(data.device).map(([k, v]) => (
                  <tr key={k}><th>{k}</th><td>{v === null ? "–" : String(v)}</td></tr>
                ))}
              </tbody>
            </table>
            {Array.isArray(status) && status.length > 0 && (
              <>
                <h4 className="modal-h">Status (rå)</h4>
                <table className="kv">
                  <tbody>{status.map((s) => <tr key={s.code}><th>{s.code}</th><td>{JSON.stringify(s.value)}</td></tr>)}</tbody>
                </table>
              </>
            )}
            <h4 className="modal-h">Tuya-data</h4>
            <pre className="raw">{JSON.stringify(data.raw, null, 2)}</pre>
            <h4 className="modal-h">Specifikation</h4>
            <pre className="raw">{JSON.stringify(data.specifications, null, 2)}</pre>
            {Object.entries(data.probes ?? {}).map(([k, v]) => (
              <div key={k}>
                <h4 className="modal-h">{k}</h4>
                <pre className="raw">{JSON.stringify(v, null, 2)}</pre>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

const PRICE_TZ = "Europe/Stockholm";
const QUARTER_MS = 15 * 60 * 1000;
const dayKey = (ts) => new Intl.DateTimeFormat("sv-SE", { timeZone: PRICE_TZ }).format(new Date(ts));
const quarterLabel = (ts) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: PRICE_TZ, hour: "2-digit", minute: "2-digit" }).format(new Date(ts));
const formatOre = (v) => (v === null || v === undefined ? "–" : `${v.toFixed(1).replace(".", ",")} öre/kWh`);

// Prisklockan: ett dygn som en ring, midnatt överst och medsols. Varje kvart är ett segment vars längd är priset.
const CLK = { size: 340, c: 170, r0: 80, len: 60 };
function polar(r, deg) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [CLK.c + r * Math.cos(a), CLK.c + r * Math.sin(a)];
}
function segmentPath(r1, a0, a1) {
  const [x0, y0] = polar(CLK.r0, a0);
  const [x1, y1] = polar(r1, a0);
  const [x2, y2] = polar(r1, a1);
  const [x3, y3] = polar(CLK.r0, a1);
  const f = (n) => n.toFixed(2);
  return `M${f(x0)} ${f(y0)}L${f(x1)} ${f(y1)}A${r1} ${r1} 0 0 1 ${f(x2)} ${f(y2)}L${f(x3)} ${f(y3)}A${CLK.r0} ${CLK.r0} 0 0 0 ${f(x0)} ${f(y0)}Z`;
}

function PriceClock({ data, now }) {
  const [hovered, setHovered] = useState(null);
  const n = data.length;
  if (!n) return null;
  const step = 360 / n;
  const maxOre = Math.max(...data.map((p) => p.ore), 1);
  const upcoming = data.filter((p) => !p.past).map((p) => p.ore).sort((x, y) => x - y);
  const lowLimit = upcoming.length >= 5 ? upcoming[Math.floor(upcoming.length * 0.2)] : -Infinity;
  const highLimit = upcoming.length >= 5 ? upcoming[Math.ceil(upcoming.length * 0.8) - 1] : Infinity;
  const currentIdx = data.findIndex((p) => p.ts <= now && now < p.ts + QUARTER_MS);
  const shown = hovered ?? (currentIdx >= 0 ? data[currentIdx] : null);
  const colorOf = (p) => {
    if (p.past) return "var(--clk-past)";
    if (p.ore <= lowLimit) return "var(--ok)";
    if (p.ore >= highLimit) return "var(--warn)";
    return "var(--accent)";
  };

  const pointerAngle = currentIdx >= 0 ? currentIdx * step + step / 2 : null;
  const [px0, py0] = pointerAngle === null ? [0, 0] : polar(CLK.r0 - 10, pointerAngle);
  const [px1, py1] = pointerAngle === null ? [0, 0] : polar(CLK.r0 + CLK.len + 8, pointerAngle);

  return (
    <svg className="price-clock" viewBox={`0 0 ${CLK.size} ${CLK.size}`} role="img" aria-label="Elpris per kvart över dygnet">
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <circle key={f} cx={CLK.c} cy={CLK.c} r={CLK.r0 + CLK.len * f} className="clk-grid" />
      ))}
      <circle cx={CLK.c} cy={CLK.c} r={CLK.r0 - 4} className="clk-core" />
      {Array.from({ length: 24 }, (_, h) => {
        const [x0, y0] = polar(CLK.r0 + CLK.len + 3, h * 15);
        const [x1, y1] = polar(CLK.r0 + CLK.len + (h % 3 === 0 ? 10 : 6), h * 15);
        return <line key={h} x1={x0} y1={y0} x2={x1} y2={y1} className="clk-tick" />;
      })}
      {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => {
        const [x, y] = polar(CLK.r0 + CLK.len + 22, h * 15);
        return <text key={h} x={x} y={y} className="clk-hour" textAnchor="middle" dominantBaseline="central">{String(h).padStart(2, "0")}</text>;
      })}
      {data.map((p, i) => {
        const r1 = CLK.r0 + Math.max(3, (CLK.len * Math.max(p.ore, 0)) / maxOre);
        const isNow = i === currentIdx;
        return (
          <path
            key={p.ts}
            d={segmentPath(r1, i * step + 0.25, (i + 1) * step - 0.25)}
            fill={colorOf(p)}
            className={`clk-seg${isNow ? " now" : ""}${hovered?.ts === p.ts ? " hover" : ""}`}
            onMouseEnter={() => setHovered(p)}
            onMouseLeave={() => setHovered(null)}
            onClick={() => setHovered((h) => (h?.ts === p.ts ? null : p))}
          >
            <title>{`${quarterLabel(p.ts)}  ${formatOre(p.ore)}`}</title>
          </path>
        );
      })}
      {pointerAngle !== null && <line x1={px0} y1={py0} x2={px1} y2={py1} className="clk-pointer" />}
      <text x={CLK.c} y={CLK.c - 22} className="clk-time" textAnchor="middle">{shown ? quarterLabel(shown.ts) : ""}</text>
      <text x={CLK.c} y={CLK.c + 8} className="clk-price" textAnchor="middle">{shown ? shown.ore.toFixed(1).replace(".", ",") : "–"}</text>
      <text x={CLK.c} y={CLK.c + 28} className="clk-unit" textAnchor="middle">öre/kWh</text>
    </svg>
  );
}

function ElectricityPanel({ electricity }) {
  const [day, setDay] = useState("today");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000); // så passerade kvartar och visaren följer klockan
    return () => clearInterval(id);
  }, []);
  if (!electricity) return <div className="card ev-panel"><span className="meta">Inga elpriser än</span></div>;

  const todayKey = dayKey(now);
  const tomorrowKey = dayKey(now + 24 * 3600 * 1000);
  const hasTomorrow = electricity.prices.some((p) => dayKey(p.ts) === tomorrowKey);
  const shownKey = day === "tomorrow" && hasTomorrow ? tomorrowKey : todayKey;
  const data = electricity.prices
    .filter((p) => dayKey(p.ts) === shownKey)
    .map((p) => ({ ...p, past: p.ts + QUARTER_MS <= now }));
  const upcoming = electricity.prices.filter((p) => p.ts + QUARTER_MS > now);
  const cheapest = [...upcoming].sort((a, b) => a.ore - b.ore).slice(0, 4).sort((a, b) => a.ts - b.ts);
  const ores = data.map((p) => p.ore);
  const current = electricity.prices.find((p) => p.ts <= now && now < p.ts + QUARTER_MS)?.ore ?? null;

  return (
    <div className="card elpris-panel">
      <div className="card-top">
        <div>
          <span className="meta">Nu ({electricity.area}, rent spotpris)</span>
          <div className="elpris-now">{formatOre(current)}</div>
        </div>
        <div className="elpris-days">
          <button type="button" className={shownKey === todayKey ? "active" : ""} onClick={() => setDay("today")}>Idag</button>
          <button type="button" className={shownKey === tomorrowKey ? "active" : ""} disabled={!hasTomorrow} onClick={() => setDay("tomorrow")}>Imorgon</button>
        </div>
      </div>
      <div className="elpris-body">
        <PriceClock data={data} now={now} />
        <div className="elpris-side">
          {ores.length > 0 && (
            <div className="elpris-stats">
              <span>Lägst <b>{formatOre(Math.min(...ores))}</b></span>
              <span>Högst <b>{formatOre(Math.max(...ores))}</b></span>
            </div>
          )}
          {cheapest.length > 0 && (
            <div>
              <h4 className="modal-h">Billigaste kvartarna framåt</h4>
              <ul className="elpris-list">
                {cheapest.map((p) => (
                  <li key={p.ts}><span>{dayKey(p.ts) === todayKey ? "" : "imorgon "}{quarterLabel(p.ts)}</span><b>{formatOre(p.ore)}</b></li>
                ))}
              </ul>
            </div>
          )}
          <div className="clk-legend">
            <span><i style={{ background: "var(--clk-past)" }} />Passerat</span>
            <span><i style={{ background: "var(--ok)" }} />Billigt</span>
            <span><i style={{ background: "var(--accent)" }} />Normalt</span>
            <span><i style={{ background: "var(--warn)" }} />Dyrt</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function TuyaPanel({ tuya }) {
  const [selected, setSelected] = useState(null);
  const closeDetails = useCallback(() => setSelected(null), []);
  const open = (id) => ({
    onClick: () => setSelected(id),
    onKeyDown: (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setSelected(id)),
    role: "button",
    tabIndex: 0,
  });
  if (!tuya) return <div className="card ev-panel"><span className="meta">Ingen brytardata än</span></div>;
  const climate = tuya.devices.filter((d) => d.kind === "climate");
  const others = tuya.devices.filter((d) => !climate.includes(d));
  return (
    <>
      {selected && <DeviceDetails id={selected} onClose={closeDetails} />}
      {climate.length > 0 && (
        <div className="grid">
          {climate.map((d) => (
            <div key={d.id} className="card clickable" {...open(d.id)}>
              <div className="card-top">
                <span className="label">{d.name}</span>
                <span className="age">{d.online ? formatAge(tuya.ts) : "offline"}</span>
              </div>
              <div className="value-row">
                <span className="value">{d.online && d.temperature_c !== null ? d.temperature_c.toFixed(1) : "–"}</span>
                <span className="unit">°C</span>
              </div>
              <div className="meta">
                {d.online ? `Fukt ${d.humidity ?? "–"} % · Batteri ${d.battery !== null ? `${d.battery} %` : BATTERY_STATE[d.battery_state] ?? "–"}` : "Ingen kontakt"}
              </div>
            </div>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div className="grid mini-grid">
          {others.map((d) => {
            const tone = !d.online ? "error" : d.on ? "charging" : "idle";
            const state = !d.online ? "Offline" : d.on === null ? "Online" : d.on ? "På" : "Av";
            const chips = [];
            if (d.power_w !== null) chips.push(`${d.power_w.toFixed(d.power_w < 100 ? 1 : 0)} W`);
            if (d.voltage_v !== null) chips.push(`${d.voltage_v.toFixed(0)} V`);
            if (d.current_a !== null) chips.push(`${d.current_a.toFixed(2)} A`);
            if (d.energy_kwh !== null) chips.push(`${d.energy_kwh.toFixed(2)} kWh`);
            return (
              <div key={d.id} className={`card mini ev-panel clickable ${tone}`} {...open(d.id)}>
                <span className="ev-dot" />
                <span className="mini-name">{d.name.trim()}</span>
                <span className="ev-status">{state}</span>
                {chips.length > 0 && <span className="meta mini-chips">{chips.join(" · ")}</span>}
              </div>
            );
          })}
        </div>
      )}
    </>
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

function HeaderClock() {
  const [t, setT] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setT(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const time = new Intl.DateTimeFormat("sv-SE", { timeZone: PRICE_TZ, hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(t);
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: PRICE_TZ, weekday: "long", day: "numeric", month: "long" }).format(t);
  return <div className="header-clock"><b>{time}</b><span>{date}</span></div>;
}

export default function App() {
  const [latest, setLatest] = useState({});
  const [ev, setEv] = useState(null);
  const [vacuum, setVacuum] = useState(null);
  const [tuya, setTuya] = useState(null);
  const [electricity, setElectricity] = useState(null);
  const [connected, setConnected] = useState(false);
  const [historySensor, setHistorySensor] = useState("utetemperatur");
  const [range, setRange] = useState("24h");
  const [timeOffsetMs, setTimeOffsetMs] = useState(0);
  const [historyData, setHistoryData] = useState({ raw: [], aggregated: [] });
  const [chartType, setChartType] = useState("line");
  const [zoomDomain, setZoomDomain] = useState(null);
  const rawChartRef = useRef(null);
  const aggChartRef = useRef(null);
  const panRef = useRef({ active: false, startX: 0, startOffset: 0, startDomain: null });

  useEffect(() => {
    const socket = io(SOCKET_URL, { transports: ["websocket"] });
    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("init", (rows) => {
      const map = {};
      for (const row of rows) map[row.sensor] = row;
      setLatest(map);
    });
    socket.on("ev", setEv);
    socket.on("vacuum", setVacuum);
    socket.on("tuya", setTuya);
    socket.on("electricity", setElectricity);
    socket.on("update", (row) => {
      setLatest((prev) => ({ ...prev, [row.sensor]: row }));
    });
    return () => socket.close();
  }, []);

  useEffect(() => {
    const now = Date.now() - timeOffsetMs;
    const timeRange = TIME_RANGES[range];
    const from = timeRange.ms ? now - timeRange.ms : 0;
    const useSum = historySensor === "regn" ? "sum" : "avg";
    
    fetch(`${API_BASE}/api/history?sensor=${encodeURIComponent(historySensor)}&from=${from}&to=${now}&resolution=${timeRange.resolution}&aggregation=${useSum}`)
      .then((r) => r.json())
      .then(setHistoryData)
      .catch(() => setHistoryData({ raw: [], aggregated: [] }));
    
    setZoomDomain(null);
  }, [historySensor, range, timeOffsetMs]);

  useEffect(() => {
    setTimeOffsetMs(0);
  }, [historySensor, range]);

  // Handle mouse wheel zoom
  const handleWheel = (e, dataArray) => {
    if (!dataArray || dataArray.length < 2) return;
    e.preventDefault();

    const currentDomain = zoomDomain || [0, dataArray.length - 1];
    const zoomFactor = e.deltaY > 0 ? 0.8 : 1.2;
    const rangeSize = currentDomain[1] - currentDomain[0];
    const newSize = Math.max(5, Math.min(dataArray.length - 1, rangeSize * zoomFactor));
    const center = (currentDomain[0] + currentDomain[1]) / 2;
    const newStart = Math.max(0, Math.floor(center - newSize / 2));
    const newEnd = Math.min(dataArray.length - 1, newStart + newSize);

    setZoomDomain([newStart, newEnd]);
  };

  const handleResetZoom = () => {
    setZoomDomain(null);
    setTimeOffsetMs(0);
  };

  const handlePanStart = (e) => {
    e.preventDefault();
    panRef.current.active = true;
    panRef.current.startX = e.clientX;
    panRef.current.startOffset = timeOffsetMs;
    panRef.current.startDomain = zoomDomain ? [...zoomDomain] : null;
  };

  const handlePanMove = (e, dataArray, element) => {
    if (!panRef.current.active || !dataArray || dataArray.length < 2) return;

    const width = Math.max(1, element?.getBoundingClientRect().width ?? 1);
    const totalDeltaX = e.clientX - panRef.current.startX;

    if (panRef.current.startDomain) {
      const [start, end] = panRef.current.startDomain;
      const span = end - start;
      if (span >= dataArray.length - 1) return;

      const shiftBy = Math.round((-totalDeltaX / width) * (span + 1));
      const maxStart = dataArray.length - (span + 1);
      const nextStart = Math.max(0, Math.min(maxStart, start + shiftBy));
      setZoomDomain([nextStart, nextStart + span]);
      return;
    }

    const timeRange = TIME_RANGES[range];
    if (!timeRange.ms) return;
    const shiftMs = Math.round((-totalDeltaX / width) * timeRange.ms);
    setTimeOffsetMs(Math.max(0, panRef.current.startOffset + shiftMs));
  };

  const handlePanEnd = () => {
    if (!panRef.current.active) return;
    panRef.current.active = false;
  };

  // Setup pan and wheel event listeners
  useEffect(() => {
    const rawEl = rawChartRef.current;
    const aggEl = aggChartRef.current;

    const handleRawWheel = (e) => handleWheel(e, historyData.raw || []);
    const handleAggWheel = (e) => handleWheel(e, historyData.aggregated || []);
    const handleRawMouseDown = (e) => handlePanStart(e);
    const handleRawMouseUp = () => handlePanEnd();
    const handleRawMouseMove = (e) => handlePanMove(e, historyData.raw || [], rawEl);

    const handleAggMouseDown = (e) => handlePanStart(e);
    const handleAggMouseUp = () => handlePanEnd();
    const handleAggMouseMove = (e) => handlePanMove(e, historyData.aggregated || [], aggEl);

    if (rawEl) {
      rawEl.addEventListener("wheel", handleRawWheel, { passive: false });
      rawEl.addEventListener("mousedown", handleRawMouseDown);
      rawEl.addEventListener("mousemove", handleRawMouseMove);
      rawEl.addEventListener("mouseup", handleRawMouseUp);
      rawEl.addEventListener("mouseleave", handleRawMouseUp);
    }
    if (aggEl) {
      aggEl.addEventListener("wheel", handleAggWheel, { passive: false });
      aggEl.addEventListener("mousedown", handleAggMouseDown);
      aggEl.addEventListener("mousemove", handleAggMouseMove);
      aggEl.addEventListener("mouseup", handleAggMouseUp);
      aggEl.addEventListener("mouseleave", handleAggMouseUp);
    }

    return () => {
      if (rawEl) {
        rawEl.removeEventListener("wheel", handleRawWheel);
        rawEl.removeEventListener("mousedown", handleRawMouseDown);
        rawEl.removeEventListener("mousemove", handleRawMouseMove);
        rawEl.removeEventListener("mouseup", handleRawMouseUp);
        rawEl.removeEventListener("mouseleave", handleRawMouseUp);
      }
      if (aggEl) {
        aggEl.removeEventListener("wheel", handleAggWheel);
        aggEl.removeEventListener("mousedown", handleAggMouseDown);
        aggEl.removeEventListener("mousemove", handleAggMouseMove);
        aggEl.removeEventListener("mouseup", handleAggMouseUp);
        aggEl.removeEventListener("mouseleave", handleAggMouseUp);
      }
    };
  }, [zoomDomain, timeOffsetMs, historyData.raw, historyData.aggregated, range]);

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

  // Apply zoom filter to raw data
  const displayedRawData = useMemo(() => {
    if (!zoomDomain) return rawChartData;
    const [minIdx, maxIdx] = zoomDomain;
    return rawChartData.slice(Math.floor(minIdx), Math.ceil(maxIdx) + 1);
  }, [rawChartData, zoomDomain]);

  // Apply zoom filter to aggregated data
  const displayedAggData = useMemo(() => {
    if (!zoomDomain) return aggChartData;
    const [minIdx, maxIdx] = zoomDomain;
    return aggChartData.slice(Math.floor(minIdx), Math.ceil(maxIdx) + 1);
  }, [aggChartData, zoomDomain]);

  const [version, setVersion] = useState(null);
  useEffect(() => {
    fetch(`${API_BASE}/api/version`).then((r) => r.json()).then(setVersion).catch(() => {});
  }, []);

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>Home Dashboard</h1>
          <p>MQTT → SQLite → historik + live</p>
        </div>
        <HeaderClock />
        <div className={`status ${connected ? "up" : "down"}`}>{connected ? "Ansluten" : "Frånkopplad"}</div>
      </header>

      <div className="sections">
      {SENSOR_GROUPS.map((group) => (
        <section key={group.title} className={`section${group.wide ? " wide" : ""}`}>
          <h2>{group.title}</h2>
          <div className="grid">
            {group.sensors.map((sensor) => (
              <SensorCard key={sensor} item={latest[sensor]} />
            ))}
          </div>
          {group.extra === "ev" && <EvPanel ev={ev} />}
          {group.extra === "vacuum" && <VacuumPanel vacuum={vacuum} />}
          {group.extra === "electricity" && <ElectricityPanel electricity={electricity} />}
          {group.extra === "tuya" && <TuyaPanel tuya={tuya} />}
        </section>
      ))}
      </div>

      <section className="section">
        <div className="chart-head">
          <h2>Historik</h2>
          <select value={historySensor} onChange={(e) => setHistorySensor(e.target.value)}>
            {Object.keys(SENSOR_LABELS).map((sensor) => (
              <option key={sensor} value={sensor}>{SENSOR_LABELS[sensor]}</option>
            ))}
            {(tuya?.devices ?? []).flatMap((d) => [
              d.power_w !== null && [`tuya_${d.id}_effekt`, `${d.name} effekt`],
              d.energy_kwh !== null && [`tuya_${d.id}_energi`, `${d.name} energi`],
              d.temperature_c !== null && [`tuya_${d.id}_temp`, `${d.name} temperatur`],
              d.humidity !== null && [`tuya_${d.id}_fukt`, `${d.name} fukt`],
            ]).filter(Boolean).map(([sensor, label]) => (
              <option key={sensor} value={sensor}>{label}</option>
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

        {/* Zoom controls */}
        {(rawChartData.length > 0 || aggChartData.length > 0) && (
          <div style={{ marginBottom: "16px", textAlign: "right", minHeight: "40px" }}>
            <button
              onClick={handleResetZoom}
              disabled={!zoomDomain && timeOffsetMs <= 0}
              style={{
                border: "1px solid rgba(148,163,184,.3)",
                background: "#0e7490",
                color: "#e5e7eb",
                borderRadius: "10px",
                padding: "8px 16px",
                cursor: zoomDomain || timeOffsetMs > 0 ? "pointer" : "default",
                fontSize: "0.9rem",
                visibility: zoomDomain || timeOffsetMs > 0 ? "visible" : "hidden",
              }}
            >
              🔄 Återställ zoom
            </button>
          </div>
        )}

        {/* Raw/Momentan data chart */}
        {rawChartData.length > 0 && (
          <div 
            className="chart"
            ref={rawChartRef}
            style={{ cursor: "grab" }}
          >
            <h3 style={{ margin: "0 0 12px 0", fontSize: "1rem", color: "#cbd5e1" }}>Momentana värden</h3>
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={displayedRawData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="ts"
                  type="number"
                  domain={["dataMin", "dataMax"]}
                  tickFormatter={(value) => formatChartLabel(value, range)}
                  hide={displayedRawData.length > 40}
                />
                <YAxis />
                <Tooltip content={<CustomTooltip />} labelFormatter={(value) => formatChartLabel(value, range)} />
                <Legend />
                <Line type="monotone" dataKey="value" stroke="#6b8aa8" dot={false} strokeWidth={1} name="Värde" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Aggregated data chart */}
        {aggChartData.length > 0 && (
          <div 
            className="chart"
            ref={aggChartRef}
            style={{ cursor: "grab" }}
          >
            <h3 style={{ margin: "0 0 12px 0", fontSize: "1rem", color: "#cbd5e1" }}>Aggregerat per timme</h3>
            <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
              <button 
                className={chartType === "line" ? "active" : ""} 
                onClick={() => setChartType("line")}
                style={{
                  border: "1px solid rgba(148,163,184,.3)",
                  background: chartType === "line" ? "#0e7490" : "#111827",
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
                  background: chartType === "bar" ? "#0e7490" : "#111827",
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
                <BarChart data={displayedAggData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis
                    dataKey="ts"
                    type="number"
                    domain={["dataMin", "dataMax"]}
                    tickFormatter={(value) => formatChartLabel(value, range)}
                    hide={displayedAggData.length > 40}
                  />
                  <YAxis />
                  <Tooltip content={<CustomTooltip />} labelFormatter={(value) => formatChartLabel(value, range)} />
                  <Legend />
                  <Bar dataKey="value" fill="#22d3ee" name={historySensor === "regn" ? "Summa" : "Medel"} />
                </BarChart>
              ) : (
                <LineChart data={displayedAggData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis
                    dataKey="ts"
                    type="number"
                    domain={["dataMin", "dataMax"]}
                    tickFormatter={(value) => formatChartLabel(value, range)}
                    hide={displayedAggData.length > 40}
                  />
                  <YAxis />
                  <Tooltip content={<CustomTooltip />} labelFormatter={(value) => formatChartLabel(value, range)} />
                  <Legend />
                  <Line type="monotone" dataKey="value" stroke="#22d3ee" dot={false} strokeWidth={2} name={historySensor === "regn" ? "Summa" : "Medel"} />
                </LineChart>
              )}
            </ResponsiveContainer>
          </div>
        )}
      </section>
      {version && (
        <footer className="footer">
          Version {version.commit}
          {version.builtAt && ` · byggd ${new Date(version.builtAt).toLocaleString("sv-SE")}`}
          {` · startad ${new Date(version.startedAt).toLocaleString("sv-SE")}`}
        </footer>
      )}
    </div>
  );
}

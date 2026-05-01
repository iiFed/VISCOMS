const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

const AIRPORTS_CSV_URL =
  "https://davidmegginson.github.io/ourairports-data/airports.csv";

const RUNWAYS_CSV_URL =
  "https://davidmegginson.github.io/ourairports-data/runways.csv";

const METAR_URL =
  "https://aviationweather.gov/api/data/metar";

let airportCache = null;
let runwayCache = null;
let cacheLoadedAt = 0;

const CACHE_TIME_MS = 1000 * 60 * 60 * 24;
const METAR_REFRESH_MS = 1000 * 60 * 2;

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.redirect("/local");
});

app.get("/final", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "final.html"));
});

app.get("/local", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "local.html"));
});

function airportCode(raw) {
  return (
    String(raw || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 4) || "KNBC"
  );
}

function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i++;
      row.push(cell);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  const headers = rows.shift() || [];

  return rows.map((values) => {
    const item = {};
    headers.forEach((header, index) => {
      item[header] = values[index] || "";
    });
    return item;
  });
}

async function loadAirportData() {
  const cacheIsFresh =
    airportCache &&
    runwayCache &&
    Date.now() - cacheLoadedAt < CACHE_TIME_MS;

  if (cacheIsFresh) return;

  const [airportsResponse, runwaysResponse] = await Promise.all([
    fetch(AIRPORTS_CSV_URL),
    fetch(RUNWAYS_CSV_URL)
  ]);

  if (!airportsResponse.ok || !runwaysResponse.ok) {
    throw new Error("Could not download runway data.");
  }

  airportCache = parseCSV(await airportsResponse.text());
  runwayCache = parseCSV(await runwaysResponse.text());
  cacheLoadedAt = Date.now();
}

async function getRunwaysForAirport(code) {
  await loadAirportData();

  const airport = airportCache.find(
    (item) => item.ident.toUpperCase() === code
  );

  if (!airport) return [];

  const runways = runwayCache
    .filter((runway) => runway.airport_ref === airport.id)
    .flatMap((runway) => [runway.le_ident, runway.he_ident])
    .filter(Boolean)
    .map((runway) => runway.toUpperCase())
    .filter((runway) => runway !== "N/A")
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  return [...new Set(runways)];
}

function parseMetarWind(rawMetar) {
  const windMatch = rawMetar.match(/\b(\d{3}|VRB)(\d{2,3})(G\d{2,3})?KT\b/);

  if (!windMatch) {
    return "N/A";
  }

  const direction = windMatch[1];
  const speed = String(Number(windMatch[2]));
  const gust = windMatch[3]
    ? `G${String(Number(windMatch[3].replace("G", "")))}`
    : "";

  return `${direction}/${speed}${gust}`;
}

function parseMetarAltimeter(rawMetar) {
  const altimeterMatch = rawMetar.match(/\bA(\d{4})\b/);

  if (!altimeterMatch) {
    return "N/A";
  }

  const value = altimeterMatch[1];
  return `${value.slice(0, 2)}.${value.slice(2)}`;
}

async function getMetarForAirport(code) {
  const url =
    `${METAR_URL}?ids=${encodeURIComponent(code)}` +
    `&format=json&hours=2`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("Could not download METAR.");
  }

  const data = await response.json();

  if (!Array.isArray(data) || data.length === 0) {
    return {
      rawMetar: "NO METAR AVAILABLE",
      wind: "N/A",
      altimeter: "N/A",
      metarUpdatedAt: ""
    };
  }

  const latest = data[0];
  const rawMetar = latest.rawOb || latest.raw_text || latest.raw || "";

  return {
    rawMetar: rawMetar || "NO RAW METAR",
    wind: parseMetarWind(rawMetar),
    altimeter: parseMetarAltimeter(rawMetar),
    metarUpdatedAt: latest.obsTime || latest.reportTime || ""
  };
}

const airportState = {
  airport: "KNBC",
  runways: [],
  selectedRunway: "",
  wind: "N/A",
  altimeter: "N/A",
  rawMetar: "LOADING METAR",
  metarUpdatedAt: "",
  error: ""
};

function emptyAircraft(id) {
  return {
    id,
    type: "",
    intention: "",
    marker: "",
    status: "empty",

    localNeedsAck: false,
    localAcked: true,
    localAlertReason: "",
    localAlertVersion: 0,

    finalNeedsAck: false,
    finalAcked: true,
    finalAlertReason: "",
    finalAlertVersion: 0,

    pendingReset: false
  };
}

let aircraft = {
  AC1: emptyAircraft("AC1"),
  AC2: emptyAircraft("AC2"),
  AC3: emptyAircraft("AC3"),
  AC4: emptyAircraft("AC4")
};

const connectedUsers = {
  final: new Set(),
  local: new Set()
};

function broadcastOnlineStatus() {
  io.emit("onlineStatus", {
    finalOnline: connectedUsers.final.size > 0,
    localOnline: connectedUsers.local.size > 0
  });
}

function broadcastAirportState() {
  io.emit("airportState", airportState);
}

function broadcastAircraftState() {
  io.emit("aircraftState", aircraft);
}

function triggerLocalAck(id, reason) {
  aircraft[id].localNeedsAck = true;
  aircraft[id].localAcked = false;
  aircraft[id].localAlertReason = reason;
  aircraft[id].localAlertVersion += 1;
}

function triggerFinalAck(id, reason) {
  aircraft[id].finalNeedsAck = true;
  aircraft[id].finalAcked = false;
  aircraft[id].finalAlertReason = reason;
  aircraft[id].finalAlertVersion += 1;
}

async function refreshMetar() {
  try {
    const metar = await getMetarForAirport(airportState.airport);

    airportState.wind = metar.wind;
    airportState.altimeter = metar.altimeter;
    airportState.rawMetar = metar.rawMetar;
    airportState.metarUpdatedAt = metar.metarUpdatedAt;

    if (airportState.error === "Could not load current METAR.") {
      airportState.error = "";
    }

    broadcastAirportState();
  } catch (error) {
    airportState.wind = "N/A";
    airportState.altimeter = "N/A";
    airportState.rawMetar = "METAR LOAD ERROR";
    airportState.metarUpdatedAt = "";
    airportState.error = "Could not load current METAR.";

    broadcastAirportState();
  }
}

async function setAirport(code) {
  airportState.airport = airportCode(code);
  airportState.error = "";
  airportState.wind = "LOADING";
  airportState.altimeter = "LOADING";
  airportState.rawMetar = "LOADING METAR";
  airportState.metarUpdatedAt = "";

  try {
    airportState.runways = await getRunwaysForAirport(airportState.airport);
    airportState.selectedRunway = airportState.runways[0] || "";

    if (!airportState.runways.length) {
      airportState.error = `No runway data found for ${airportState.airport}.`;
    }
  } catch (error) {
    airportState.runways = [];
    airportState.selectedRunway = "";
    airportState.error = "Could not load runway data.";
  }

  broadcastAirportState();
  await refreshMetar();
}

function statusAfterFinalUpdate(currentStatus) {
  if (currentStatus === "cleared") return "cleared";
  if (currentStatus === "wave-off") return "wave-off";
  if (currentStatus === "reset-pending") return "reset-pending";
  return "pending";
}

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.emit("aircraftState", aircraft);
  socket.emit("airportState", airportState);
  broadcastOnlineStatus();

  socket.on("joinRole", (role) => {
    if (role === "final") {
      connectedUsers.final.add(socket.id);
      socket.role = "final";
    }

    if (role === "local") {
      connectedUsers.local.add(socket.id);
      socket.role = "local";
    }

    broadcastOnlineStatus();
  });

  socket.on("setAirport", async (code) => {
    await setAirport(code);
  });

  socket.on("setRunway", (runway) => {
    if (!airportState.runways.includes(runway)) return;

    airportState.selectedRunway = runway;
    airportState.error = "";
    broadcastAirportState();
  });

  socket.on("refreshMetar", async () => {
    await refreshMetar();
  });

  socket.on("finalUpdate", (data) => {
    const { id, type, intention, marker } = data;

    if (!aircraft[id]) return;

    const oldType = aircraft[id].type;
    const oldIntention = aircraft[id].intention;
    const oldMarker = aircraft[id].marker;
    const oldStatus = aircraft[id].status;

    aircraft[id] = {
      ...aircraft[id],
      id,
      type: type || "",
      intention: intention || "",
      marker: marker || "",
      status: statusAfterFinalUpdate(oldStatus),
      pendingReset: oldStatus === "reset-pending"
    };

    if (oldType !== type || oldIntention !== intention || oldMarker !== marker) {
      triggerLocalAck(id, "POSITION UPDATE");
    }

    broadcastAircraftState();
  });

  socket.on("localAction", (data) => {
    const { id, action } = data;

    if (!aircraft[id]) return;

    if (action === "clear") {
      aircraft[id].status = "cleared";
      aircraft[id].pendingReset = false;
      triggerFinalAck(id, "CLEARED");
    }

    if (action === "wave-off") {
      aircraft[id].status = "wave-off";
      aircraft[id].pendingReset = false;
      triggerFinalAck(id, "WAVE OFF");
    }

    broadcastAircraftState();
  });

  socket.on("localRequestReset", (id) => {
    if (!aircraft[id]) return;

    aircraft[id].status = "reset-pending";
    aircraft[id].pendingReset = true;
    triggerFinalAck(id, "RESET REQUEST");

    broadcastAircraftState();
  });

  socket.on("ackLocalUpdate", (id) => {
    if (!aircraft[id]) return;

    aircraft[id].localNeedsAck = false;
    aircraft[id].localAcked = true;
    aircraft[id].localAlertReason = "";

    broadcastAircraftState();
  });

  socket.on("ackFinalAction", (id) => {
    if (!aircraft[id]) return;

    if (aircraft[id].pendingReset) {
      aircraft[id] = emptyAircraft(id);
    } else {
      aircraft[id].finalNeedsAck = false;
      aircraft[id].finalAcked = true;
      aircraft[id].finalAlertReason = "";
    }

    broadcastAircraftState();
  });

  socket.on("finalResetAircraft", (id) => {
    if (!aircraft[id]) return;

    aircraft[id] = emptyAircraft(id);
    broadcastAircraftState();
  });

  socket.on("resetAll", () => {
    Object.keys(aircraft).forEach((id) => {
      aircraft[id] = emptyAircraft(id);
    });

    broadcastAircraftState();
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);

    connectedUsers.final.delete(socket.id);
    connectedUsers.local.delete(socket.id);

    broadcastOnlineStatus();
  });
});

setAirport("KNBC").catch(() => {});

setInterval(() => {
  refreshMetar().catch(() => {});
}, METAR_REFRESH_MS);

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Final Controller: http://localhost:${PORT}/final`);
  console.log(`Local Control:    http://localhost:${PORT}/local`);
});
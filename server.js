const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.redirect("/final");
});

app.get("/final", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "final.html"));
});

app.get("/local", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "local.html"));
});

function emptyAircraft(id) {
  return {
    id,
    type: "",
    intention: "",
    marker: "",
    status: "empty",

    // Local acknowledges updates sent by Final.
    localNeedsAck: false,
    localAcked: true,
    localAlertReason: "",
    localAlertVersion: 0,

    // Final acknowledges actions sent by Local.
    finalNeedsAck: false,
    finalAcked: true,
    finalAlertReason: "",
    finalAlertVersion: 0
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

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.emit("aircraftState", aircraft);
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

  socket.on("finalUpdate", (data) => {
    const { id, type, intention, marker } = data;

    if (!aircraft[id]) return;

    const oldType = aircraft[id].type;
    const oldIntention = aircraft[id].intention;
    const oldMarker = aircraft[id].marker;

    aircraft[id] = {
      ...aircraft[id],
      id,
      type: type || "",
      intention: intention || "",
      marker: marker || "",
      status: "pending"
    };

    if (oldType !== type || oldIntention !== intention || oldMarker !== marker) {
      triggerLocalAck(id, "POSITION UPDATE");
    }

    io.emit("aircraftState", aircraft);
  });

  socket.on("localAction", (data) => {
    const { id, action } = data;

    if (!aircraft[id]) return;

    if (action === "clear") {
      aircraft[id].status = "cleared";
      aircraft[id].type = "";
      aircraft[id].intention = "";
      aircraft[id].marker = "";
      triggerFinalAck(id, "CLEARED");
    }

    if (action === "wave-off") {
      aircraft[id].status = "wave-off";
      triggerFinalAck(id, "WAVE OFF");
    }

    io.emit("aircraftState", aircraft);
  });

  socket.on("ackLocalUpdate", (id) => {
    if (!aircraft[id]) return;

    aircraft[id].localNeedsAck = false;
    aircraft[id].localAcked = true;
    aircraft[id].localAlertReason = "";

    io.emit("aircraftState", aircraft);
  });

  socket.on("ackFinalAction", (id) => {
    if (!aircraft[id]) return;

    aircraft[id].finalNeedsAck = false;
    aircraft[id].finalAcked = true;
    aircraft[id].finalAlertReason = "";

    io.emit("aircraftState", aircraft);
  });

  socket.on("resetAircraft", (id) => {
    if (!aircraft[id]) return;

    aircraft[id] = emptyAircraft(id);
    io.emit("aircraftState", aircraft);
  });

  socket.on("resetAll", () => {
    Object.keys(aircraft).forEach((id) => {
      aircraft[id] = emptyAircraft(id);
    });

    io.emit("aircraftState", aircraft);
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);

    connectedUsers.final.delete(socket.id);
    connectedUsers.local.delete(socket.id);

    broadcastOnlineStatus();
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Final Controller: http://localhost:${PORT}/final`);
  console.log(`Local Control:    http://localhost:${PORT}/local`);
});
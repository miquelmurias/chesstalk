// ChessTalk — real-time session server
// All state lives in memory (nothing is persisted to any database).
// Each "room" has a 6-digit code, one host, and N participants.
//
// Participants are identified by a persistent token (not their socket.id),
// so a phone locking, losing signal, or reloading the page doesn't reset
// their name or remaining time — they simply reconnect as the same person.
//
// Note: user-facing strings (error messages, the fallback participant name)
// are intentionally kept in Catalan, since that's the language the app's
// end users (the family) actually use. Code, comments and logs are in
// English for readability on GitHub.

const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const DEFAULT_TIME = 180; // default seconds per participant
const rooms = {}; // code -> room

function generateCode() {
  let code;
  do {
    code = Math.floor(100000 + Math.random() * 900000).toString();
  } while (rooms[code]);
  return code;
}

function publicState(room) {
  return {
    code: room.code,
    speakerId: room.speakerId,
    queue: room.queue,
    defaultTime: room.defaultTime,
    locked: room.locked,
    participants: Object.values(room.participants).map((p) => ({
      id: p.id,
      name: p.name,
      remaining: p.remaining,
      total: p.total,
      connected: p.connected,
    })),
  };
}

function broadcastState(code) {
  const room = rooms[code];
  if (!room) return;
  io.to(code).emit("state", publicState(room));
}

// Whenever someone starts speaking, the hand-raise queue always resets.
// We notify ONLY the device of whoever starts speaking ("it's your turn").
function startSpeaking(code, participantId) {
  const room = rooms[code];
  if (!room) return;
  room.speakerId = participantId;
  room.queue = [];
  room.lowTimeWarned = false;
  io.to(participantId).emit("your-turn");
}

// When someone yields the floor: if there's anyone in the queue, they start
// speaking immediately (no need to press "Speak"). If not, the floor stays
// open.
function stopSpeaking(code) {
  const room = rooms[code];
  if (!room) return;
  room.speakerId = null;
  if (room.queue.length > 0) {
    const next = room.queue.shift();
    startSpeaking(code, next);
  }
}

// Only allows the action for whoever is actually the owning host of this room.
function assertHost(socket) {
  const code = socket.data.roomCode;
  const room = rooms[code];
  if (!room) return null;
  if (socket.data.role !== "host" || room.hostSocketId !== socket.id) return null;
  return room;
}

io.on("connection", (socket) => {
  socket.on("create-room", (opts, cb) => {
    cb = typeof cb === "function" ? cb : () => {};
    const code = generateCode();
    const defaultTime =
      opts && Number.isFinite(opts.defaultTime) && opts.defaultTime > 0
        ? Math.round(opts.defaultTime)
        : DEFAULT_TIME;

    rooms[code] = {
      code,
      hostSocketId: socket.id,
      participants: {},
      speakerId: null,
      queue: [],
      defaultTime,
      locked: false,
    };

    socket.join(code);
    socket.data.role = "host";
    socket.data.roomCode = code;

    cb({ ok: true, code });
    broadcastState(code);
  });

  // `token`, if provided, is the participant's persistent id from a previous
  // visit to this same room (saved on their device). If it still exists in
  // the room, this is a reconnection: we restore their name/time instead of
  // creating a brand-new participant.
  socket.on("join-room", ({ code, name, token } = {}, cb) => {
    cb = typeof cb === "function" ? cb : () => {};
    const room = rooms[code];
    if (!room) {
      cb({ ok: false, error: "Aquest codi de sessió no existeix." });
      return;
    }

    if (token && room.participants[token]) {
      const p = room.participants[token];
      p.connected = true;
      p.socketId = socket.id;
      const cleanName = (name || "").toString().trim().slice(0, 30);
      if (cleanName) p.name = cleanName;

      socket.join(code);
      socket.join(token);
      socket.data.role = "participant";
      socket.data.roomCode = code;
      socket.data.participantId = token;

      cb({ ok: true, code, id: token, total: p.total, remaining: p.remaining, reconnected: true });
      broadcastState(code);
      return;
    }

    if (room.locked) {
      cb({ ok: false, error: "La sessió ja ha començat i no s'hi pot unir ningú més." });
      return;
    }

    const id = crypto.randomUUID();
    const cleanName = (name || "").toString().trim().slice(0, 30) || "Anònim";

    room.participants[id] = {
      id,
      name: cleanName,
      remaining: room.defaultTime,
      total: room.defaultTime,
      connected: true,
      socketId: socket.id,
    };

    socket.join(code);
    socket.join(id);
    socket.data.role = "participant";
    socket.data.roomCode = code;
    socket.data.participantId = id;

    cb({ ok: true, code, id, total: room.defaultTime, remaining: room.defaultTime });
    broadcastState(code);
  });

  // Host only: toggles whether new participants can join with the code.
  // Reconnections of people who already joined are always allowed.
  socket.on("lock-room", () => {
    const room = assertHost(socket);
    if (!room) return;
    room.locked = true;
    broadcastState(room.code);
  });

  socket.on("unlock-room", () => {
    const room = assertHost(socket);
    if (!room) return;
    room.locked = false;
    broadcastState(room.code);
  });

  socket.on("press-speak", () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    const pid = socket.data.participantId;
    if (!room || socket.data.role !== "participant") return;
    if (room.speakerId !== null) return; // someone already has the floor
    if (!room.participants[pid]) return;
    startSpeaking(code, pid);
    broadcastState(code);
  });

  socket.on("press-stop", () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    const pid = socket.data.participantId;
    if (!room || room.speakerId !== pid) return;
    stopSpeaking(code);
    broadcastState(code);
  });

  socket.on("raise-hand", () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    const pid = socket.data.participantId;
    if (!room || socket.data.role !== "participant") return;
    if (room.speakerId === null || room.speakerId === pid) return;
    if (!room.queue.includes(pid)) room.queue.push(pid);
    // Notify ONLY the device of whoever is currently speaking.
    const raiser = room.participants[pid];
    io.to(room.speakerId).emit("hand-raised-notice", { name: raiser ? raiser.name : "Algú" });
    broadcastState(code);
  });

  socket.on("lower-hand", () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    const pid = socket.data.participantId;
    if (!room) return;
    room.queue = room.queue.filter((id) => id !== pid);
    broadcastState(code);
  });

  // Host only: sets a new total time for a given participant (and resets their clock).
  socket.on("set-participant-time", ({ participantId, minutes } = {}) => {
    const room = assertHost(socket);
    if (!room) return;
    const p = room.participants[participantId];
    if (!p) return;
    const secs = Math.max(5, Math.round((Number(minutes) || 0) * 60));
    p.total = secs;
    p.remaining = secs;
    broadcastState(room.code);
  });

  // Host only: resets a participant's clock back to their current total time.
  socket.on("reset-participant-time", ({ participantId } = {}) => {
    const room = assertHost(socket);
    if (!room) return;
    const p = room.participants[participantId];
    if (!p) return;
    p.remaining = p.total;
    broadcastState(room.code);
  });

  // Host only: removes a participant from the room entirely.
  socket.on("kick-participant", ({ participantId } = {}) => {
    const room = assertHost(socket);
    if (!room) return;
    const p = room.participants[participantId];
    if (!p) return;

    delete room.participants[participantId];
    room.queue = room.queue.filter((id) => id !== participantId);
    if (room.speakerId === participantId) stopSpeaking(room.code);

    io.to(participantId).emit("kicked");
    if (p.socketId) {
      const targetSocket = io.sockets.sockets.get(p.socketId);
      if (targetSocket) targetSocket.leave(room.code);
    }

    broadcastState(room.code);
  });

  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room) return;

    if (socket.data.role === "participant") {
      const pid = socket.data.participantId;
      const p = room.participants[pid];
      // Only mark them offline — never delete. Their name, remaining time
      // and place in the queue stay exactly as they were. If they were
      // speaking, their clock keeps counting down (like a real chess
      // clock); otherwise everything just waits for them to come back.
      if (p && p.socketId === socket.id) {
        p.connected = false;
      }
      broadcastState(code);
    } else if (socket.data.role === "host") {
      // The room becomes "orphaned" from its host but stays active for participants.
      room.hostSocketId = null;
    }
  });
});

// Authoritative countdown: only advances the clock of whoever currently has the floor.
setInterval(() => {
  for (const code in rooms) {
    const room = rooms[code];
    if (room.speakerId !== null) {
      const speakerId = room.speakerId;
      const speaker = room.participants[speakerId];
      if (speaker) {
        speaker.remaining = Math.max(0, speaker.remaining - 1);
        // Low-time warning, sent only to the speaker's own device, once per turn.
        if (speaker.remaining <= 10 && speaker.remaining > 0 && !room.lowTimeWarned) {
          room.lowTimeWarned = true;
          io.to(speakerId).emit("low-time-warning", { remaining: speaker.remaining });
        }
        if (speaker.remaining === 0) {
          stopSpeaking(code);
        }
      }
      broadcastState(code);
    }
  }
}, 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`ChessTalk listening on port ${PORT}`);
});

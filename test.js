// Manual test script: spins up a short-lived server on port 3999 and
// simulates a host + participants to verify turn-taking, host controls
// (custom time, reset, kick) and that notifications only reach the
// right device.
const { spawn } = require("child_process");
const { io } = require("socket.io-client");

const PORT = 3999;
const server = spawn("node", ["server.js"], {
  cwd: __dirname,
  env: { ...process.env, PORT },
  stdio: "inherit",
});

let passCount = 0, failCount = 0;
function check(label, condition, extra) {
  if (condition) { passCount++; console.log(`  ✅ ${label}`); }
  else { failCount++; console.log(`  ❌ ${label}${extra ? " — " + extra : ""}`); }
}

function connect() {
  return io(`http://localhost:${PORT}`, { transports: ["websocket"] });
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  await wait(800);

  const host = connect();
  let roomCode;
  let lastHostState = null;
  host.on("state", (s) => { lastHostState = s; });

  await new Promise((resolve) => {
    host.emit("create-room", { defaultTime: 5 }, (res) => {
      roomCode = res.code;
      console.log(`\n=== Room created: ${roomCode} (5s default) ===`);
      resolve();
    });
  });

  const alice = connect(), bob = connect(), carla = connect();
  let aliceId, bobId, carlaId;

  const aliceEvents = [], bobEvents = [], carlaEvents = [];
  ["your-turn", "hand-raised-notice", "low-time-warning", "kicked"].forEach((ev) => {
    alice.on(ev, (p) => aliceEvents.push([ev, p]));
    bob.on(ev, (p) => bobEvents.push([ev, p]));
    carla.on(ev, (p) => carlaEvents.push([ev, p]));
  });

  await new Promise((r) => alice.emit("join-room", { code: roomCode, name: "Alice" }, (res) => { aliceId = res.id; r(); }));
  await new Promise((r) => bob.emit("join-room", { code: roomCode, name: "Bob" }, (res) => { bobId = res.id; r(); }));
  await new Promise((r) => carla.emit("join-room", { code: roomCode, name: "Carla" }, (res) => { carlaId = res.id; r(); }));
  await wait(200);

  console.log("\n--- Basic turn-taking ---");
  alice.emit("press-speak");
  await wait(200);
  check("Alice speaks after pressing 'Speak'", lastHostState.speakerId === aliceId);
  check("Alice receives her own 'your-turn' notice", aliceEvents.some(([e]) => e === "your-turn"));
  check("Bob does NOT receive Alice's 'your-turn'", !bobEvents.some(([e]) => e === "your-turn"));

  carla.emit("raise-hand"); // Carla is the only one in the queue
  await wait(200);
  check("Alice (speaking) gets 'hand-raised-notice' when Carla raises her hand", aliceEvents.some(([e]) => e === "hand-raised-notice"));
  check("Bob does NOT get 'hand-raised-notice' (he's not speaking)", !bobEvents.some(([e]) => e === "hand-raised-notice"));

  console.log("\n--- Per-participant time (host) ---");
  host.emit("set-participant-time", { participantId: carlaId, minutes: 2 });
  await wait(200);
  const carlaAfterSet = lastHostState.participants.find(p => p.id === carlaId);
  check("Carla's time is set to 120s (total and remaining)", carlaAfterSet.total === 120 && carlaAfterSet.remaining === 120, JSON.stringify(carlaAfterSet));

  console.log("\n--- Low time + automatic hand-off to the queue ---");
  await wait(4300); // Alice had 5s total
  check("Alice's time ran out and Carla (only one queued) starts speaking automatically", lastHostState.speakerId === carlaId, `speakerId=${lastHostState.speakerId}`);
  check("Alice received 'low-time-warning' (she was speaking)", aliceEvents.some(([e]) => e === "low-time-warning"));
  check("Bob did NOT receive 'low-time-warning'", !bobEvents.some(([e]) => e === "low-time-warning"));
  check("Carla received 'your-turn' when she started speaking automatically", carlaEvents.some(([e]) => e === "your-turn"));
  check("Bob did NOT receive 'your-turn'", !bobEvents.some(([e]) => e === "your-turn"));
  check("The hand-raise queue reset once Carla started speaking", lastHostState.queue.length === 0);

  console.log("\n--- Resetting a participant's clock ---");
  await wait(1500); // Carla has been speaking for ~1.5s out of her 2 minutes
  carla.emit("press-stop");
  await wait(200);
  const carlaBeforeReset = lastHostState.participants.find(p => p.id === carlaId);
  check("Carla's remaining time dropped below her total before resetting", carlaBeforeReset.remaining < carlaBeforeReset.total, JSON.stringify(carlaBeforeReset));
  host.emit("reset-participant-time", { participantId: carlaId });
  await wait(200);
  const carlaAfterReset = lastHostState.participants.find(p => p.id === carlaId);
  check("Resetting Carla's clock brings her back to her total (120s)", carlaAfterReset.remaining === 120 && carlaAfterReset.total === 120);

  console.log("\n--- Kicking a participant ---");
  host.emit("kick-participant", { participantId: bobId });
  await wait(300);
  check("Bob no longer appears in the participant list", !lastHostState.participants.some(p => p.id === bobId));
  check("Bob received the 'kicked' event", bobEvents.some(([e]) => e === "kicked"));

  console.log("\n--- Security: a participant cannot perform host actions ---");
  alice.emit("kick-participant", { participantId: carlaId }); // alice is NOT the host
  await wait(200);
  check("Alice CANNOT kick Carla (she's not the host)", lastHostState.participants.some(p => p.id === carlaId));
  alice.emit("set-participant-time", { participantId: carlaId, minutes: 99 });
  await wait(200);
  check("Alice CANNOT change Carla's time (she's not the host)", lastHostState.participants.find(p => p.id === carlaId).total === 120);

  console.log("\n--- Reconnecting keeps your name and remaining time ---");
  const aliceRemainingBefore = lastHostState.participants.find(p => p.id === aliceId).remaining;
  alice.close();
  await wait(300);
  check("Alice shows as disconnected but is NOT removed", lastHostState.participants.some(p => p.id === aliceId && p.connected === false));
  const aliceReconnect = connect();
  const aliceReconnectEvents = [];
  ["your-turn", "hand-raised-notice", "low-time-warning", "kicked"].forEach((ev) => {
    aliceReconnect.on(ev, (p) => aliceReconnectEvents.push([ev, p]));
  });
  const reconnectRes = await new Promise((r) => aliceReconnect.emit("join-room", { code: roomCode, name: "Alice", token: aliceId }, r));
  await wait(200);
  check("Reconnecting with the same token returns the same participant id", reconnectRes.ok && reconnectRes.id === aliceId);
  check("Reconnecting does NOT reset time back to the room default (5s)", lastHostState.participants.find(p => p.id === aliceId).remaining === aliceRemainingBefore, `before=${aliceRemainingBefore} after=${lastHostState.participants.find(p => p.id === aliceId).remaining}`);
  check("Alice shows as connected again", lastHostState.participants.find(p => p.id === aliceId).connected === true);

  console.log("\n--- Locking the room ---");
  host.emit("lock-room");
  await wait(200);
  check("Room reports locked = true", lastHostState.locked === true);

  const dave = connect();
  const daveJoinRes = await new Promise((r) => dave.emit("join-room", { code: roomCode, name: "Dave" }, r));
  check("A brand-new participant CANNOT join a locked room", daveJoinRes.ok === false, JSON.stringify(daveJoinRes));

  const carlaReconnect = connect();
  const carlaReconnectRes = await new Promise((r) => carlaReconnect.emit("join-room", { code: roomCode, name: "Carla", token: carlaId }, r));
  check("An existing participant CAN still reconnect while the room is locked", carlaReconnectRes.ok === true);

  host.emit("unlock-room");
  await wait(200);
  check("Room reports locked = false after unlocking", lastHostState.locked === false);
  const daveJoinRes2 = await new Promise((r) => dave.emit("join-room", { code: roomCode, name: "Dave" }, r));
  check("A new participant CAN join once unlocked", daveJoinRes2.ok === true);

  console.log(`\n=== RESULT: ${passCount} passed / ${failCount} failed ===`);
  alice.close(); bob.close(); carla.close(); host.close();
  aliceReconnect.close(); dave.close(); carlaReconnect.close();
  server.kill();
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  server.kill();
  process.exit(1);
});

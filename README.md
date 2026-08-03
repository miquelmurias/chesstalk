# ChessTalk

A chess-clock-style moderator for family debates. Node.js + Socket.io server with real-time shared state (nothing is persisted to a database; everything lives in memory while the server is running).

> **Note on languages:** the codebase, comments and this README are in English. The app's user interface (buttons, messages, notes) is intentionally in Catalan, since that's the language the actual users — the family — speak. Feel free to translate the UI strings in `public/host.html` and `public/user.html` if you want a different language; the server logic doesn't depend on them.

## Try it on your computer

You need [Node.js](https://nodejs.org) installed (version 18 or newer).

```bash
cd chesstalk
npm install
npm start
```

Open `http://localhost:3000` in your browser:

- **Host** (`/host.html`): creates the session and shows the control board with all participants.
- **Participant** (`/user.html`): join with the 6-digit code the host gives you.

For other people at home to join from their phones, everyone needs to be on the same Wi-Fi network, and you'll need to replace `localhost` with the local IP of the computer acting as the server (e.g. `http://192.168.1.23:3000`).

## How the turn-taking works

- If nobody is speaking, anyone can press **Speak** and their clock starts counting down.
- While someone is speaking, everyone else can only **raise their hand**. The Speak button is disabled so no one can interrupt.
- When the speaker presses **Stop**: if someone has their hand raised, that person starts speaking automatically (no need to press anything). If nobody does, the floor stays open and all clocks pause until someone wants to speak.
- Every time someone starts speaking, the hand-raise queue resets (everyone has to raise their hand again for the next turn).

## Host controls

The host board has a **⚙️ Controls** button that shows/hides a panel for each participant:

- **Save time**: sets a new total time (in minutes) for that person and resets their clock to the new value.
- **Reset clock**: brings the remaining time back to the current total, without changing it.
- **Kick**: removes the person from the session. Their device returns to the join screen with a notice.

Hide this panel before projecting the screen, so the audience only sees the clean view (speaker, queue, and everyone's time in large text).

## Staying connected

Each participant's browser saves a small, private token for the session (in `localStorage`, nothing sent to any server but this one). If their phone locks, loses signal, or the tab reloads, the app automatically rejoins as the *same* person as soon as it reconnects — same name, same remaining time, same place in the queue. Nothing resets to the default time just because someone went quiet for a while.

If they were actually removed (kicked) or that session is no longer valid, they simply see the join screen again.

## Locking the session

Once the debate starts, the host can press **🔓 Bloquejar sessió** on the dashboard to stop new people from joining with the code. Anyone already in the session can still reconnect normally (see above) even while locked — locking only blocks brand-new joiners. Press it again to unlock.

## Per-device alerts

Each participant hears/sees, only on their own phone (sound + a brief on-screen message):

- 🎙️ **It's your turn**: when they start speaking, whether they pressed "Speak" or the turn reached them automatically from the queue.
- ✋ **Someone wants in**: when they're speaking and someone else raises their hand.
- ⏳ **Low on time**: when they're speaking and have 10 seconds or less left.

The first tap (joining the session) unlocks the browser's audio, as required by mobile browsers.

## Automated tests

`test.js` spins up a short-lived server and simulates several participants to verify all the turn-taking logic (speaking, raising/lowering hands, automatic hand-off, clocks pausing when nobody speaks, auto-stop when time hits 0), the host controls (custom time, reset, kick), reconnecting without losing your remaining time, and locking the room. Run it with:

```bash
npm install --include=dev
node test.js
```

## Publishing it online (free, with Render)

The project is already set up for deployment (`render.yaml`, `.gitignore`, pinned Node version). Steps:

1. **Create a [GitHub](https://github.com) account** if you don't have one (free).
2. **Create a new, empty repository** on GitHub (e.g. `chesstalk`), without adding any initial files.
3. **Push the code** from your computer, inside the `chesstalk` folder:
   ```bash
   cd chesstalk
   git init
   git add .
   git commit -m "ChessTalk"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/chesstalk.git
   git push -u origin main
   ```
4. **Create a [Render](https://render.com) account** (you can sign in directly with your GitHub account).
5. In Render: **New +** → **Web Service** → connect the `chesstalk` repository you just pushed.
6. Render should auto-detect `render.yaml` and configure everything (build: `npm install`, start: `npm start`). If not, fill it in manually with those same values.
7. Click **Create Web Service**. Within a couple of minutes you'll have a fixed URL like `https://chesstalk.onrender.com` — this is the address you'll share with the family to join, and where the host will create sessions.

Note: on Render's free tier, the server "falls asleep" if unused for a while and takes a few seconds to wake up the first time someone visits. This usually isn't a problem for family use.

Once published, if you ever want a short, custom link (e.g. `chesstalk.cat` instead of `chesstalk.onrender.com`), you can buy a domain and point it at Render from its settings panel — this is optional and not required for it to work.

## Other possible improvements down the line

- Configurable delay before the Render server falls asleep.
- A history or summary of the debate once it's over.
- Letting the host temporarily pause the whole session.

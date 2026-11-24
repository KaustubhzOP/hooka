# Virtual Hookah 🫧

A camera-based AR toy: hold a **real pen** like a hookah mouthpiece, and your lips, nose, head and hands drive a
virtual hookah: inhale, hold, then blow smoke, rings, dragon puffs, ghosts and waterfalls.

> **Just for fun, no smoking involved.** No tobacco, no real smoke, just pixels.

- Face, hand and background tracking run **in your browser** (MediaPipe, WebAssembly). **No video leaves your device**: nothing is uploaded and there is no server-side code.
- Works on desktop Chrome / Edge and on phones and tablets (Chrome on Android, Safari on iOS). Needs `https` or `localhost` for the camera.
- Works offline once installed: the WASM runtime and models are served from `public/`.

## Run it

Requires Node 18+ (20+ recommended).

```bash
npm install
```

```bash
npm run dev
```

Open <http://localhost:5173> and click **Start camera**.

`npm install` runs `scripts/setup-assets.mjs` (postinstall), which copies the MediaPipe WASM runtime into
`public/mediapipe/wasm/` and downloads the official models into `public/models/`: `face_landmarker.task`,
`hand_landmarker.task` (both float16) and `selfie_segmenter.tflite` (for background swap). If the download failed,
run `npm run setup-assets` again.

**On a phone:** the camera needs `https`, so test the deployed site, or run `npm run dev -- --host` and open it through
an https tunnel. Plain `http://192.168…` won't get camera access.

| command | what it does |
|---|---|
| `npm test` | Vitest unit tests (state machine, signals, calibration, settings, game, coals) |
| `npm run typecheck` | TypeScript, no emit |
| `npm run build` / `npm run preview` | production build in `dist/` (a static site) and a local preview |

## How to play

1. **Calibrate first** (button or `C`): four 3-second steps: relax · sip with the pen at your lips · make an “O” · scrunch your nose. Skip any step with **Skip** / `Space`.
2. **Inhale:** pen at your lips, sip. A cyan ring fills, the water bubbles, the coals glow.
3. **Hold:** relax your lips. The ring turns amber and counts down. Then pick a trick:

| trick | how | |
|---|---|---|
| **Blow** | purse your lips, mouth nearly closed | longer inhale = bigger exhale; turn your head to aim |
| **Smoke rings** | make an **“O”** (lips round, jaw open); close and “O” again for the next | each ring uses 0.6 s of smoke; combos score more |
| **Dragon** | **scrunch your nose** | all the smoke comes out of your nostrils |
| **Nose smoke** | automatic | a share of every normal exhale streams from the nose (*Nose smoke* slider) |
| **French inhale** | tilt your **head back** with your mouth **slightly open** | smoke flows from your lower lip up into your nose |
| **Ghost** | open your mouth **wide** | a ball of smoke rolls out; **sip** within ~2 s to pull it back in, or it floats away |
| **Waterfall** | tilt your **head down** while blowing | the smoke pours down off your lip, then lifts |
| **Bend the smoke** | wave your hand through it, or blow at it after an exhale | the smoke swirls with your hand / gets pushed away |

Hold too long (default 6 s) and you cough. A too-short inhale (< 0.5 s) doesn't count.

The **chips** at the top of the video (Face · Pen · Sip · O · Scrunch · Head) show what the camera sees right now:
if a gesture doesn't work, watch its chip.

**Try it** buttons (and keys) play every effect without a camera; they don't score.

### Hookah, scene and game

- **Flavours** (`1`–`9`): Classic white, Mint, Grape, Watermelon, Blueberry, Peach, Double apple, Neon pink (glow), Dragon fire (glow). Each one sets the smoke colour *and* the water colour. Custom colour picker, plus density, speed, spread and nose-smoke sliders.
- **Hookah skins:** Classic, Crystal (cut glass), LED (colour-cycling light) and Amber vases; five hose colours; coal power.
- **Coals burn down:** heat drops and ash builds up as you smoke, so the smoke gets thinner. **Flip the coals** by touching the bowl with your fingers on camera, tapping it on screen, the button, or `X`. Fuel runs out over a session; *Fresh coals* resets it.
- **Lighting:** the coals light up the smoke and your face (brighter while you pull); the LED vase adds coloured light.
- **Background swap:** Camera, Blur, Lounge or Neon bar. You're cut out with MediaPipe selfie segmentation, on your device.
- **Play tab:** ring challenge (combo counter, best rings per inhale, total rings, longest hold, best score), 16 achievements, and **2-player mode**: Player 1 on the left, Player 2 on the right; the hose and the tracking pass to the other player after each hit.

### Keys

`1`–`9` flavour · `C` calibrate (`Space` skip step, `Esc` cancel) · `T` smoke · `O` ring · `N` nose · `G` ghost ·
`F` French · `W` waterfall · `X` flip coals · `R` reset · `D` debug · `L` landmarks · `M` mute

## Accuracy: what was done, and how to tune

- **Personal calibration** for every gesture: the sip threshold sits halfway between your relaxed face and your sip (measured *with the pen at your lips*, which matters because the pen changes the lip shape). The ring thresholds sit between your relaxed face and your “O”, and the ring jaw threshold sits between your sip and your “O”, so sips and O's can't be confused. The scrunch threshold works the same way. Your neutral head pitch becomes the zero for French inhale and waterfall.
- **Smoothing + hysteresis** on every gesture channel (sip, O, scrunch), so noisy blendshapes don't flicker.
- **Pen detection** is more forgiving: any of the grip point, the extended pen tip, or the thumb / index / middle fingertips near the lips counts. Hand detection confidence is lowered (hands at the mouth are half hidden by the face), and there's a 600 ms grace period.

Debug panel (`D`): live bars for every signal, with red marks at the thresholds, a slider for each threshold, an event log with
reasons, FPS, and a landmark overlay (`L`: lips, nostrils, hands, pen estimate).

| slider | raise it if… | lower it if… |
|---|---|---|
| **Sip / blow** (`blowOn`) | inhale/blow trigger with relaxed lips | sipping isn't recognised |
| **Pen near** (faces) | the pen isn't recognised at your lips | it triggers with the hand far away |
| **Pen length** (hands) | you hold the pen far back from its tip | you hold it close to the tip |
| **Ring: funnel / jaw open** | a normal blow turns into rings | your “O” doesn't make rings |
| **Nose: scrunch** | dragon fires by accident | scrunching doesn't trigger it |
| **French: tilt up° / Waterfall: tilt down°** | they trigger without meaning to | you have to tilt a lot |
| **Max inhale / Max hold** (s) | | |

## How it works

```
camera ─► tracking.ts ─► signals.ts ─► machine.ts ─► effects.ts ─► smoke.ts (WebGL)
          MediaPipe       smoothed       IDLE/INHALING/  smoke         hookah.ts, lighting.ts (2D)
          face, hands     gestures,      HOLDING/GHOST/  director      background.ts (segmentation)
          segmentation    head pitch,    EXHALING + tricks             audio.ts, game.ts, ui.ts
                          pen estimate
```

| file | role |
|---|---|
| `src/tracking.ts` | camera (lighter profile on phones), Face Landmarker (blendshapes, 1 or 2 faces) + Hand Landmarker, GPU with CPU fallback, typed errors |
| `src/signals.ts` | blow/funnel/jaw/sneer smoothing, head pitch, mouth & nostrils, pen estimate, hand motion, face selection for 2 players |
| `src/machine.ts` | pure state machine with tricks (rings, nose, French, ghost, cough), hysteresis |
| `src/calibration.ts` | 4-step personal calibration, pure |
| `src/effects.ts` | where and how smoke is emitted for each gesture; wind and hand stirring |
| `src/smoke.ts`, `src/noise.ts` | Three.js smoke: instanced puffs, curl-noise physics, groups (ghost, French), per-puff buoyancy (waterfall), coal light in the shader, adaptive particle cap |
| `src/presets.ts` | flavours, vase skins, hose colours: plain objects, add one and it appears |
| `src/hookah.ts` | 2D hookah: skins, flavour water, bubbles, coals (burn, ash, flip), Bézier hose following the pen |
| `src/lighting.ts` | coal / LED light on the scene and your face (`mix-blend-mode: screen`) |
| `src/background.ts` | selfie segmentation + procedural lounge / neon bar / blur backdrops |
| `src/game.ts` | scoring, ring combos, achievements, 2-player turns, persisted stats |
| `src/audio.ts` | Web Audio, all procedural: bubbling, whoosh, cough, ring pop, slurp, coal crackle |
| `src/ui.ts` | DOM: tabs, controls, HUD chips, toasts, cards, ring & landmark drawing |
| `src/backend/supabase.ts` | Supabase client, auth helpers, typed database calls, error messages |
| `src/social/*` | account store, sign-in / username / profile screens, leaderboard, friends, modal helpers |
| `src/online/match.ts` | pure online match rules (turns, rounds, timer, standings) |
| `src/online/room.ts` | room channel: presence, match events, host hand-over, call signalling |
| `src/online/rtc.ts` | WebRTC mesh (perfect negotiation, STUN/TURN) |
| `src/online/controller.ts` | lobby, room panel, call tiles, compositing your stage into the call video |
| `supabase/migrations/*.sql` | the whole backend: tables, RLS, functions, realtime policies |
| `src/main.ts` | wiring and the frame loop |

**Layers:** video → backdrop (when on) → light → smoke (WebGL) → hookah + hose, ring, debug (2D) → HTML UI.

## Accounts, leaderboard, friends and online play

Solo play works without an account. Sign in (Google or email + password) to:

- **Pick a unique username** (3–20 letters, numbers, `_`; case-insensitive; live availability check; change it once a week) and an avatar.
- **Save runs to the leaderboard**: *Play → Finish & save run* (runs also save when you close the tab). Boards: this week / all time, everyone / friends.
- **Friends**: search by username, send / accept / decline requests, remove, block, report. Badges show new requests and room invites in real time.
- **Play online** (🌐): create a room (2–5 players), invite friends or share the link / 8-letter code. Modes:
  - **🪈 Pass the hookah**: one player at a time; the hose passes after each hit; everyone watches.
  - **⚡ Live challenge**: everyone at once, 45 s per round.
  - Challenges: highest score, most rings, longest hold, most tricks. Results are saved to the leaderboard.
- **Video call** (🎥 Join call): you see and hear each other; each tile shows that player's camera *with their smoke and hookah*.
- **Same device** (Play → Same device): 2–4 players in front of one camera, left to right, taking turns.

### Backend (Supabase)

Everything lives in `supabase/migrations/` (one SQL file) and is applied to the project with the Supabase CLI
(`supabase db push`) or the SQL editor. The frontend only knows the **publishable** key (`.env`); never put the
secret / service-role key in the frontend or the repo.

| table | holds |
|---|---|
| `profiles` | username (unique), avatar, last seen |
| `friendships` | requests, friendships, blocks |
| `rooms`, `room_members`, `room_invites` | online rooms (2–5 seats), invites |
| `game_sessions`, `scores` | server-side game sessions and checked results |
| `reports` | user reports (readable only by admins) |

**Security**
- Supabase Auth issues short-lived JWT access tokens (auto-refreshed); Postgres reads the user from the JWT (`auth.uid()`).
- Row-level security on every table; clients have **no direct write access**. Every write goes through a `security definer` function that validates input, checks permissions (owner, friend, room member, host) and rate-limits per user.
- Scores are checked for plausibility against a server-side session clock (max hits per second, rings per inhale, points per hit, hold length). A camera game scored on the client can't be fully cheat-proof, but this stops casual cheating.
- Online rooms use **private** Realtime channels: only room members can join (`realtime.messages` policies).
- Room codes are random, unguessable; only friends can be invited; blocked users can't find you or join your rooms.
- Video and audio go peer-to-peer (WebRTC) and are never stored. Account deletion removes all your data.

**Tests:** `supabase/tests/run.sh -h <socket dir> -p <port> -U postgres` runs the migration (twice) and ~70 security / behaviour checks against a throw-away Postgres with a Supabase stub.

### One-time setup in the Supabase dashboard

1. **Google sign-in** (free): Google Cloud Console → APIs & Services → Credentials → *Create OAuth client ID* (Web application), authorised redirect URI `https://<project>.supabase.co/auth/v1/callback`. Paste the client ID and secret into Supabase → Authentication → Sign In / Providers → Google, and enable it. Publish the OAuth consent screen so anyone can sign in.
2. **URL configuration** (Authentication → URL Configuration): site URL and redirect URLs must include where the app runs (already set for `http://localhost:5173`; add the production URL when deploying).
3. **Emails**: Supabase's built-in email sender is limited to a few emails per hour (fine for testing). For real users, add a free SMTP provider (e.g. Resend or Brevo free tiers) under Authentication → Emails → SMTP.
4. **Calls on mobile data** (optional): set `VITE_TURN_URLS`, `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL` in `.env` / the host's env to a TURN relay (free tiers: Metered.ca, Cloudflare). Without it calls use free public STUN servers, which work on most Wi-Fi.

## Deploying

`npm run build` produces a static site in `dist/` (the models and WASM are copied in from `public/`). Any static host
works: the build command is `npm install && npm run build`, and the output directory is `dist`. Vercel and Render configs will be added when we deploy.

## Known limitations

- **The pen itself is never seen.** Any hand near the mouth counts as the pen. Enable *Require a pinch grip* (Debug) to reduce this.
- **Gestures are read from blendshapes**, which vary with faces, beards, lighting and camera angle. Calibrate, and use even, frontal light. The camera can't see airflow: an “O” makes a ring whether or not you actually puff.
- **Head pitch** comes from the forehead/chin depth estimate and is only roughly calibrated: adjust the tilt sliders if French/waterfall trigger too easily or too rarely.
- **Occlusion:** a hand or arm covering much of the face can make face tracking drop out; the grace periods only bridge short gaps.
- **2D only:** the smoke is a screen-space effect and won't go behind your head or hand.
- **Background swap** is a soft cut-out; hair edges can bleed, and it costs frame rate, especially on phones.
- **2 players** need both faces fully in frame. Player 1 is whoever is on the left of the screen.
- **Online:** video calls are a mesh (each player sends to every other), so 5 players means 4 uploads each: fine on Wi-Fi, heavy on phones. Without a TURN relay some mobile networks can't connect.
- **Score checks** stop implausible scores but can't prove a hit really happened on camera.
- **Phones:** performance varies a lot; the particle count drops automatically when FPS is low. iOS needs Safari 15+.

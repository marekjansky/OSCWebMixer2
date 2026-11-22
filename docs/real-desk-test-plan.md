# Real-desk test plan

Behaviour that can only be verified against a real DiGiCo SD/Quantum desk, real iPads and the real
deployment. Everything else is covered by `npm test` and the mock desk.

**Setup:** turn on Debug in `/admin` (server log shows every OSC message), keep `/admin` → Status open,
and have at least two iPads connected, one of them locked to an aux. Tick each item and note the result.

## 0. Findings from the Quantum software (2026-11-22, Quantum3 offline on Windows)

Verified against the Quantum offline software (OSC Pad: receive 9000, send 8100):

- **Send on/off is `/Input_Channels/{ch}/Aux_Send/{aux}/send_on`, a FLOAT 0 or 1.** Sending an OSC
  *integer* 1 makes Quantum store 1.4e-45 (it reads the int bits as a float). The server sends every
  number as a float (osc.js default), so this works; never send typed ints to the desk.
- **Pan is 0..1 with centre 0.5** (default on mono and stereo auxes is 0.5; 0 and 1 are accepted).
  Quantum does not clamp: it stores -1 if sent -1, so the server's 0..1 clamp matters.
- Level is a float in dB (-150 = off).
- `/Console/Channels/?` answers with all counts (inputs, auxes, groups, matrix, ...).
- No snapshot loaded -> `/Snapshots/Current_Snapshot` is -1.
- The software binds both its receive port AND its send port on 0.0.0.0. To test on the same PC,
  bind the server (or a relay) to 127.0.0.1 on the send port; see the scratch relay approach.

Also verified in Quantum:

- **Renames are pushed live.** Renaming a channel or an aux sends
  `/Input_Channels/N/Channel_Input/name` / `/Aux_Outputs/N/Buss_Trim/name` straight away, without a
  query. The server flags the change (admin banner, mixer marker, locks on that aux suspended).
- **A restructure sends `/Console/Session/!`.** While the engineer restructures, the desk stops
  answering for a few seconds, so the server shows "desk not responding" briefly, then the session
  message triggers a full reload without disconnecting anyone.
- **Restructures renumber auxes.** Adding two stereo auxes kept the count at 16 (they used free aux
  slots) but inserted them at 1 and 3, shifting every aux after them. "Follow the moved auxes" in the
  admin banner moved the colour, icon, layout and a locked device of "Snare Long Verb" from aux 2 to
  aux 4 in one click; the new auxes 1 and 3 started fresh.
- **All sends ON / OFF for an aux** (admin) switched all 96 sends of an aux on and off; Quantum echoed
  every one.
- Aux names can start with a space (" Snare Short Verb"); names are compared ignoring extra spaces.
- With 16 automatic colours, every aux gets a different one (two auxes shared a colour before).

Still to check on a real desk / in Quantum:

- [ ] **Does the desk push send on/off changes?** Switch a send on at the desk while a mixer shows that
      aux: the ON button should light within a moment.
- [ ] **Reply address.** With a desk that has two network ports, there should be no
      "Received desk messages … from X" warning. If there is, the desk replies from another IP.

## 1. Desk connection

- [ ] **Liveness polling.** Leave the server running for 2 min. The desk answers `/Console/Channels/?`
      every 5 s, the status stays online, and neither the desk nor the DiGiCo iPad app slows down.
- [ ] **Start without the desk.** Start the server with the desk off or unplugged. Mixers show
      "Waiting for mixing desk…" (not a dead page), the admin shows the "Waiting" banner, and the log
      warns every 30 s with the desk IP:port. Turn the desk on: everything loads by itself.
- [ ] **Desk drops mid-show.** Pull the desk network cable. Within ~11 s: log "not responding", red
      banner on mixers and admin, faders dimmed. Make a change on the desk meanwhile. Reconnect: "responding
      again", "Re-reading values", and the change appears on the mixers. The mixers send nothing by
      themselves.
- [ ] **Session load.** Load a session on the desk. The log shows "Session changed on the desk", mixers
      show the loading overlay **without disconnecting**, then a fresh config with correct values. No fader
      jumps.
- [ ] **Priming pace.** On the biggest session (e.g. 64 ch × 16 aux), after a server restart there is no
      "did not answer N request(s)" warning; the desk keeps up with ~40 queries/s.

## 2. Levels and echoes

- [ ] **Echoes.** Drag a mixer fader quickly. The fader doesn't jump back. "Desk echo" lines in the log
      are fine.
- [ ] **Engineer moves a send.** Move a send on the desk while a mixer shows that aux: the mixer updates.
- [ ] **Engineer and musician together.** Move a send on the desk while a musician holds the same fader.
      The iPad fader does not move under the finger and shows the desk value on release.
- [ ] **Group trim on a fresh start.** Restart the server and move a group fader straight away. The log
      shows "Group … ignored: waiting for N send level(s)" and the fader snaps back. Once values are loaded,
      group moves work and **no member jumps**.
- [ ] **Group from fully down.** Pull a group to off, then push it up fast. Each step raises it by at most
      +20 dB; nothing jumps to +10.

## 3. Restructuring during soundcheck

- [ ] **Rename an aux someone is locked to.** That iPad shows the orange "Your mix changed on the desk"
      banner and its faders are dimmed (nothing in the log from it). The admin shows the orange banner on
      every tab and the row is marked "was '…'". Click **Keep settings**: the lock resumes and colour,
      icon and title stay. Repeat with **Reset to defaults**: icon, title and layout clear, and the colour
      follows the new name.
- [ ] **Rename a channel.** The label updates live on all mixers (no reload), with an amber dot until it
      is confirmed in admin.
- [ ] **Colour follows the name.** An aux that kept its automatic colour gets a new colour after a rename.
      An aux whose colour was set by hand keeps it until you confirm.
- [ ] **Renumber.** Move a musician to a different aux number on the desk (e.g. swap two auxes). Both slots
      are flagged and locked devices are suspended; nobody silently controls another person's mix.
- [ ] **Add/remove channels or auxes.** Mixers and admin rebuild by themselves with the new names. New
      sends show "unknown" until the desk answers. Touching an unknown fader without dragging sends
      nothing (check the desk value doesn't change).
- [ ] **Rename from the admin page.** The desk renames and no identity prompt appears.

## 4. iPads (iOS Safari / home-screen app)

- [ ] **Sleep/wake.** Lock the iPad for ≥10 s and unlock it. You see a brief "Connecting…" and then
      current values. The admin Status shows one connection for that device, not two.
- [ ] **Wi-Fi drop.** Turn Wi-Fi off: "Connecting to the mixer…" within ~12 s. Turn it on: it reconnects by
      itself, with no duplicate connections.
- [ ] **Two fingers.** Drag two faders at once: both move, and lifting one doesn't affect the other.
- [ ] **Double-tap.** A fast double-tap on one volume fader sends it to off. A double-tap with movement, a
      tap on two different faders, or a double-tap on a group fader does nothing.
- [ ] **Send ON.** A short tap on an unlit ON button does nothing; press and hold (~0.35 s) lights it
      and the desk send switches on; a single tap switches it off. A send that is off dims its fader.
- [ ] **Resting finger.** Rest a finger on a fader without moving it: the desk level doesn't change.
- [ ] **First step of a drag.** Check that a drag starts smoothly. If the first few % of travel are
      swallowed, iOS isn't delivering `touchmove` for range inputs.
- [ ] **Cache.** An iPad that had the old version loaded picks up the new one (appcache VERSION 58).
      Readouts show "unknown" before values arrive.

## 5. Admin and operations

- [ ] **Save mid-show.** Save in `/admin` while musicians play: nobody disconnects and faders don't
      flash to off.
- [ ] **Presets with a password.** With `ADMIN_PASSWORD` set, load and save presets from `/admin`: no 401
      errors. Without logging in (e.g. curl), `/api/presets` returns 401.
- [ ] **Kill the server.** Kill the server process. Windows: `windows-start.bat` restarts it and writes a
      line to `restarts.log`. Docker: the container restarts. Mixers and admin reconnect by themselves.
- [ ] **Power loss during a save.** Pull power (or kill the process) during an admin save, then restart.
      The server starts with the previous settings.
- [ ] **Corrupt settings file.** Truncate `config/state.json` and restart. The log shows the CORRUPT banner
      and "Recovered from backup", and a `state.json.corrupt-<time>` file appears.
- [ ] **Docker on port 80.** On the real host (`network_mode: host`, port 80), the server binds as the
      `node` user (no EACCES) and `docker compose ps` shows the container as healthy.
- [ ] **Windows antivirus.** Save repeatedly from the admin page with antivirus active: no EPERM errors.

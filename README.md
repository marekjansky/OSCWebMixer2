# OSCWebMixer2

A rewrite of [OSCWebMixer](https://github.com/castles/OSCWebMixer) - A server that allows multiple web clients to control their own mix as well as external devices for a DiGiCo sound desk. It currently works with SD Series and Quantum consoles.

## What makes v2 better?

* This new version uses the same iPad connection that is built into the SD/Quantum consoles so it means you can use webmixer devices as well as the DiGiCo iPad apps at the same time. In-fact you can use multiple iPad apps simultaneously!
* All configuration is done in a browser instead of config files
* Auxilaries and Channels can have icons assigned to them
* Channels can be sorted
* Custom functionality can be added by writing some simple Plugins. There are a couple of examples of how this can be used in the plugins directory
* Webmixer can send and receive OSC messages to custom devices. This means it can communicate with TouchOSC, Reaper etc.
* Startup is much quicker because webmixer requests only the information it requires
* You can group your channels to make them easier to find
* The current snapshot name is displayed in webmixer
* Channel and auxiliary configuration can be saved as named presets and recalled later
* Devices can be locked to a single mix so a player can't change anyone else's mix. Locks are managed in the admin area
* Channels can be put into groups (e.g. Drums) that get a trim fader in every mix to turn the whole group up or down
* Each player can reorder and hide channels for their own mix with the arrange button (next to the padlock) at the top of the mixer. The layout is saved on the server per mix (`config/layouts.json`), so it is shared by every device on that mix
* Faders follow a console-style fader law and show their value in dB (or pan position) next to each fader

## Donate

This project has taken considerable time to create. If you find it useful and would like further development please make a donation.

[![paypal](https://www.paypalobjects.com/en_US/i/btn/btn_donateCC_LG.gif)](https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=VL5VBHN57FVS2&item_name=OSCWebMixer)

## Screenshots

<img src="https://github.com/castles/OSCWebMixer2/assets/323970/952cb304-b4f7-41b1-8308-2481bbbf6d78" width="400">
<img src="https://github.com/castles/OSCWebMixer2/assets/323970/1e43dc8b-3995-4149-8771-3c512d14a378" width="400">
<img src="https://github.com/castles/OSCWebMixer2/assets/323970/c60c263e-c848-4775-8e9a-59052eea2d01" width="400">
<img src="https://github.com/castles/OSCWebMixer2/assets/323970/13b8e955-9633-490f-a321-5783e301758d" width="400">
<img src="https://github.com/castles/OSCWebMixer2/assets/323970/06f017dd-d90e-4d81-83f3-1d85e836ecae" width="400">
<img src="https://github.com/castles/OSCWebMixer2/assets/323970/06f017dd-d90e-4d81-83f3-1d85e836ecae" width="400">
<img src="https://github.com/castles/OSCWebMixer2/assets/323970/51eebca5-4352-4d43-8834-e6ebd74d98e9" width="400">
<img src="https://github.com/castles/OSCWebMixer2/assets/323970/b0deedf0-d0b1-4919-b960-50e2e6259b06" width="400">

## Requirements

* A DiGiCo SD Series or Quantum Mixing desk.
* A computer to run the server. Windows, macOS or Linux.
* [GIT](https://git-scm.com/downloads/win) will need to be installed for Windows. [Node](https://nodejs.org/en/download/) must be installed. On macOS you can install node with [Homebrew](https://brew.sh/) (`brew install node`)
* Server, Desk and other devices must all be on the same network

## Admin Authentication (optional)

The admin area (used to configure the server and mixing desk) is unauthenticated by default,
matching the trusted-LAN model above. If the server may be reachable from a network you don't
fully trust, set the following environment variables before starting the server to require HTTP
Basic Auth on the admin area:

* `ADMIN_PASSWORD` - if set, the admin area requires Basic Auth with this password. If unset (the
  default), the admin area remains unauthenticated.
* `ADMIN_USER` - username to require alongside `ADMIN_PASSWORD`. Defaults to `admin`.

`ADMIN_PASSWORD` is also what a player has to enter to unlock a device that has been locked to a
mix with the padlock button. Without it anyone can unlock a device from the mixer. Locks are tied to
the browser, so clearing the browser's site data also releases a device.

## Download (no Node.js needed)

Ready-to-run builds for Windows, macOS (Apple Silicon and Intel) and Linux are attached to each
[GitHub release](../../releases). Download the zip for your platform, unzip it anywhere and start it:

- **Windows:** double-click `start.bat` (restarts the server automatically if it stops). Allow it through
  the Windows firewall when asked.
- **macOS:** the builds are not notarized by Apple, so macOS blocks them at first. Open Terminal in the
  unzipped folder and run `xattr -dr com.apple.quarantine .` once, then double-click `start.command`.
- **Linux:** run `./start.sh`. Ports below 1024 (such as the default web port 80) need root or
  `sudo setcap cap_net_bind_service=+ep OSCWebMixer2`.

Settings are stored in a `config` folder next to the program, and plugins are loaded from the `plugins`
folder next to it. To update, replace the program but keep `config`.

**Making a release (maintainers):** set `version` in `package.json`, commit, then push a matching tag
(`git tag v2.6.0 && git push --tags`). The `release` workflow tests, builds every platform natively,
checks each build starts, and publishes the release with checksums. Tags with a dash (`v2.6.0-beta.1`)
become pre-releases.

## Basic Setup Instructions

1. Download repository and navigate to the directory in a shell.
2. Run `npm install` to install all the required modules.
3. Run `npm run start` to start the server.
4. Visit the admin URL in your browser to configure server and mixing desk. See below screenshot for mixing desk configuration.
5. Open the server IP address on another device and start mixing.

<img width="538" height="529" alt="webmixer-external-control" src="https://github.com/user-attachments/assets/c8c01ec9-e153-4555-a19f-ef87dcff3ee5" />

## Developing / Debugging Without a Console

`tools/mock-desk.js` is a fake DiGiCo console. It answers the OSC queries webmixer
sends while loading, so the server reaches its "ready" state and the whole system
- web mixer, plugins, external device routing - can be exercised on a workbench
with no hardware. It also prints every message the server sends, so you can see
exactly what the web mixer is doing.

1. In one shell, start the mock desk:

```bash
npm run mock-desk
```

2. In another shell, start webmixer as usual (`npm run start`).
3. In the admin area, set the **Mixing Desk IP Address** to the machine running
   the mock (`127.0.0.1` if it is the same box) and save.

Options:

```bash
node tools/mock-desk.js --channels 32 --auxes 8   # bigger desk
node tools/mock-desk.js --live                     # also push periodic snapshot changes
node tools/mock-desk.js --port 9000 --reply-port 8000 --host 127.0.0.1
```

With no flags it reads the port numbers from `config.json` when present.

## Basic Setup Instructions For Docker

1. Install Git and Docker

2. Then execute following commands:

```bash
git clone https://github.com/castles/OSCWebMixer2.git

cd OSCWebMixer2 

docker build -t oscwebmixer2:latest .

docker compose up -d
```

1. To see logs and to see what address to connect run:

```bash
docker compose logs -f webmixer
```

## Running a show

* **Health check** - `GET /healthz` (no login) returns `{"ok":true,"loaded":true,"desk":"online"}`. `desk` is `online`, `offline` (desk silent for more than 10 s) or `loading`. Use it for monitoring; Docker uses it for its `HEALTHCHECK`.
* **Status page** - the **Status** tab in `/admin` refreshes every 3 seconds and shows the desk state (with IP:port and time since its last reply) and every connected client (device id, IP, locked mix, connected since, last seen). A red/orange banner at the top of every admin tab appears whenever the desk is offline or the server is still loading.
* **Identity-change banners** - if the desk reports a different name for an aux or channel than the one webmixer last knew (e.g. someone renamed or re-patched "Aux 5: Bass IEM" to "Keys IEM"), the admin page shows an orange banner. Settings for that slot (colour, icon, title, group, per-mix layout) are held, and any device locked to a changed aux is suspended - it can't send anything until you decide. Choose **Keep settings** if it is the same musician/channel with a new label, or **Reset to defaults** if the slot now belongs to something else. Changed rows are highlighted in the Auxiliaries/Channels lists.
* **Saving settings** no longer disconnects the mixers; they receive the new configuration live. Only changing the web port drops clients.
* **Restart automatically** - run the server under something that restarts it:
  * Windows: `windows-start.bat` restarts node 3 seconds after it exits and logs each restart to `restarts.log`.
  * Docker: `restart: unless-stopped`, log rotation (10 MB x 5) and a healthcheck are set in `docker-compose.yaml`. Check with `docker compose ps` (shows `healthy`) and `docker compose logs -f webmixer`.
  * Linux without Docker: a systemd unit with `Restart=always`.
* Docker runs as the non-root `node` user; the Dockerfile grants node the `cap_net_bind_service` capability so it can still bind port 80 under `network_mode: host`. The mounted `./config` folder must be writable by the container's `node` user (uid 1000), e.g. `chown -R 1000:1000 config`.

## FAQs

<details>
  <summary>My External Devices won't connect</summary>
  Ensure the server is running and the devices are connected on the same network. Verify desk settings in the admin area are correct.
</details>
<details>
  <summary>What devices work?</summary>
  Anything with a recent web browser can connect, that means it should work on iOS, Android, Windows, macOS and Linux.
</details>
<details>
  <summary>How many devices can I connect at once?</summary>
  No limit has been set and we haved tested 20+ without any issues.
</details>
<details>
  <summary>Can I connect multiple iPads at once with the DiGiCo app?</summary>
  Yes, go for it.
</details>
<details>
  <summary>How do I enable a plugin?</summary>
  Add a script into the plugin directory and make sure the filename doesn't start with an underscore. Restart webmixer and your plugin will be loaded.
</details>
<details>
  <summary>Does OSCWebMixer2 also support DiGiCo S-Series consoles?</summary>
  Currently, S-Series consoles are not supported by V2. For now, you will need to use <a href="https://github.com/castles/OSCWebMixer">version 1 of OSCWebMixer</a> with S-Series consoles.<br/>See <a href="https://github.com/castles/OSCWebMixer2/issues/4">this issue</a> for more information.
</details>

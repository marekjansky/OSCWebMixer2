"use strict";

(() => {

const channelsDiv = document.getElementById('channels'),
channelsWrap = document.getElementById('channelsWrap'),
auxSelect = document.getElementById('aux'),
panCheckbox = document.getElementById("panning"),
auxiliaries = document.getElementById("auxiliaries"),
snapshot = document.getElementById("snapshot"),
banner = document.getElementById("banner"),
overlayMessage = document.getElementById("overlayMessage"),
lockButton = document.getElementById("lock"),
arrangeButton = document.getElementById("arrange");

/** No message at all from the server for this long (it sends a status every 5 s) => the connection is dead */
const KEEPALIVE_TIMEOUT = 12000;
/** Give up on a socket that is still connecting after this long and start a new one */
const CONNECT_TIMEOUT = 2500;
/** Wait this long after a connection is lost before trying again */
const RECONNECT_DELAY = 2000;
/** Page hidden for longer than this => assume the connection died while asleep and reconnect on wake */
const HIDDEN_RECONNECT = 3000;
/** A finger has to move this far (px) before a fader sends anything */
const MOVE_PX = 6;
/** ...or the fader value has to change by this much (fallback if touchmove isn't delivered) */
const MOVE_VALUE = 0.06;
/** A tap is a touch shorter than this that didn't move */
const TAP_MAX_MS = 300;
/** Two taps on the same fader within this time reset it */
const DOUBLE_TAP_MS = 350;
/** A config held back because a fader is being touched is applied anyway after this long */
const CONFIG_HOLD_MAX = 10000;
//how long a send's ON button must be held to switch the send on (off is a single tap)
const HOLD_TO_TURN_ON_MS = 350;

let ws = null,
connectTimer = null,
reconnectTimer = null,
lastRx = 0, //time anything was last received on the current socket
anyMessage = false, //anything received on the current socket yet
statusSeen = false, //a /Webmixer/Status was received on the current socket (the server sends keep-alives)
deskState = null, //"loading" | "online" | "offline" from /Webmixer/Status, null = not told yet
hasConfig = false, //a config has been applied on the current socket
pendingConfig = null, //config waiting for the user to let go of the faders
pendingConfigSince = 0,
hiddenAt = 0,
channelInputs = new Map(), //channel number => volume slider
panInputs = new Map(), //channel number => pan slider
groupInputs = new Map(), //group id => group trim slider
onButtons = new Map(), //channel number => send on/off button
known = new Map(), //OSC address => {value, db} last known send level/pan/group level, any aux
activeSliders = new Set(), //sliders being touched or dragged with the mouse
touches = new Map(), //touch identifier => {slider, x, y}
mouseGesture = null, //{slider, x, y}
lastTouchTime = 0,
currentAux = undefined, //aux whose values the faders currently show
lockInfo = null, //{aux, suspended, auxName} when this device is locked to an aux
lockedAux = null,
unlockNeedsPassword = false,
channelRows = new Map(), //channel number => {wrap, heading, arrangeName, visibility} for enabled channels
adminOrder = [], //enabled channel numbers in the order set in the admin area
channelOrder = [], //enabled channel numbers in this device's order for the selected aux
hiddenChannels = new Set(), //channel numbers hidden on the selected aux
auxLayouts = {}; //aux number => {order, hidden}, stored on the server and shared by every device on that aux

/**
 * Read a value from localStorage. Storage can be unavailable (private mode, blocked site data).
 * @param {string} key
 * @returns {string|null}
 */
function storageGet(key)
{
	try
	{
		return localStorage.getItem(key);
	}
	catch(e)
	{
		return null;
	}
}

/**
 * Write a value to localStorage, ignoring failures.
 * @param {string} key
 * @param {string|null} value - null removes the key
 */
function storageSet(key, value)
{
	try
	{
		if(value === null)
		{
			localStorage.removeItem(key);
		}
		else
		{
			localStorage.setItem(key, value);
		}
	}
	catch(e)
	{
		//ignore
	}
}

/**
 * A random ID for this browser, used by the server to remember device locks.
 * Kept in localStorage, so clearing site data gives the device a new, unlocked identity.
 */
const deviceId = (function()
{
	let id = storageGet("deviceId");
	if(!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id))
	{
		//crypto.getRandomValues works on plain http, unlike crypto.randomUUID
		id = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
		storageSet("deviceId", id);
	}
	return id;
})();

/**
 * Fader law: slider position (0-1) => dB, like a console fader. Fine control around 0 dB,
 * the quiet end compressed at the bottom. Positions between points are interpolated linearly.
 * Position 0 is -150 dB, which the desk treats as off.
 */
const FADER_LAW = [
	[0, -150],
	[0.10, -60],
	[0.20, -40],
	[0.30, -25],
	[0.40, -15],
	[0.50, -10],
	[0.75, 0],
	[0.90, 5],
	[1, 10]
];
const MIN_DB = -150;
const MAX_DB = 10;

/**
 * Interpolate along FADER_LAW
 * @param {number} value - the input value
 * @param {number} from - index into each law point to read the input from
 * @param {number} to - index into each law point to produce the output from
 * @returns {number}
 */
function faderLaw(value, from, to)
{
	const first = FADER_LAW[0], last = FADER_LAW[FADER_LAW.length - 1];
	if(!(value > first[from]))
	{
		return first[to];
	}
	if(value >= last[from])
	{
		return last[to];
	}
	for(let i = 1; i < FADER_LAW.length; i++)
	{
		const a = FADER_LAW[i - 1], b = FADER_LAW[i];
		if(value <= b[from])
		{
			return a[to] + (value - a[from]) / (b[from] - a[from]) * (b[to] - a[to]);
		}
	}
	return last[to];
}

/**
 * Calculate the db value from the provided slider value.
 * @param {number} value - slider value between 0 and 1
 * @returns {number} dB between -150 and +10
 */
function sliderToDb(value)
{
	return faderLaw(parseFloat(value), 0, 1);
}

/**
 * Calculate the value a slider should be from the provided db value.
 * This is the reverse of sliderToDb.
 * @param {number} db - dB between -150 and +10
 * @returns {number} slider value between 0 and 1
 */
function dbToSlider(db)
{
	return faderLaw(parseFloat(db), 1, 0);
}

/**
 * Format a dB value for the readout next to a fader
 * @param {number} db
 * @returns {string}
 */
function formatDb(db)
{
	if(!(db > MIN_DB + 0.05))
	{
		return "-∞";
	}
	if(db <= -99.95)
	{
		return db.toFixed(0);
	}
	return (db > 0.05 ? "+" : "") + db.toFixed(1);
}

/**
 * Format a pan value (0 = left, 0.5 = centre, 1 = right) for the readout next to a fader
 * @param {number} value
 * @returns {string}
 */
function formatPan(value)
{
	const pan = Math.round((parseFloat(value) - 0.5) * 200);
	if(pan === 0)
	{
		return "C";
	}
	return (pan < 0 ? "L" : "R") + Math.abs(pan);
}

/**
 * Update a slider's fill and readout.
 * @param {HTMLInputElement} slider
 * @param {number} [db] - the exact dB value when known (sliders snap to their step, so
 * reading the dB back from the slider can be slightly off)
 */
function updateSlider(slider, db)
{
	slider.parentNode.style.setProperty('--value', (slider.value * 100) + "%");
	slider.parentNode.style.setProperty('--v', slider.value);

	const label = slider.closest("label");
	const unknown = Boolean(slider.fs && !slider.fs.known);
	label.classList.toggle("unknown", unknown);

	const readout = label.querySelector("output");
	if(!readout)
	{
		return;
	}
	let text;
	if(unknown)
	{
		text = "unknown";
	}
	else if(slider.classList.contains("panInput"))
	{
		text = formatPan(slider.value);
	}
	else
	{
		text = formatDb(db === undefined ? sliderToDb(slider.value) : db);
	}
	for(const layer of readout.children)
	{
		layer.textContent = text;
	}
}

/**
 * Show a known value on a slider
 * @param {HTMLInputElement} slider
 * @param {{value: number, db?: number}} v - slider position and, for levels, the exact dB
 */
function showValue(slider, v)
{
	slider.fs.known = true;
	slider.value = v.value;
	updateSlider(slider, v.db);
}

/**
 * Show a slider whose value hasn't been received from the server. The thumb sits at the
 * bottom (centre for pan) and the readout says "unknown" rather than pretending it is off.
 * @param {HTMLInputElement} slider
 */
function showUnknown(slider)
{
	slider.fs.known = false;
	slider.value = slider.classList.contains("panInput") ? 0.5 : 0;
	updateSlider(slider);
}

/**
 * Get the aux number currently selected
 * @returns {string|undefined}
 */
function selectedAux()
{
	const option = auxSelect.options[auxSelect.selectedIndex];
	return option ? option.dataset.channel : undefined;
}

/**
 * The OSC address a slider controls on an aux
 * @param {HTMLInputElement} slider
 * @param {string} aux
 * @returns {string}
 */
function sliderAddress(slider, aux)
{
	if(slider.classList.contains("groupInput"))
	{
		return "/Webmixer/Aux/" + aux + "/Group/" + slider.dataset.group + "/level";
	}
	return "/Input_Channels/" + slider.dataset.channel + "/Aux_Send/" + aux + "/send_" + (slider.classList.contains("panInput") ? "pan" : "level");
}

/**
 * Show the last known value for a slider on the selected aux, or "unknown"
 * @param {HTMLInputElement} slider
 */
function refreshSlider(slider)
{
	const aux = selectedAux();
	const v = aux === undefined ? undefined : known.get(sliderAddress(slider, aux));
	if(v)
	{
		showValue(slider, v);
	}
	else
	{
		showUnknown(slider);
	}
}

/**
 * Refresh every slider that isn't being touched
 */
function refreshAllSliders()
{
	for(const button of onButtons.values())
	{
		refreshOnButton(button);
	}
	for(const map of [channelInputs, panInputs, groupInputs])
	{
		for(const slider of map.values())
		{
			if(!slider.fs.gesture)
			{
				refreshSlider(slider);
			}
		}
	}
}

/**
 * Is the socket open and has the server said something on it?
 * @returns {boolean}
 */
function isConnected()
{
	return Boolean(ws && ws.readyState === WebSocket.OPEN && anyMessage);
}

/**
 * The desk state to act on. A server that never sends a status (older version) is treated
 * as online once it has sent a config.
 * @returns {"loading"|"online"|"offline"}
 */
function effectiveDeskState()
{
	if(deskState)
	{
		return deskState;
	}
	return hasConfig ? "online" : "loading";
}

/**
 * May this device read values and send non-level messages (queries, layouts) for its aux?
 * @returns {boolean}
 */
function canQuery()
{
	return isConnected() && hasConfig && effectiveDeskState() !== "loading" && !(lockInfo && lockInfo.suspended);
}

/**
 * May this device change levels right now? Never while connecting, while the server is
 * loading desk data, while the desk isn't answering, or while this device's locked mix
 * changed on the desk and hasn't been confirmed.
 * @returns {boolean}
 */
function canSend()
{
	return canQuery() && effectiveDeskState() === "online" && selectedAux() !== undefined;
}

/**
 * Send a message over the socket if it is open. Callers decide whether the message is allowed.
 * @param {string} address
 * @param {Array} [args]
 */
function sendOSC(address, args = [])
{
	if(!ws || ws.readyState != WebSocket.OPEN)
	{
		return;
	}
	ws.send(JSON.stringify({
		"address": address,
		"args": args
	}));
}

/**
 * callback for when a channel volume/pan or group trim fader moves
 */
function faderInput()
{
	const slider = this, gesture = slider.fs.gesture;
	const value = parseFloat(slider.value);

	if(gesture && !gesture.moved && Math.abs(value - gesture.startValue) >= MOVE_VALUE)
	{
		gesture.moved = true;
	}

	//a touch that hasn't really moved yet (a tap, or the slider snapping to the finger)
	//never sends anything. Neither does a gesture that was blocked once: if sending was
	//stopped mid-move it stays stopped until the finger is lifted, so the level can't jump
	//to wherever the finger has got to in the meantime.
	if(gesture && (gesture.blocked || !gesture.moved))
	{
		refreshSlider(slider);
		return;
	}

	//without a touch or mouse gesture, only keyboard changes to the focused slider count
	//(and not a late event straight after a finger was lifted)
	if(!gesture && (document.activeElement !== slider || Date.now() - slider.fs.gestureEnd < 500))
	{
		refreshSlider(slider);
		return;
	}

	if(!commitSlider(slider) && gesture)
	{
		gesture.blocked = true;
	}
}

/**
 * Send a slider's current position, if sending is allowed. Otherwise the slider goes back to
 * the last known value.
 * @param {HTMLInputElement} slider
 * @returns {boolean} true if it was sent
 */
function commitSlider(slider)
{
	const fs = slider.fs;
	const value = parseFloat(slider.value);

	//a group trim moves every member by the difference to its current level, so it can only be
	//moved once its current level is known
	if(!canSend() || (slider.classList.contains("groupInput") && !fs.known))
	{
		refreshSlider(slider);
		return false;
	}

	const address = sliderAddress(slider, selectedAux());
	let arg, db;
	if(slider.classList.contains("panInput"))
	{
		arg = value;
	}
	else
	{
		db = sliderToDb(value);
		arg = db;
	}
	known.set(address, { value, db });
	fs.known = true;
	updateSlider(slider, db);
	sendOSC(address, [arg]);
	return true;
}

/**
 * Request current AUX values from server
 */
function requestValues()
{
	const aux = selectedAux();
	if(aux === undefined || !canQuery())
	{
		return;
	}
	for(const channel of channelInputs.keys())
	{
		sendOSC("/Input_Channels/" + channel + "/Aux_Send/" + aux + "/send_level/?");
		sendOSC("/Input_Channels/" + channel + "/Aux_Send/" + aux + "/send_pan/?");
		sendOSC(onAddress(channel, aux) + "/?");
	}
	for(const group of groupInputs.keys())
	{
		sendOSC("/Webmixer/Aux/" + aux + "/Group/" + group + "/level/?");
	}
}

/**
 * A level, pan or group trim value arrived from the server. Remember it and show it, unless
 * the fader is under a finger: then it is shown when the finger lets go.
 * @param {string} address
 * @param {string} aux
 * @param {HTMLInputElement|undefined} slider - the slider for that address on the selected aux
 * @param {{value: number, db?: number}} v
 */
function remoteValue(address, aux, slider, v)
{
	known.set(address, v);
	if(slider && aux == selectedAux() && !slider.fs.gesture)
	{
		showValue(slider, v);
	}
}

/**
 * Parse a dB argument
 * @param {*} arg
 * @returns {{value: number, db: number}|null}
 */
function levelValue(arg)
{
	const db = Number(arg);
	if(!Number.isFinite(db))
	{
		return null;
	}
	const clamped = Math.min(MAX_DB, Math.max(MIN_DB, db));
	return { value: dbToSlider(clamped), db: clamped };
}

/**
 * Handle /Webmixer/Status
 * @param {*} arg - JSON string {desk: "loading"|"online"|"offline"}
 */
function handleStatus(arg)
{
	let status = arg;
	if(typeof arg === "string")
	{
		try
		{
			status = JSON.parse(arg);
		}
		catch(e)
		{
			return;
		}
	}
	if(!status || !["loading", "online", "offline"].includes(status.desk))
	{
		return;
	}
	statusSeen = true;

	const previous = effectiveDeskState();
	deskState = status.desk;

	if(deskState === "loading" && previous !== "loading")
	{
		//the server is (re)loading the desk, maybe a different session: forget every value
		known.clear();
		refreshAllSliders();
	}
	if(deskState === "online" && previous !== "online")
	{
		//values may have changed while the desk wasn't answering
		requestValues();
	}
	updateStatusUI();
}

/**
 * Callback for when socket receives a message
 * @param {MessageEvent} e - the message socket event
 */
function onMessage(e)
{
	lastRx = Date.now();
	if(!anyMessage)
	{
		anyMessage = true;
		updateStatusUI();
	}

	let json;
	try
	{
		json = JSON.parse(e.data);
	}
	catch(err)
	{
		return;
	}
	if(!json || typeof json !== "object")
	{
		return;
	}

	//Setup AUX and channels. This can arrive at any time: renames, admin changes, presets...
	if(json.config)
	{
		receiveConfig(json.config);
		return;
	}

	if(typeof json.address !== "string")
	{
		return;
	}
	const args = Array.isArray(json.args) ? json.args : [];

	if(json.address == "/Webmixer/Status")
	{
		handleStatus(args[0]);
		return;
	}

	if(json.address == "/Webmixer/Error")
	{
		alert(args[0]);
		return;
	}

	if(json.address == "/SnapshotName")
	{
		snapshot.textContent = args[0] === undefined ? "" : args[0];
		return;
	}

	//update level or pan
	const send = json.address.match(/^\/Input_Channels\/([0-9]+)\/Aux_Send\/([0-9]+)\/send_(level|pan|on)$/);
	if(send !== null && send[3] == "on")
	{
		const on = Number(args[0]);
		if(Number.isFinite(on))
		{
			known.set(json.address, { value: on ? 1 : 0 });
			const button = onButtons.get(send[1]);
			if(button && send[2] == selectedAux())
			{
				refreshOnButton(button);
			}
		}
		return;
	}
	if(send !== null)
	{
		let v;
		if(send[3] == "level")
		{
			v = levelValue(args[0]);
		}
		else
		{
			const pan = Number(args[0]);
			v = Number.isFinite(pan) ? { value: Math.min(1, Math.max(0, pan)) } : null;
		}
		if(v)
		{
			remoteValue(json.address, send[2], (send[3] == "level" ? channelInputs : panInputs).get(send[1]), v);
		}
		return;
	}

	//another device changed the channel layout of an aux
	let layoutMatch = json.address.match(/^\/Webmixer\/Aux\/([0-9]+)\/Layout$/);
	if(layoutMatch !== null)
	{
		let layout = null;
		try
		{
			layout = args.length ? JSON.parse(args[0]) : null;
		}
		catch(err)
		{
			layout = null;
		}
		if(layout)
		{
			auxLayouts[layoutMatch[1]] = layout;
		}
		else
		{
			delete auxLayouts[layoutMatch[1]];
		}
		if(layoutMatch[1] == selectedAux())
		{
			loadLayout();
		}
		return;
	}

	//update group trim
	let groupLevel = json.address.match(/^\/Webmixer\/Aux\/([0-9]+)\/Group\/([A-Za-z0-9_-]+)\/level$/);
	if(groupLevel !== null)
	{
		const v = levelValue(args[0]);
		if(v)
		{
			remoteValue(json.address, groupLevel[1], groupInputs.get(groupLevel[2]), v);
		}
		return;
	}

	//update channel names
	let channelNameMatch = json.address.match(/^\/Input_Channels\/([0-9]+)\/Channel_Input\/name$/);
	if(channelNameMatch !== null && typeof args[0] === "string")
	{
		for(let slider of document.querySelectorAll('input[data-channel="' + channelNameMatch[1] + '"]'))
		{
			slider.closest("label").querySelector(".name").textContent = args[0];
		}
		const row = channelRows.get(channelNameMatch[1]);
		if(row)
		{
			row.arrangeName.textContent = args[0];
		}
		return;
	}

	//update Aux names
	let auxNameMatch = json.address.match(/^\/Aux_Outputs\/([0-9]+)\/Buss_Trim\/name$/);
	if(auxNameMatch !== null && typeof args[0] === "string")
	{
		for(let option of auxSelect.options)
		{
			if(option.value == auxNameMatch[1])
			{
				option.textContent = args[0];
			}
		}
		if(selectedAux() == auxNameMatch[1])
		{
			auxSelect.previousElementSibling.textContent = args[0];
		}
		for(let button of auxiliaries.getElementsByTagName("button"))
		{
			if(button.value == auxNameMatch[1])
			{
				button.querySelector(".label").textContent = args[0];
			}
		}
	}
}

/**
 * A config arrived. The lock state is applied straight away (it decides whether this device
 * may send). The page itself is rebuilt once no fader is being touched, so a finger on a
 * fader isn't yanked off it.
 * @param {Object} config
 */
function receiveConfig(config)
{
	const lock = config.lock;
	lockInfo = lock && lock.aux !== undefined && lock.aux !== null ? {
		aux: Number(lock.aux),
		suspended: lock.suspended === true,
		auxName: typeof lock.auxName === "string" ? lock.auxName : ""
	} : null;
	lockedAux = lockInfo ? lockInfo.aux : null;
	unlockNeedsPassword = config.unlockNeedsPassword === true;
	updateLockUI();

	if(activeSliders.size > 0)
	{
		if(!pendingConfig)
		{
			pendingConfigSince = Date.now();
		}
		pendingConfig = config;
		updateStatusUI();
		return;
	}
	applyConfig(config);
}

/**
 * Rebuild the page from a config, keeping the selected aux, panning view, scroll position
 * and every value already known.
 * @param {Object} config
 */
function applyConfig(config)
{
	pendingConfig = null;
	hasConfig = true;

	const previousAux = currentAux;
	const wasPanning = panCheckbox.checked;
	const scroll = channelsWrap.scrollTop;

	auxLayouts = config.layouts || {};
	snapshot.textContent = config.snapshot || "";
	buildAux(Array.isArray(config.aux) ? config.aux : []);
	buildChannels(Array.isArray(config.channels) ? config.channels : [], Array.isArray(config.groups) ? config.groups : []);
	selectAux(previousAux !== undefined && previousAux === selectedAux() && wasPanning);

	channelsWrap.scrollTop = scroll;
	updateLockUI();
	updateStatusUI();
}

/**
 * Convert Hexadecimal colour to R, G, B
 * @param {string} hex - colour to convert
 * @returns string - converted colour
 */
function formatColour(hex)
{
	var result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
	return result ? [parseInt(result[1], 16),parseInt(result[2], 16),parseInt(result[3], 16)].join(",") : null;
}

/**
 * Populate AUX Select Box
 * @param {Array<Object>} options - An array of AUXs to add to the select box
 */
function buildAux(options)
{
	auxiliaries.innerHTML = "";
	auxSelect.innerHTML = "";

	for(let option of options)
	{
		//a locked device always gets its aux, even if it has been hidden in the admin area
		if(!option.enabled && option.channel != lockedAux)
		{
			if(storageGet("aux") == option.channel)
			{
				storageSet("aux", null);
			}
			continue;
		}

		let iconsrc = option.icon ? option.icon : "";

		let colour = formatColour(option.colour);

		let opt = document.createElement("option");
		opt.value = option.channel;
		opt.dataset.channel = option.channel;
		opt.dataset.colour = colour;
		opt.dataset.stereo = option.stereo;
		opt.dataset.icon = iconsrc;
		opt.dataset.changed = option.changed === true;
		opt.textContent = option.label;
		auxSelect.appendChild(opt);

		let button = document.createElement("button");
		button.value = option.channel;
		button.style.setProperty('--tint', colour);

		let icon = document.createElement("img");
		icon.src = iconsrc;
		icon.width = 30;
		icon.height = 30;
		button.appendChild(icon);

		let text = document.createElement("span");
		text.className = "label";
		text.textContent = option.label;
		button.appendChild(text);

		if(option.changed === true)
		{
			button.classList.add("changed");
			button.title = "Renamed on the desk, not yet confirmed by the engineer";
		}

		auxiliaries.appendChild(button);
	}

	if(lockedAux !== null)
	{
		auxSelect.value = lockedAux;
		document.body.classList.remove("auxPicker");
	}
	else if(storageGet("aux") && auxSelect.querySelector('option[value="' + storageGet("aux") + '"]'))
	{
		auxSelect.value = storageGet("aux");
	}
	else
	{
		document.body.classList.add("auxPicker");
	}
}

/**
 * Show the selected aux: header, tint, panning, layout and values.
 * @param {boolean} keepPanning - stay in the panning view (if the aux is stereo)
 */
function selectAux(keepPanning)
{
	const option = auxSelect.options[auxSelect.selectedIndex];
	const aux = selectedAux();

	if(aux !== currentAux)
	{
		//a finger still on a fader is now on a different mix's fader: it mustn't send anything
		for(const slider of activeSliders)
		{
			slider.fs.gesture.blocked = true;
		}
	}
	currentAux = aux;

	const headerText = auxSelect.previousElementSibling;
	const headerIcon = headerText.previousElementSibling;

	if(!option)
	{
		headerText.textContent = "";
		headerText.classList.remove("changed");
		headerIcon.src = "";
		panCheckbox.parentNode.style.display = "none";
		panCheckbox.checked = false;
		document.body.classList.remove("panning");
		loadLayout();
		refreshAllSliders();
		return;
	}

	//save aux value so it can be restored
	storageSet("aux", option.value);

	//set the current page tint
	document.body.style.setProperty('--tint', option.dataset.colour);

	//set the current aux text
	headerText.textContent = option.text;
	headerText.classList.toggle("changed", option.dataset.changed == "true");
	headerText.title = option.dataset.changed == "true" ? "Renamed on the desk, not yet confirmed by the engineer" : "";
	headerIcon.src = option.dataset.icon;

	//toggle visibility of the pan checkbox
	const stereo = option.dataset.stereo == "true";
	panCheckbox.parentNode.style.display = stereo ? "flex" : "none";
	panCheckbox.checked = keepPanning && stereo;
	document.body.classList.toggle("panning", panCheckbox.checked);

	//each aux has its own channel layout
	loadLayout();

	//show what is already known about this aux, then ask the server for everything
	refreshAllSliders();
	requestValues();
}

/**
 * Reflect the lock state in the page
 */
function updateLockUI()
{
	const locked = lockedAux !== null;
	const suspended = Boolean(lockInfo && lockInfo.suspended);
	document.body.classList.toggle("locked", locked);
	document.body.classList.toggle("suspended", suspended);
	auxSelect.disabled = locked;
	lockButton.setAttribute("aria-pressed", locked ? "true" : "false");
	lockButton.title = locked ? "Locked to this mix. Tap to unlock." : "Lock this device to the current mix";
	arrangeButton.disabled = suspended;
	if(suspended)
	{
		setArranging(false);
	}
	updateStatusUI();
}

/**
 * Show the connection / desk state: overlay while connecting or waiting for the desk,
 * banner when the desk stops answering or this device's mix changed on the desk, and
 * disable the faders whenever nothing may be sent.
 */
function updateStatusUI()
{
	const connected = isConnected();
	const desk = effectiveDeskState();
	const waiting = connected && (!hasConfig || desk === "loading");
	const offline = connected && hasConfig && desk === "offline";
	const suspended = Boolean(lockInfo && lockInfo.suspended);

	document.body.classList.toggle("disconnected", !connected);
	document.body.classList.toggle("waiting", waiting);
	document.body.classList.toggle("deskOffline", offline);

	let message = "";
	if(!connected)
	{
		message = "Connecting to the mixer…";
	}
	else if(waiting)
	{
		message = desk === "offline" ? "Waiting for mixing desk… (not responding)" : "Waiting for mixing desk…";
	}
	if(overlayMessage.textContent !== message)
	{
		overlayMessage.textContent = message;
	}

	const lines = [];
	if(offline)
	{
		lines.push(["offline", "Mixing desk not responding. Faders are disabled until it answers again."]);
	}
	if(suspended && connected && !waiting)
	{
		lines.push(["suspended", "Your mix changed on the desk (aux " + lockInfo.aux + " is now '" + lockInfo.auxName + "'). Ask the engineer to confirm."]);
	}
	const bannerKey = JSON.stringify(lines);
	if(banner.dataset.key !== bannerKey)
	{
		banner.dataset.key = bannerKey;
		banner.innerHTML = "";
		for(const [type, text] of lines)
		{
			const line = document.createElement("div");
			line.className = type;
			line.textContent = text;
			banner.appendChild(line);
		}
	}

	document.body.classList.toggle("readonly", !canSend());
}

/**
 * Lock this device to the selected aux, or unlock it
 */
function lockClick(e)
{
	e.preventDefault();

	if(!isConnected())
	{
		return;
	}

	if(lockedAux === null)
	{
		const option = auxSelect.options[auxSelect.selectedIndex];
		if(!option)
		{
			return;
		}
		if(confirm('Lock this device to "' + option.text + '"? Other mixes will no longer be adjustable from here.'))
		{
			sendOSC("/Webmixer/Lock", [parseInt(option.value, 10)]);
		}
		return;
	}

	if(unlockNeedsPassword)
	{
		const password = prompt("Enter the admin password to unlock this device.");
		if(password === null)
		{
			return;
		}
		sendOSC("/Webmixer/Unlock", [password]);
		return;
	}

	if(confirm("Unlock this device?"))
	{
		sendOSC("/Webmixer/Unlock");
	}
}
lockButton.addEventListener("click", lockClick);

/**
 * open the auxiliaries picker when tapped
 * @param {!Event} e - the mouse event
 */
function auxMouseDown(e)
{
	e.preventDefault();
	e.stopImmediatePropagation();
	if(lockedAux !== null)
	{
		return;
	}
	document.body.classList.add("auxPicker");
}
auxSelect.addEventListener("mousedown", auxMouseDown);

/**
 * Select the Aux when a button is tapped
 * @param {!Event} e - the mouse event
 */
function auxPickerClick(e)
{
	const button = e.target.closest("button");
	if(button && lockedAux === null)
	{
		auxSelect.value = button.value;
		auxSelect.dispatchEvent(new Event("change"));

		document.body.classList.remove("auxPicker");
	}
}
auxiliaries.addEventListener("click", auxPickerClick);

/*
	Touch handling. Each fader tracks its own touches:
	- nothing is sent until the finger has really moved (so a tap or a resting finger never
	  changes a level, and an "unknown" fader stays unknown until it is moved)
	- values arriving from the desk or other devices aren't applied under the finger; the
	  latest is shown when the finger lets go
	- a double tap on the same volume or pan fader without moving resets it (off / centre).
	  Group trims have no double-tap reset.
*/

/**
 * A finger or the mouse went down on a slider
 * @param {HTMLInputElement} slider
 */
function startGesture(slider)
{
	if(slider.fs.gesture)
	{
		slider.fs.gesture.count++;
		return;
	}
	slider.fs.gesture = {
		count: 1,
		startValue: parseFloat(slider.value),
		startTime: Date.now(),
		moved: false,
		blocked: !canSend()
	};
	activeSliders.add(slider);
}

/**
 * A finger or the mouse was lifted from a slider
 * @param {HTMLInputElement} slider
 * @param {boolean} tapped - it was a short touch that didn't move
 */
function endGesture(slider, tapped)
{
	const gesture = slider.fs.gesture;
	if(!gesture)
	{
		return;
	}
	if(--gesture.count > 0)
	{
		return;
	}
	slider.fs.gesture = null;
	slider.fs.gestureEnd = Date.now();
	activeSliders.delete(slider);

	//show the latest value, including anything that arrived while it was touched
	refreshSlider(slider);

	if(tapped && Date.now() - gesture.startTime < TAP_MAX_MS && !gesture.moved && !slider.classList.contains("groupInput"))
	{
		if(Date.now() - slider.fs.lastTap < DOUBLE_TAP_MS)
		{
			slider.fs.lastTap = 0;
			resetSlider(slider);
		}
		else
		{
			slider.fs.lastTap = Date.now();
		}
	}
	else
	{
		slider.fs.lastTap = 0;
	}

	if(activeSliders.size == 0 && pendingConfig)
	{
		applyConfig(pendingConfig);
	}
}

/**
 * Forget every touch, e.g. when the page is hidden and touchend may never arrive
 */
function endAllGestures()
{
	touches.clear();
	mouseGesture = null;
	for(const slider of [...activeSliders])
	{
		slider.fs.gesture.count = 1;
		endGesture(slider, false);
	}
}

function sliderTouchStart(e)
{
	lastTouchTime = Date.now();
	for(const touch of e.changedTouches)
	{
		touches.set(touch.identifier, { slider: this, x: touch.clientX, y: touch.clientY });
		startGesture(this);
	}
}

function documentTouchMove(e)
{
	lastTouchTime = Date.now();
	for(const touch of e.changedTouches)
	{
		const t = touches.get(touch.identifier);
		if(t && t.slider.fs.gesture && Math.hypot(touch.clientX - t.x, touch.clientY - t.y) >= MOVE_PX)
		{
			t.slider.fs.gesture.moved = true;
		}
	}
}

function documentTouchEnd(e)
{
	lastTouchTime = Date.now();
	for(const touch of e.changedTouches)
	{
		const t = touches.get(touch.identifier);
		if(t)
		{
			touches.delete(touch.identifier);
			endGesture(t.slider, e.type == "touchend");
		}
	}
	//touches whose end we missed (element rebuilt, events lost)
	if(e.touches.length == 0 && activeSliders.size > 0 && !mouseGesture)
	{
		endAllGestures();
	}
}

document.addEventListener("touchmove", documentTouchMove, { passive: true, capture: true });
document.addEventListener("touchend", documentTouchEnd, { passive: true, capture: true });
document.addEventListener("touchcancel", documentTouchEnd, { passive: true, capture: true });

function sliderMouseDown(e)
{
	//touch devices also send mouse events after a tap
	if(Date.now() - lastTouchTime < 1000 || e.button !== 0 || mouseGesture)
	{
		return;
	}
	mouseGesture = { slider: this, x: e.clientX, y: e.clientY };
	startGesture(this);
}

document.addEventListener("mousemove", function(e)
{
	if(mouseGesture && mouseGesture.slider.fs.gesture && Math.hypot(e.clientX - mouseGesture.x, e.clientY - mouseGesture.y) >= MOVE_PX)
	{
		mouseGesture.slider.fs.gesture.moved = true;
	}
}, true);

document.addEventListener("mouseup", function()
{
	if(mouseGesture)
	{
		const slider = mouseGesture.slider;
		mouseGesture = null;
		endGesture(slider, false);
	}
}, true);

/**
 * Double click (mouse) resets a volume or pan fader
 */
function sliderDoubleClick()
{
	if(Date.now() - lastTouchTime < 1000)
	{
		return; //touch double taps are handled in endGesture
	}
	resetSlider(this);
}

/**
 * Reset a fader to its default value: volume to off, pan to centre. This is an explicit
 * user action, so it is sent like any other move (if sending is allowed).
 * @param {HTMLInputElement} slider
 */
function resetSlider(slider)
{
	if(slider.classList.contains("volumeInput"))
	{
		slider.value = 0;
	}
	else if(slider.classList.contains("panInput"))
	{
		slider.value = 0.5;
	}
	else
	{
		return;
	}
	commitSlider(slider);
}

/**
 * Build a fader: a label with an optional icon, the name, the slider and a value readout
 * @param {string} type - "volume" or "pan"
 * @param {string} labelText
 * @param {string} iconSrc
 * @param {string} inputClass
 * @param {boolean} changed - the name changed on the desk and hasn't been confirmed
 * @returns {{label: HTMLLabelElement, input: HTMLInputElement}}
 */
/**
 * The desk address of a channel's send on/off switch on an aux
 * @param {string|number} channel
 * @param {string|number} aux
 * @returns {string}
 */
function onAddress(channel, aux)
{
	return "/Input_Channels/" + channel + "/Aux_Send/" + aux + "/send_on";
}

/**
 * Show a send's on/off state on the selected aux: lit, unlit, or unknown. A send that is off
 * dims its fader (which can still be set, ready for switching the send on).
 * @param {HTMLButtonElement} button
 */
function refreshOnButton(button)
{
	const aux = selectedAux();
	const v = aux === undefined ? undefined : known.get(onAddress(button.dataset.channel, aux));
	const state = v ? (v.value ? "on" : "off") : "unknown";
	if(button.dataset.state !== state)
	{
		button.dataset.state = state;
		button.setAttribute("aria-pressed", state == "on" ? "true" : "false");
		button.title = state == "on" ? "Send is on. Tap to turn it off."
			: state == "off" ? "Send is off. Press and hold to turn it on."
			: "Send on/off not known yet";
	}
	const label = button.closest("label");
	if(label)
	{
		label.classList.toggle("sendOff", state == "off");
	}
	if(state != "off")
	{
		cancelHold(button);
	}
}

/**
 * Stop a press-and-hold that would switch a send on
 * @param {HTMLButtonElement} button
 */
function cancelHold(button)
{
	if(button.holdTimer)
	{
		clearTimeout(button.holdTimer);
		button.holdTimer = null;
	}
	button.classList.remove("holding");
}

/**
 * Switch a send on or off on the selected aux
 * @param {HTMLButtonElement} button
 * @param {0|1} on
 */
function setSendOn(button, on)
{
	const address = onAddress(button.dataset.channel, selectedAux());
	known.set(address, { value: on });
	refreshOnButton(button);
	sendOSC(address, [on]);
}

/**
 * Pressing a send's ON button. Turning a send off is immediate (that's the safe direction).
 * Turning it on needs a press and hold, so a stray touch can't suddenly add a channel to
 * someone's ears, and is refused while the send's level isn't known.
 * @param {PointerEvent} e
 */
function onButtonDown(e)
{
	const button = this;
	if(e.cancelable)
	{
		e.preventDefault();
	}
	cancelHold(button);

	const aux = selectedAux();
	const v = aux === undefined ? undefined : known.get(onAddress(button.dataset.channel, aux));
	if(!canSend() || !v)
	{
		return;
	}
	if(v.value)
	{
		setSendOn(button, 0);
		return;
	}

	const level = known.get(sliderAddress(channelInputs.get(button.dataset.channel), aux));
	if(!level)
	{
		return;
	}
	button.classList.add("holding");
	button.holdTimer = setTimeout(function()
	{
		button.holdTimer = null;
		button.classList.remove("holding");
		const now = known.get(onAddress(button.dataset.channel, aux));
		if(canSend() && selectedAux() === aux && now && !now.value)
		{
			setSendOn(button, 1);
		}
	}, HOLD_TO_TURN_ON_MS);
}

/**
 * Keyboard activation (Enter/Space) of an ON button is a deliberate action, so it toggles.
 * Pointer presses are handled in onButtonDown.
 * @param {MouseEvent} e
 */
function onButtonClick(e)
{
	e.preventDefault();
	if(e.detail !== 0)
	{
		return;
	}
	const aux = selectedAux();
	const v = aux === undefined ? undefined : known.get(onAddress(this.dataset.channel, aux));
	const level = aux === undefined ? undefined : known.get(sliderAddress(channelInputs.get(this.dataset.channel), aux));
	if(canSend() && v && (v.value || level))
	{
		setSendOn(this, v.value ? 0 : 1);
	}
}

/**
 * Create a channel's send on/off button
 * @param {string|number} channel
 * @returns {HTMLButtonElement}
 */
function createOnButton(channel)
{
	const button = document.createElement("button");
	button.type = "button";
	button.className = "sendOn";
	button.dataset.channel = channel;
	const text = document.createElement("span");
	text.textContent = "ON";
	button.appendChild(text);
	button.addEventListener("pointerdown", onButtonDown);
	for(const type of ["pointerup", "pointercancel", "pointerleave"])
	{
		button.addEventListener(type, function() { cancelHold(this); });
	}
	button.addEventListener("click", onButtonClick);
	button.addEventListener("contextmenu", e => e.preventDefault());
	refreshOnButton(button);
	return button;
}

function createFader(type, labelText, iconSrc, inputClass, changed)
{
	let label = document.createElement("label");
	label.className = type;

	if(iconSrc)
	{
		let icon = document.createElement("img");
		icon.src = iconSrc;
		icon.width = 22;
		icon.height = 22;
		icon.className = "icon";
		label.appendChild(icon);
	}

	let name = document.createElement("span");
	name.className = "name";
	name.textContent = labelText;
	label.appendChild(name);

	if(changed)
	{
		let marker = document.createElement("span");
		marker.className = "changedMarker";
		marker.title = "Renamed on the desk, not yet confirmed by the engineer";
		label.appendChild(marker);
	}

	let row = document.createElement("div");
	row.className = "faderRow";

	let fader = document.createElement("div");
	fader.className = "fader";

	let input = document.createElement("input");
	input.type = "range";
	input.className = inputClass;
	input.step = "0.001";
	input.min = "0";
	input.max = "1";
	input.fs = { known: false, gesture: null, gestureEnd: 0, lastTap: 0 };
	fader.appendChild(input);

	//the value readout sits inside the fader track, on the right. It has a white layer and a
	//dark layer that CSS clips to the white fill and thumb, so the text is readable over both.
	let readout = document.createElement("output");
	for(const layer of ["light", "dark"])
	{
		let span = document.createElement("span");
		span.className = layer;
		if(layer == "dark")
		{
			span.setAttribute("aria-hidden", "true");
		}
		readout.appendChild(span);
	}
	fader.appendChild(readout);
	row.appendChild(fader);

	label.appendChild(row);

	input.addEventListener("input", faderInput);
	input.addEventListener("touchstart", sliderTouchStart, { passive: true });
	input.addEventListener("mousedown", sliderMouseDown);
	if(inputClass != "groupInput")
	{
		input.addEventListener("dblclick", sliderDoubleClick);
	}

	showUnknown(input);

	return { label, input };
}

/**
 * Build channels html and add to the page
 * @param {!Array<Object>} channels - the channels to build
 * @param {!Array<Object>} groups - the channel groups (shown as trim faders above the channels)
 */
function buildChannels(channels, groups)
{
	channelsDiv.innerHTML = "";
	channelInputs = new Map();
	panInputs = new Map();
	groupInputs = new Map();
	for(const button of onButtons.values())
	{
		cancelHold(button);
	}
	onButtons = new Map();
	channelRows = new Map();
	adminOrder = channels
		.filter(channel => channel.enabled)
		.sort((a, b) => a.order - b.order || a.channel - b.channel)
		.map(channel => String(channel.channel));

	if(groups.length > 0)
	{
		let heading = document.createElement("h2");
		heading.className = "groupHeading";
		heading.style.order = -2;
		heading.textContent = "Groups";
		channelsDiv.appendChild(heading);
	}

	for(let group of groups)
	{
		let wrap = document.createElement("div");
		wrap.className = "group";
		wrap.style.order = -1;

		const { label, input } = createFader("volume", group.name, group.icon, "groupInput", false);
		input.dataset.group = group.id;
		groupInputs.set(String(group.id), input);

		wrap.appendChild(label);
		channelsDiv.appendChild(wrap);
	}

	for(let channel of channels)
	{
		let heading = null;
		if(channel.title)
		{
			heading = document.createElement("h2");
			heading.style.order = channel.order;
			heading.textContent = channel.title;
			channelsDiv.appendChild(heading);
		}

		let wrap = document.createElement("div");
		if(!channel.enabled)
		{
			wrap.className = "disabled";
		}
		wrap.style.order = channel.order;

		if(channel.enabled)
		{
			channelRows.set(String(channel.channel), Object.assign({ wrap, heading }, createArrangeControls(channel)));
			wrap.appendChild(channelRows.get(String(channel.channel)).arrange);
		}

		for(let type of ["volume", "pan"])
		{
			const { label, input } = createFader(type, channel.label, channel.icon, type == "volume" ? "volumeInput" : "panInput", channel.changed === true);
			input.dataset.channel = channel.channel;
			(type == "volume" ? channelInputs : panInputs).set(String(channel.channel), input);
			if(type == "volume")
			{
				const button = createOnButton(channel.channel);
				const row = label.querySelector(".faderRow");
				row.insertBefore(button, row.firstChild);
				onButtons.set(String(channel.channel), button);
			}
			wrap.appendChild(label);
		}

		channelsDiv.appendChild(wrap);
	}

	channelsDiv.appendChild(layoutBar);
}

/**
 * Build the controls shown for a channel while arranging: show/hide, name, move up, move down
 * @param {Object} channel
 * @returns {{arrange: HTMLDivElement, arrangeName: HTMLSpanElement, visibility: HTMLButtonElement}}
 */
function createArrangeControls(channel)
{
	let arrange = document.createElement("div");
	arrange.className = "arrange";

	let visibility = document.createElement("button");
	visibility.type = "button";
	visibility.className = "visibility";
	visibility.dataset.action = "toggle";
	visibility.dataset.channel = channel.channel;
	visibility.setAttribute("aria-label", "Show " + channel.label);
	arrange.appendChild(visibility);

	let arrangeName = document.createElement("span");
	arrangeName.className = "name";
	arrangeName.textContent = channel.label;
	arrange.appendChild(arrangeName);

	for(const [action, text] of [["up", "Move up"], ["down", "Move down"]])
	{
		let button = document.createElement("button");
		button.type = "button";
		button.className = action;
		button.dataset.action = action;
		button.dataset.channel = channel.channel;
		button.setAttribute("aria-label", text);
		arrange.appendChild(button);
	}

	return { arrange, arrangeName, visibility };
}

/**
 * The bar at the end of the channel list while arranging: "Reset" and "Done"
 */
const layoutBar = (function()
{
	let bar = document.createElement("div");
	bar.id = "layoutBar";
	for(const [action, text] of [["reset", "Reset"], ["done", "Done"]])
	{
		let button = document.createElement("button");
		button.type = "button";
		button.className = "layout-" + action;
		button.dataset.action = action;
		button.textContent = text;
		bar.appendChild(button);
	}
	return bar;
})();

/**
 * Load the channel order and hidden channels for the selected aux.
 * Channels the admin has since disabled are dropped; newly enabled ones go at the end.
 */
function loadLayout()
{
	channelOrder = adminOrder.slice();
	hiddenChannels = new Set();

	const aux = selectedAux();
	const saved = aux === undefined ? null : auxLayouts[aux];

	if(saved && Array.isArray(saved.order))
	{
		const known = new Set(adminOrder);
		const order = [...new Set(saved.order.map(String))].filter(channel => known.has(channel));
		channelOrder = order.concat(adminOrder.filter(channel => !order.includes(channel)));
	}
	if(saved && Array.isArray(saved.hidden))
	{
		hiddenChannels = new Set(saved.hidden.map(String).filter(channel => channelRows.has(channel)));
	}

	applyLayout();
}

/**
 * Save the layout for the selected aux on the server, which passes it to every other device.
 * The admin's layout isn't stored, so admin changes still reach auxes nobody customised.
 * @returns {boolean} false if it can't be saved right now
 */
function saveLayout()
{
	const aux = selectedAux();
	if(aux === undefined || !canQuery())
	{
		return false;
	}
	const isDefault = hiddenChannels.size == 0 && channelOrder.every((channel, i) => channel === adminOrder[i]);
	if(isDefault)
	{
		delete auxLayouts[aux];
		sendOSC("/Webmixer/Aux/" + aux + "/Layout");
		return true;
	}
	auxLayouts[aux] = { order: channelOrder.map(Number), hidden: [...hiddenChannels].map(Number) };
	sendOSC("/Webmixer/Aux/" + aux + "/Layout", [JSON.stringify(auxLayouts[aux])]);
	return true;
}

/**
 * Position and show/hide the channel rows to match channelOrder and hiddenChannels.
 * A section heading moves with the channel it is attached to.
 */
function applyLayout()
{
	channelOrder.forEach((channel, i) =>
	{
		const row = channelRows.get(channel);
		const hidden = hiddenChannels.has(channel);
		row.wrap.style.order = i;
		if(row.heading)
		{
			row.heading.style.order = i;
		}
		row.wrap.classList.toggle("userHidden", hidden);
		row.visibility.setAttribute("aria-pressed", hidden ? "false" : "true");
		row.visibility.setAttribute("aria-label", (hidden ? "Show " : "Hide ") + row.arrangeName.textContent);
	});
}

/**
 * Handle the arrange controls and the layout bar
 * @param {!Event} e - the click event
 */
function layoutClick(e)
{
	const button = e.target.closest("button[data-action]");
	if(!button || !channelsDiv.contains(button))
	{
		return;
	}
	const action = button.dataset.action;
	const channel = button.dataset.channel;

	if(action == "done")
	{
		setArranging(false);
		return;
	}
	if(!canQuery())
	{
		return; //the layout can't be saved right now
	}
	if(action == "reset")
	{
		if(confirm("Reset the channel order and show all channels on this mix? This changes it for everyone on this mix."))
		{
			channelOrder = adminOrder.slice();
			hiddenChannels = new Set();
			applyLayout();
			saveLayout();
		}
		return;
	}
	if(action == "toggle")
	{
		if(hiddenChannels.has(channel))
		{
			hiddenChannels.delete(channel);
		}
		else
		{
			hiddenChannels.add(channel);
		}
	}
	if(action == "up" || action == "down")
	{
		const i = channelOrder.indexOf(channel);
		const j = action == "up" ? i - 1 : i + 1;
		if(i < 0 || j < 0 || j >= channelOrder.length)
		{
			return;
		}
		[channelOrder[i], channelOrder[j]] = [channelOrder[j], channelOrder[i]];
	}
	applyLayout();
	saveLayout();
	if(action != "toggle")
	{
		channelRows.get(channel).wrap.scrollIntoView({ block: "nearest" });
	}
}
channelsDiv.addEventListener("click", layoutClick);

/**
 * Switch arrange mode on or off
 * @param {boolean} on
 */
function setArranging(on)
{
	document.body.classList.toggle("arranging", on);
	arrangeButton.setAttribute("aria-pressed", on ? "true" : "false");
	arrangeButton.title = on ? "Done arranging" : "Arrange channels";
	if(on)
	{
		channelsWrap.scrollTop = 0;
	}
}
arrangeButton.addEventListener("click", () => setArranging(!document.body.classList.contains("arranging")));

/*
	Connection handling. There is only ever one live socket: an old one has its handlers
	removed and is closed before a new one starts, and events from any socket other than
	the current one are ignored.
*/

/**
 * Close the current socket without letting its events affect anything
 */
function dropSocket()
{
	if(!ws)
	{
		return;
	}
	const old = ws;
	ws = null;
	old.onopen = old.onmessage = old.onclose = old.onerror = null;
	try
	{
		old.close();
	}
	catch(e)
	{
		//ignore
	}
}

/**
 * Start a fresh connection to the server, dropping any existing one
 */
function connect()
{
	clearTimeout(connectTimer);
	clearTimeout(reconnectTimer);
	dropSocket();

	//values are only trusted while connected: a fresh connection asks for everything again
	known.clear();
	anyMessage = false;
	statusSeen = false;
	deskState = null;
	hasConfig = false;
	lastRx = Date.now();
	refreshAllSliders();

	const socket = new WebSocket((location.protocol == "https:" ? "wss://" : "ws://") + location.host + "/?device=" + encodeURIComponent(deviceId));
	ws = socket;
	socket.onopen = function()
	{
		if(this !== ws)
		{
			return;
		}
		clearTimeout(connectTimer);
		lastRx = Date.now();
		updateStatusUI();
	};
	socket.onmessage = function(e)
	{
		if(this !== ws)
		{
			return;
		}
		onMessage(e);
	};
	socket.onclose = socket.onerror = function()
	{
		if(this !== ws)
		{
			return;
		}
		connectionLost();
	};

	/**
	 * Safari on iOS 26.1 only connects to web socket every second page load. Starting a new
	 * socket when the first is still connecting after a moment fixes this.
	 */
	connectTimer = setTimeout(() => {
		if(ws === socket && socket.readyState === WebSocket.CONNECTING)
		{
			connect();
		}
	}, CONNECT_TIMEOUT);

	updateStatusUI();
}

/**
 * The connection closed or failed: show it and try again shortly
 */
function connectionLost()
{
	dropSocket();
	updateStatusUI();
	clearTimeout(connectTimer);
	clearTimeout(reconnectTimer);
	reconnectTimer = setTimeout(connect, RECONNECT_DELAY);
}

/**
 * Watchdog: the server sends a status at least every 5 s, so a long silence means the
 * connection is half-open (Wi-Fi dropped, tablet slept) even if the socket looks open.
 */
setInterval(function()
{
	const now = Date.now();
	if(ws && ws.readyState === WebSocket.OPEN)
	{
		//an older server without keep-alives can be quiet for a long time: only time out
		//once it has shown it sends them, or if it never said anything at all
		if((statusSeen || !anyMessage) && now - lastRx > KEEPALIVE_TIMEOUT)
		{
			connectionLost();
			return;
		}
	}
	if(pendingConfig && now - pendingConfigSince > CONFIG_HOLD_MAX)
	{
		endAllGestures(); //applies the pending config
	}
}, 1000);

document.addEventListener("visibilitychange", function()
{
	if(document.hidden)
	{
		hiddenAt = Date.now();
		endAllGestures();
		return;
	}
	//after a sleep the socket is often dead without knowing it: start again rather than
	//show values that may be stale
	if(!ws || ws.readyState !== WebSocket.OPEN || Date.now() - hiddenAt > HIDDEN_RECONNECT || Date.now() - lastRx > KEEPALIVE_TIMEOUT / 2)
	{
		connect();
	}
});

window.addEventListener("pageshow", function(e)
{
	//restored from the back/forward cache: the old socket is gone
	if(e.persisted)
	{
		endAllGestures();
		connect();
	}
});

window.addEventListener("online", function()
{
	if(!ws || ws.readyState !== WebSocket.OPEN)
	{
		connect();
	}
});

/**
 * When page has loaded
 */
document.addEventListener("DOMContentLoaded", function()
{
	//ensure the browser doesn't remember checked status
	panCheckbox.checked = false;

	connect();

	/**
	 * Handle Aux Select Changes
	 */
	auxSelect.addEventListener("change", function()
	{
		selectAux(false);
		updateStatusUI();
	});

	/**
	 * Handle Panning Checkbox changes
	 */
	panCheckbox.addEventListener("change", function(e)
	{
		document.body.classList.toggle("panning", this.checked);
	});
});

})();

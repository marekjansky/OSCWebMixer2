"use strict";

(() => {

const channelsDiv = document.getElementById('channels'),
auxSelect = document.getElementById('aux'),
panCheckbox = document.getElementById("panning"),
auxiliaries = document.getElementById("auxiliaries"),
snapshot = document.getElementById("snapshot"),
lockButton = document.getElementById("lock");

let ws = null,
timeout = null,
channelInputs = new Map(), //channel number => volume slider
panInputs = new Map(), //channel number => pan slider
groupInputs = new Map(), //group id => group trim slider
lockedAux = null,
unlockNeedsPassword = false,
channelRows = new Map(), //channel number => {wrap, heading, arrangeName, visibility} for enabled channels
adminOrder = [], //enabled channel numbers in the order set in the admin area
channelOrder = [], //enabled channel numbers in this device's order for the selected aux
hiddenChannels = new Set(); //channel numbers this device has hidden for the selected aux

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

	const readout = slider.closest("label").querySelector("output");
	if(!readout)
	{
		return;
	}
	let text;
	if(slider.classList.contains("panInput"))
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
 * Set a slider from a dB value
 * @param {HTMLInputElement} slider
 * @param {number} db
 */
function setSliderDb(slider, db)
{
	slider.value = dbToSlider(db);
	updateSlider(slider, db);
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
 * callback for when a channel volume or pan changes
 * @param {!Event} e - the channel volume/pan change event
 */
function sliderChange(e)
{
	let sliderValue = parseFloat(this.value);

	updateSlider(this);

	if(!ws || selectedAux() === undefined)
	{
		return;
	}

	let parameter = "level";

	if(this.classList.contains("volumeInput"))
	{
		sliderValue = sliderToDb(sliderValue);
	}

	if(this.classList.contains("panInput"))
	{
		parameter = "pan";
	}

	sendOSC("/Input_Channels/" + this.dataset.channel + "/Aux_Send/" + selectedAux() + "/send_" + parameter, [sliderValue]);
}

/**
 * callback for when a group trim fader moves
 * @param {!Event} e - the input event
 */
function groupSliderChange(e)
{
	updateSlider(this);

	if(!ws || selectedAux() === undefined)
	{
		return;
	}

	sendOSC("/Webmixer/Aux/" + selectedAux() + "/Group/" + this.dataset.group + "/level", [sliderToDb(this.value)]);
}

function sendOSC(address, args = [])
{
	if(ws.readyState != WebSocket.OPEN)
	{
		return;
	}
	ws.send(JSON.stringify({
		"address": address,
		"args": args
	}));
}

/**
 * Request current AUX values from server
 */
function requestValues()
{
	const aux = selectedAux();
	if(aux === undefined)
	{
		return;
	}
	for(const channel of channelInputs.keys())
	{
		sendOSC("/Input_Channels/" + channel + "/Aux_Send/" + aux + "/send_level/?");
		sendOSC("/Input_Channels/" + channel + "/Aux_Send/" + aux + "/send_pan/?");
	}
	for(const group of groupInputs.keys())
	{
		sendOSC("/Webmixer/Aux/" + aux + "/Group/" + group + "/level/?");
	}
}

/**
 * Callback for when socket receives a message
 * @param {MessageEvent} e - the message socket event
 */
function onMessage(e)
{
	let json;
	try
	{
		json = JSON.parse(e.data);
	}
	catch(err)
	{
		return;
	}

	//console.log(json);

	//Setup AUX and channels
	if(json.config)
	{
		lockedAux = json.config.lock ? json.config.lock.aux : null;
		unlockNeedsPassword = json.config.unlockNeedsPassword === true;
		updateLockUI();
		snapshot.innerText = json.config.snapshot;
		buildAux(json.config.aux);
		buildChannels(json.config.channels, json.config.groups || []);
		auxSelect.dispatchEvent(new Event("change"));
		return;
	}

	if(typeof json.address !== "string")
	{
		return;
	}

	if(json.address == "/Webmixer/Error")
	{
		alert(json.args[0]);
		return;
	}

	if(json.address == "/SnapshotName")
	{
		snapshot.innerText = json.args[0];
	}

	//update level
	let sendLevel = json.address.match(/^\/Input_Channels\/([0-9]+)\/Aux_Send\/([0-9]+)\/send_level$/);
	if(sendLevel !== null)
	{
		const slider = channelInputs.get(sendLevel[1]);
		if(sendLevel[2] == selectedAux() && slider)
		{
			setSliderDb(slider, parseFloat(json.args[0]));
		}
	}

	//update pan
	let sendPan = json.address.match(/^\/Input_Channels\/([0-9]+)\/Aux_Send\/([0-9]+)\/send_pan$/);
	if(sendPan !== null)
	{
		//0 to +1
		const slider = panInputs.get(sendPan[1]);
		if(sendPan[2] == selectedAux() && slider)
		{
			slider.value = json.args[0];
			updateSlider(slider);
		}
	}

	//update group trim
	let groupLevel = json.address.match(/^\/Webmixer\/Aux\/([0-9]+)\/Group\/([A-Za-z0-9_-]+)\/level$/);
	if(groupLevel !== null)
	{
		const slider = groupInputs.get(groupLevel[2]);
		if(groupLevel[1] == selectedAux() && slider)
		{
			setSliderDb(slider, parseFloat(json.args[0]));
		}
	}

	//update channel names
	let channelNameMatch = json.address.match(/^\/Input_Channels\/([0-9]+)\/Channel_Input\/name$/);
	if(channelNameMatch !== null)
	{
		for(let slider of document.querySelectorAll('input[data-channel="' + channelNameMatch[1] + '"]'))
		{
			slider.closest("label").querySelector(".name").textContent = json.args[0];
		}
		const row = channelRows.get(channelNameMatch[1]);
		if(row)
		{
			row.arrangeName.textContent = json.args[0];
		}
	}

	//update Aux names
	let auxNameMatch = json.address.match(/^\/Aux_Outputs\/([0-9]+)\/Buss_Trim\/name$/);
	if(auxNameMatch !== null)
	{
		//update the select
		for(let option of auxSelect.options)
		{
			if(option.value == auxNameMatch[1])
			{
				option.textContent = json.args[0];

				//make sure the aux span is correct
				auxSelect.previousElementSibling.textContent = auxSelect.getElementsByTagName("option")[auxSelect.selectedIndex].text;
			}
		}

		//update the buttons
		for(let button of auxiliaries.getElementsByTagName("button"))
		{
			if(button.value == auxNameMatch[1])
			{
				button.lastChild.nodeValue = json.args[0];
				return; //no need to update sliders if a button was changed
			}
		}
	}

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
	if(!options)
	{
    	return;
	}

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

		let buttonText = document.createTextNode(option.label);
		button.appendChild(buttonText);



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
 * Reflect the lock state in the page
 */
function updateLockUI()
{
	const locked = lockedAux !== null;
	document.body.classList.toggle("locked", locked);
	auxSelect.disabled = locked;
	lockButton.setAttribute("aria-pressed", locked ? "true" : "false");
	lockButton.title = locked ? "Locked to this mix. Tap to unlock." : "Lock this device to the current mix";
}

/**
 * Lock this device to the selected aux, or unlock it
 */
function lockClick(e)
{
	e.preventDefault();

	if(!ws || ws.readyState != WebSocket.OPEN)
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
	if(e.target.nodeName == "BUTTON" && lockedAux === null)
	{
		auxSelect.value = e.target.value;
		auxSelect.dispatchEvent(new Event("change"));

		document.body.classList.remove("auxPicker");
	}
}
auxiliaries.addEventListener("click", auxPickerClick);

//Detect double tap events for touch devices
let tapedTwice = false;
function tapSlider(e)
{
	if(!tapedTwice)
	{
		tapedTwice = true;
		setTimeout( function() { tapedTwice = false; }, 300 );
		return false;
	}
	resetSlider(e);
}

/**
 * Reset a fader to its default value.
 - Pan sliders will be set to centre
 - Volume sliders will be set to off
 - Group trims will be set to 0 dB (no trim)
 * @param {Event} e - The Tap or Click Event
 */
function resetSlider(e)
{
	if(e.target.classList.contains("volumeInput"))
	{
		e.target.value = 0;
	}

	if(e.target.classList.contains("panInput"))
	{
		e.target.value = 0.5;
	}

	if(e.target.classList.contains("groupInput"))
	{
		e.target.value = dbToSlider(0);
	}

	e.target.dispatchEvent(new Event("input"));
}

/**
 * Build a fader: a label with an optional icon, the name, the slider and a value readout
 * @param {string} type - "volume" or "pan"
 * @param {string} labelText
 * @param {string} iconSrc
 * @param {string} inputClass
 * @param {number} value - initial slider value
 * @returns {{label: HTMLLabelElement, input: HTMLInputElement}}
 */
function createFader(type, labelText, iconSrc, inputClass, value)
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
	input.value = value;
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

	updateSlider(input);

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

		const { label, input } = createFader("volume", group.name, group.icon, "groupInput", dbToSlider(0));
		input.dataset.group = group.id;
		input.addEventListener("input", groupSliderChange);
		groupInputs.set(group.id, input);

		wrap.appendChild(label);
		channelsDiv.appendChild(wrap);
	}

	for(let channel of channels)
	{
		let heading = null;
		if(channel.title != "")
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
			const { label, input } = createFader(type, channel.label, channel.icon, type == "volume" ? "volumeInput" : "panInput", type == "volume" ? 0 : 0.5);
			input.dataset.channel = channel.channel;
			input.addEventListener("input", sliderChange);
			(type == "volume" ? channelInputs : panInputs).set(String(channel.channel), input);
			wrap.appendChild(label);
		}

		channelsDiv.appendChild(wrap);
	}

	channelsDiv.appendChild(layoutBar);

	for(let slider of document.querySelectorAll(".volumeInput, .panInput, .groupInput"))
	{
		slider.addEventListener('touchstart', tapSlider);
		slider.addEventListener('dblclick', resetSlider);
	}
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
 * The bar at the end of the channel list: "Arrange channels", or "Reset" and "Done" while arranging
 */
const layoutBar = (function()
{
	let bar = document.createElement("div");
	bar.id = "layoutBar";
	for(const [action, text] of [["arrange", "Arrange channels"], ["reset", "Reset"], ["done", "Done"]])
	{
		let button = document.createElement("button");
		button.type = "button";
		button.className = action;
		button.dataset.action = action;
		button.textContent = text;
		bar.appendChild(button);
	}
	return bar;
})();

/**
 * localStorage key for this device's channel layout on an aux
 * @param {string} aux
 * @returns {string}
 */
function layoutKey(aux)
{
	return "layout/" + aux;
}

/**
 * Load this device's channel order and hidden channels for the selected aux.
 * Channels the admin has since disabled are dropped; newly enabled ones go at the end.
 */
function loadLayout()
{
	channelOrder = adminOrder.slice();
	hiddenChannels = new Set();

	const aux = selectedAux();
	let saved = null;
	try
	{
		saved = aux === undefined ? null : JSON.parse(storageGet(layoutKey(aux)));
	}
	catch(e)
	{
		saved = null;
	}

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
 * Save the layout for the selected aux. The admin's layout isn't stored, so admin
 * changes still reach devices that never customised anything.
 */
function saveLayout()
{
	const aux = selectedAux();
	if(aux === undefined)
	{
		return;
	}
	const isDefault = hiddenChannels.size == 0 && channelOrder.every((channel, i) => channel === adminOrder[i]);
	storageSet(layoutKey(aux), isDefault ? null : JSON.stringify({ order: channelOrder, hidden: [...hiddenChannels] }));
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

	if(action == "arrange")
	{
		document.body.classList.add("arranging");
		return;
	}
	if(action == "done")
	{
		document.body.classList.remove("arranging");
		return;
	}
	if(action == "reset")
	{
		if(confirm("Reset the channel order and show all channels on this mix?"))
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
 * When socket is connected
 */
function onOpen()
{
	document.body.classList.remove("disconnected");
}

/**
 * When a socket connection fails
 */
function noConnection()
{
	// connection closed, discard old websocket and create a new one in 2s
	if(ws)
	{
		ws.close();
	}
	clearTimeout(timeout);
	timeout = setTimeout(startWebsocket, 2000);
	document.body.classList.add("disconnected");
}

/**
 * Start the connection to the server
 */
function startWebsocket()
{
	ws = new WebSocket("ws://" + document.location.host + "/?device=" + encodeURIComponent(deviceId));
	ws.onopen = onOpen;
	ws.onmessage = onMessage;
	ws.onclose = noConnection;
	ws.onerror = noConnection;

	/**
	 * Safari on iOS 26.1 only connects to web socket every second page load. Calling startWebsocket
	 * again seems to fix this. I don't know why and I can't find any other solutions.
	 */
	clearTimeout(timeout);
	timeout = setTimeout(() => {
		if(ws.readyState === WebSocket.CONNECTING)
		{
			startWebsocket();
		}
	}, 2000);
}



/**
 * When page has loaded
 */
document.addEventListener("DOMContentLoaded", function()
{
	//ensure the browser doesn't remember checked status
	panCheckbox.checked = false;

	startWebsocket();

	/**
	 * Handle Aux Select Changes
	 */
	auxSelect.addEventListener("change", function(e)
	{
		//save aux value so it can be restored
		storageSet("aux", this.value);

		let option = this.getElementsByTagName("option")[this.selectedIndex];

		//set the current page tint
		let colour = option.dataset.colour;
		document.body.style.setProperty('--tint', colour);

		//set the current aux text
		this.previousElementSibling.textContent = option.text;

		this.previousElementSibling.previousElementSibling.src = option.dataset.icon;

		//toggle visibility of the pan checkbox
		if(option.dataset.stereo == "true")
		{
			panCheckbox.parentNode.style.display = "flex";
		}
		else
		{
			panCheckbox.parentNode.style.display = "none";
		}

		//disable panning if it was previously selected
		panCheckbox.checked = false;
		panCheckbox.dispatchEvent(new Event("change"));


		//clear all current values
		for(let slider of channelInputs.values())
		{
			slider.value = 0;
			updateSlider(slider);
		}
		for(let slider of panInputs.values())
		{
			slider.value = 0.5;
			updateSlider(slider);
		}
		for(let slider of groupInputs.values())
		{
			setSliderDb(slider, 0);
		}

		//each aux has its own channel layout on this device
		loadLayout();

		//request all the channel values for the selected aux
		requestValues();
	});

	/**
	 * Handle Panning Checkbox changes
	 */
	panCheckbox.addEventListener("change", function(e)
	{
		if(this.checked)
		{
			document.body.classList.add("panning");
		}
		else
		{
			document.body.classList.remove("panning");
		}
	});
});

})();

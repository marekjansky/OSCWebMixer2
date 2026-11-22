"use strict";

const externalDiv = document.getElementById("externalDevices"),
ipAddress = document.querySelector("input[name=ip_address]"),
serverPort = document.querySelector("input[name=server_port]"),
oscReceivePort = document.querySelector("input[name=osc_port]"),
deskSendPort = document.querySelector("input[name=desk_send_port]"),
deskIP = document.querySelector("input[name=desk_ip]"),
deskReceivePort = document.querySelector("input[name=desk_port]"),
configForm = document.getElementById("configForm"),
debug = document.querySelector("input[name=debug]"),
auxiliaries = document.getElementById("auxiliaries"),
channels = document.getElementById("channels"),
iconDialog = document.getElementById("iconDialog");

let ws = null,
timeout = null,
lastRx = 0,
formDirty = false,
authAlerted = false;

/**
 * fetch wrapper for the authenticated admin API. The browser already holds the
 * Basic-Auth credentials for this origin, so requests just work; if the server
 * still answers 401 (password changed, credentials dropped) say so instead of
 * failing with a confusing JSON parse error.
 * @param {string} url
 * @param {object} options - fetch options
 * @returns {Promise<Response>}
 */
async function apiFetch(url, options = {})
{
	const response = await fetch(url, Object.assign({ credentials: "same-origin" }, options));
	if(response.status == 401)
	{
		if(!authAlerted)
		{
			authAlerted = true;
			alert("Authentication required. Reload this page and log in again.");
			setTimeout(() => { authAlerted = false; }, 30000);
		}
		throw new Error("Not authorised (401)");
	}
	return response;
}

/**
 * Callback for delete button for external devices
 * @param {MouseEvent} e
 */
function deleteExternal(e)
{
	e.preventDefault();
	e.target.closest(".external").remove();
}

/**
 * Update the value of a hidden because checkbox fields don't get sent when blank
 */
function updateCheckboxHiddenField(e)
{
	e.target.nextElementSibling.value = e.target.checked;
}

function clearExternals() {
	externalDiv.innerHTML = ""
}

/**
 * Creates an external device and populates the values
 * @param {string} externalName
 * @param {int} externalIP
 * @param {int} externalReceivePort
 */
function createExternal(externalBroadcast = true, externalName = "", externalIP = "", externalLoopback = false, externalReceivePort = "")
{
	if(externalReceivePort == "")
	{
		externalReceivePort = 9000;
	}

	let wrapper = document.createElement("div");
	wrapper.className = "external";

	let details = document.createElement("div");
	details.className = "details";

	let nameLabel = document.createElement("label");
	nameLabel.textContent = "Name";
	let nameField = document.createElement("input");
	nameField.name="externalName[]";
	nameField.required = true;
	nameField.value = externalName;
	nameLabel.appendChild(nameField);
	details.appendChild(nameLabel);

	let ipLabel = document.createElement("label");
	ipLabel.textContent = "IP Address";
	let ipField = document.createElement("input");
	ipField.name="externalIP[]";
	ipField.required = true;
	ipField.value = externalIP;
	ipField.addEventListener("input", ipAddressCheck);
	ipLabel.appendChild(ipField);
	details.appendChild(ipLabel);

	details.appendChild(createCheckboxField("externalBroadcast[]", externalBroadcast, "Receive Broadcast Messages"));

	details.appendChild(createCheckboxField("externalLoopback[]", externalLoopback, "Receive Own Messages", "By default Webmixer doesn't broadcast messages back to the source IP to prevent message loops. This disables the IP check. Be careful when turning this on."));

	let deviceSettingsWrap = document.createElement("div");
	deviceSettingsWrap.className = "settings";

	let deskTitle = document.createElement("h2");
	deskTitle.textContent = "Device Connection Settings";
	deviceSettingsWrap.appendChild(deskTitle);

	let deskLabel = document.createElement("label");
	deskLabel.textContent = "IP Address";
	let deskField = document.createElement("input");
	deskField.disabled = true;
	deskField.value = ipAddress.value;
	deskField.addEventListener("input", ipAddressCheck);
	deskLabel.appendChild(deskField);
	deviceSettingsWrap.appendChild(deskLabel);

	let sendLabel = document.createElement("label");
	sendLabel.textContent = "Send Port";
	let sendField = document.createElement("input");
	sendField.disabled = true;
	sendField.type = "number";
	sendField.value = oscReceivePort.value;
	sendLabel.appendChild(sendField);
	deviceSettingsWrap.appendChild(sendLabel);

	let receiveLabel = document.createElement("label");
	receiveLabel.textContent = "Receive Port";
	let receiveField = document.createElement("input");
	receiveField.name="externalReceive[]";
	receiveField.required = true;
	receiveField.type = "number";
	receiveField.min = 0;
	receiveField.max = 65353;
	receiveField.value = externalReceivePort;
	receiveLabel.appendChild(receiveField);
	deviceSettingsWrap.appendChild(receiveLabel);


	let deleteButton = document.createElement("button");
	deleteButton.innerHTML = "&times;";
	deleteButton.classList = "delete";
	deleteButton.addEventListener("click", deleteExternal);

	wrapper.appendChild(details);
	wrapper.appendChild(deviceSettingsWrap);
	wrapper.appendChild(deleteButton);

	externalDiv.appendChild(wrapper);

	if(externalName == "")
	{
		nameField.focus();
		nameField.scrollIntoView({behavior: "smooth"});
	}
}

//Handle add external device button
document.getElementById("addExternal").addEventListener("click", (e) => {
	e.preventDefault();
	createExternal();
});

/**
 * Validates that the provided string is a valid IPv4 or IPv6 Address
 * @param {string} ip
 * @returns boolean - true if provided value is a IPv4 or IPv6 address
 */
function isIpAddress(ip)
{
	const ipv4Pattern =  /^(\d{1,3}\.){3}\d{1,3}$/;
	const ipv6Pattern =  /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
	return ipv4Pattern.test(ip) || ipv6Pattern.test(ip);
}

/**
 * Handle input events for ip address fields to ensure the validity message is correct.
 * @param {KeyEvent} e
 */
function ipAddressCheck(e)
{
	if(isIpAddress(e.target.value))
	{
		e.target.setCustomValidity("");
	}
	else
	{
		e.target.setCustomValidity("Please enter a valid IP address");
	}
}

deskIP.addEventListener("input", ipAddressCheck);

/**
 * Submit the config form via fetch instead of a real page navigation, so the
 * currently selected tab isn't lost when the server re-sends admin.html.
 * @returns {Promise<boolean>} true if the settings were saved, false if the
 * form was invalid or the page is redirecting to a new port.
 */
async function submitConfigForm()
{
	if(!configForm.checkValidity())
	{
		configForm.reportValidity();
		return false;
	}

	const response = await apiFetch(configForm.action, {
		method: "POST",
		body: new URLSearchParams(new FormData(configForm))
	});

	//if the server port changed, it sends a redirect script since it's now listening on a different port
	const text = await response.text();
	const redirect = text.match(/document\.location\.href="([^"]+)"/);
	if(redirect)
	{
		document.location.href = redirect[1];
		return false;
	}

	if(!response.ok)
	{
		alert("Saving the settings failed: " + (text.replace(/<[^>]*>/g, "").trim().slice(0, 200) || response.status));
		return false;
	}

	//the server no longer disconnects clients on save, so refresh the lists ourselves
	reloadLists();
	return true;
}

configForm.addEventListener("input", () => { formDirty = true; });
configForm.addEventListener("change", () => { formDirty = true; });

configForm.addEventListener("submit", async (e) => {
	e.preventDefault();
	await submitConfigForm();
});

/**
 * Create a checkbox field that sends a value if it is checked or not checked.
 * By default checkbox fields don't send a value when unchecked.
 * @param {string} name - the field name
 * @param {boolean} checked - whether or not the field should be checked
 * @param {string} label - the label for the field
 * @param {string} tooltip - optional tooltip for the field
 * @param {string} labelClass - optional class for the label
 * @returns {DomElement} - the checkbox field element
 */
function createCheckboxField(name, checked, label, tooltip = "", labelClass = "")
{
	const checkboxField = document.createElement("input");
	const checkboxLabel = document.createElement("label");

	if (labelClass != "")
	{
		checkboxLabel.className = labelClass;
	}

	const checkboxText = document.createTextNode(label);
	const checkboxHiddenField = document.createElement("input");

	checkboxHiddenField.type = "hidden";
	checkboxHiddenField.name = name;
	checkboxHiddenField.value = checked;

	checkboxField.type = "checkbox";
	checkboxField.checked = checked;
	checkboxField.addEventListener("change", updateCheckboxHiddenField);

	checkboxLabel.appendChild(checkboxField);
	checkboxLabel.appendChild(checkboxHiddenField);
	checkboxLabel.appendChild(checkboxText);

	if(tooltip != "")
	{
		const tooltipWrap = document.createElement("span");
		tooltipWrap.innerHTML = "i";
		tooltipWrap.className = "tooltip";
		tooltipWrap.title = tooltip;
		checkboxLabel.appendChild(tooltipWrap);
	}


	return checkboxLabel;
}

let iconTarget = null;
function iconClick(e)
{
	e.preventDefault();
	iconTarget = e.target;
	iconDialog.showModal();
}

iconDialog.addEventListener("click", (e) => {
	e.preventDefault();
	if(e.target.src)
	{
		let src = e.target.src;

		//is the src the blank svg?
		if(src.startsWith("data"))
		{
			src = "";
		}
		else
		{
			//remove hostname from the src
			src = e.target.src.substring(window.location.origin.length);
		}
		iconTarget.src = e.target.src;
		iconTarget.nextElementSibling.value = src;
	}
	iconDialog.close();
})

/**
 * Add an icon picker to a dom element
 * @param {DomElement} element - the element to add the picker to
 * @param {string} name - the input name of the hidden field
 * @param {string} icon - the icon src to set to
 */
function addIconPicker(element, name, icon)
{
	let iconImg = document.createElement("img");
	iconImg.src = icon == "" ? "data:image/svg+xml;charset=utf8,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%3E%3C/svg%3E" : icon;
	iconImg.className = "icon";
	iconImg.width = 44;
	iconImg.height = 44;
	iconImg.addEventListener("click", iconClick);
	element.appendChild(iconImg);

	let iconHidden = document.createElement("input");
	iconHidden.type = "hidden";
	iconHidden.value = icon;
	iconHidden.name = name;
	element.appendChild(iconHidden);
}

/**
 * Create an Auxilary
 * @param {int} number - the aux number
 * @param {boolean} enabled - wether or not the auxilary is enabled
 * @param {string} name - the name of the auxilary
 * @param {string} colour - the colour of the auxilary
 * @param {string} icon - the icon for the auxilary
 */
/**
 * Highlight a list row whose desk name changed and hasn't been confirmed
 * @param {DomElement} row
 * @param {string|null} previousName
 */
function markChanged(row, previousName)
{
	if(previousName === null || previousName === undefined)
	{
		return;
	}
	row.classList.add("changed-row");
	row.title = "Changed on the desk, was '" + previousName + "'. Confirm it on the Status tab.";
	const note = document.createElement("span");
	note.className = "changed-note";
	note.textContent = "was '" + previousName + "'";
	row.appendChild(note);
}

function createAux(number, enabled, name, colour, icon, previousName = null)
{
	let auxWrap = document.createElement("div");
	markChanged(auxWrap, previousName);

	let channelNumberLabel = document.createElement("label");
	channelNumberLabel.className = "listNumber";
	channelNumberLabel.innerHTML = String(number).padStart(2, "0");
	auxWrap.appendChild(channelNumberLabel);

	auxWrap.appendChild(createCheckboxField("auxEnabled[]", enabled, "", "", "enabled"));

	let auxNameLabel = document.createElement("label");
	let auxName = document.createElement("input");
	auxName.name = "auxName[]";
	auxName.value = name;
	auxNameLabel.appendChild(auxName);
	auxWrap.appendChild(auxNameLabel);

	let auxColourLabel = document.createElement("label");
	let auxColour = document.createElement("input");
	auxColour.name = "auxColour[]";
	auxColour.value = colour;
	auxColour.type = "color";
	auxColourLabel.appendChild(auxColour);
	auxWrap.appendChild(auxColourLabel);

	addIconPicker(auxWrap, "auxIcon[]", icon);

	let sends = document.createElement("span");
	sends.className = "all-sends";
	for(const [text, on] of [["All sends ON", true], ["All OFF", false]])
	{
		let button = document.createElement("button");
		button.type = "button";
		button.textContent = text;
		button.title = (on ? "Switch on" : "Switch off") + " the send of every enabled channel to this aux on the desk";
		button.addEventListener("click", () => switchAllSends(number, auxName.value, on));
		sends.appendChild(button);
	}
	auxWrap.appendChild(sends);

	auxiliaries.appendChild(auxWrap);
}

function moveup(e)
{
	e.preventDefault();

	let currentOrder =  parseInt(getComputedStyle(e.target.parentNode).order);
	if(currentOrder == 1)
	{
		return;
	}

	for(let channel of channels.childNodes)
	{
		let channelOrder =  parseInt(getComputedStyle(channel).order);
		if(channelOrder == currentOrder - 1)
		{
			channel.style.order = channelOrder + 1;
			channel.querySelector('input[name="channelOrder[]"]').value = channelOrder + 1;
			break;
		}
	}

	e.target.parentNode.style.order = currentOrder - 1;
	e.target.parentNode.querySelector('input[name="channelOrder[]"]').value = currentOrder - 1;

	ensureValidOrder(channels.childNodes, "channelOrder[]");
}

function movedown(e)
{
	e.preventDefault();

	let currentOrder =  parseInt(getComputedStyle(e.target.parentNode).order);
	if(currentOrder == channels.childNodes.length)
	{
		return;
	}

	for(let channel of channels.childNodes)
	{
		let channelOrder =  parseInt(getComputedStyle(channel).order);
		if(channelOrder == currentOrder + 1)
		{
			channel.style.order = channelOrder - 1;
			channel.querySelector('input[name="channelOrder[]"]').value = channelOrder - 1;
			break;
		}
	}

	e.target.parentNode.style.order = currentOrder + 1;

	e.target.parentNode.querySelector('input[name="channelOrder[]"]').value = currentOrder + 1;

	ensureValidOrder(channels.childNodes, "channelOrder[]");
}

/**
 * Create a Channel
 * @param {int} number - the channel number
 * @param {boolean} enabled - whether or not the channel is enabled
 * @param {string} name - the name of the channel
 * @param {integer} order - the position of the channel
 * @param {string} icon - the icon for the channel
 * @param {string} title - the section title
 * @param {string} group - the id of the group the channel belongs to
 */
function createChannel(number, enabled, name, order, icon="", title="", group="", previousName = null)
{
	let channelWrap = document.createElement("div");
	markChanged(channelWrap, previousName);
	channelWrap.style.order = order;

	let channelNumberLabel = document.createElement("label");
	channelNumberLabel.className = "listNumber";
	channelNumberLabel.innerHTML = String(number).padStart(2, "0");
	channelWrap.appendChild(channelNumberLabel);

	let sectionTitleLabel = document.createElement("label");

	let sectionTitle = document.createElement("input");
	sectionTitle.name = "sectionTitle[]";
	sectionTitle.placeholder = "Section Title";
	sectionTitle.value = title;
	sectionTitleLabel.appendChild(sectionTitle);
	channelWrap.appendChild(sectionTitleLabel);

	//channelWrap.draggable = true;
	//channelWrap.droppable = true;

	channelWrap.appendChild(createCheckboxField("channelEnabled[]", enabled, "", "", "enabled"));

	let channelNameLabel = document.createElement("label");
	let channelName = document.createElement("input");
	channelName.name = "channelName[]";
	channelName.value = name;
	channelNameLabel.appendChild(channelName);
	channelWrap.appendChild(channelNameLabel);

	addIconPicker(channelWrap, "channelIcon[]", icon);

	let groupLabel = document.createElement("label");
	let groupSelect = document.createElement("select");
	groupSelect.name = "channelGroup[]";
	groupSelect.className = "channel-group";
	groupSelect.title = "Group";
	groupSelect.dataset.value = group;
	groupLabel.appendChild(groupSelect);
	channelWrap.appendChild(groupLabel);

	let moveUp = document.createElement("button");
	moveUp.className = "up";
	moveUp.addEventListener("click", moveup);
	channelWrap.appendChild(moveUp);

	let moveDown = document.createElement("button");
	moveDown.className = "down";
	moveDown.addEventListener("click", movedown);
	channelWrap.appendChild(moveDown);

	let orderInput = document.createElement("input");
	orderInput.type = "hidden";
	orderInput.name = "channelOrder[]";
	orderInput.value = order;
	channelWrap.appendChild(orderInput);

	channels.appendChild(channelWrap);

	//makeDraggable(channelWrap);
}

/**
 * Find the enable checkboxes for the list a selection button belongs to. Each
 * set of buttons sits in a .button-row inside the same <section> as the list
 * it controls.
 * @param {DomElement} button - the clicked selection button
 * @returns {NodeListOf<HTMLInputElement>}
 */
function selectionCheckboxes(button)
{
	return button.closest("section").querySelectorAll('label.enabled > input[type="checkbox"]');
}

/**
 * Set every enable checkbox in a list to the same state.
 * @param {DomElement} button - the clicked selection button
 * @param {boolean} checked
 */
function setSelection(button, checked)
{
	for(let checkbox of selectionCheckboxes(button))
	{
		checkbox.checked = checked;
		checkbox.dispatchEvent(new Event("change"));
	}
}

/**
 * Flip every enable checkbox in a list.
 * @param {MouseEvent} e
 */
function invertSelection(e)
{
	e.preventDefault();

	for(let checkbox of selectionCheckboxes(this))
	{
		checkbox.checked = !checkbox.checked;
		checkbox.dispatchEvent(new Event("change"));
	}
}

for(let button of document.querySelectorAll(".enable-all"))
{
	button.addEventListener("click", function(e) { e.preventDefault(); setSelection(this, true); });
}
for(let button of document.querySelectorAll(".disable-all"))
{
	button.addEventListener("click", function(e) { e.preventDefault(); setSelection(this, false); });
}
for(let button of document.querySelectorAll(".invert-selection"))
{
	button.addEventListener("click", invertSelection);
}

/*let dropTarget = undefined;
let dragged = undefined;
function makeDraggable(target)
{
	target.addEventListener("dragstart", e => {
		dragged = e.target;
		dragged.classList.add("dragging");
		e.dataTransfer.setData("text/plain", "data");
	});

	target.addEventListener("dragover", e => {
		e.preventDefault();
		dropTarget = e.target.closest("[draggable]");
		dropTarget.classList.add("dragTarget");
	});

	target.addEventListener("dragleave", e => {
		e.preventDefault();
		dropTarget.classList.remove("dragTarget");
	});

	target.addEventListener("drop", e => {
		e.preventDefault();
		dropTarget.classList.remove("dragTarget");

		dropTarget.before(dragged);

		dragged.classList.remove("dragging");

		dragged = undefined;
		dropTarget = undefined;
	});
}*/

//load current config and populate fields
function loadConfig()
{
	fetch("/config")
		.then((response) => response.json())
		.then((json) => {

			let deskPort = 9000;
			if(json.desk.port != "")
			{
				deskPort = json.desk.port;
			}

			ipAddress.value = json.server.ip;
			serverPort.value = json.server.port;
			oscReceivePort.value = json.osc.port;
			deskSendPort.value = json.osc.port;
			deskIP.value = json.desk.ip == "" ? json.server.ip.replace(/\.\d+$/, "") + "." : json.desk.ip;
			deskReceivePort.value = deskPort;
			debug.checked = json.debug == true;
	
			clearExternals();
			for(let external of json.externalDevices)
			{
				createExternal(external.broadcast, external.name, external.ip, external.loopback, external.port);
			}
		});
}
loadConfig();

function fetchAux()
{
	fetch("/aux")
		.then((response) => response.json())
		.then((json) => {

			if(json.length == 0)
			{
				auxiliaries.innerHTML = '<p class="notice">No Auxiliaries Loaded</p>';
				setTimeout(fetchAux, 5000); //try again later
				return;
			}

			auxiliaries.innerHTML = "";

			for(let [index, aux] of json.entries())
			{
				createAux(index + 1, aux.enabled, aux.name, aux.colour, aux.icon, aux.previousName ?? null);
			}
		});
}
fetchAux();

function fetchChannels()
{
	fetch("/channels")
		.then((response) => response.json())
		.then((json) => {

			if(json.length == 0)
			{
				channels.innerHTML = '<p class="notice">No Channels Loaded</p>';
				setTimeout(fetchChannels, 5000); //try again later
				return;
			}

			channels.innerHTML = "";

			for(let [index, channel] of json.entries())
			{
				createChannel(index + 1, channel.enabled, channel.name, channel.order, channel.icon, channel.title, channel.group || "", channel.previousName ?? null);
			}

			ensureValidOrder(channels.childNodes, "channelOrder[]");
			refreshGroupSelects();
		});
}
fetchChannels();

/**
 * Reload every list from the server (after a save, or when the server pushes a new config)
 */
function reloadLists()
{
	loadConfig();
	fetchAux();
	fetchGroups();
	fetchChannels();
	formDirty = false;
	staleNotice.hidden = true;
}

/**
 * Make sure the order of node elements are valid.
 * This is only necessary if the order gets out of wack. It should only get messed up if the channel list grows or shrinks.
 * @param {DOMElement} nodes - the dom nodes to check
 * @param {string} hiddenName - the name for hidden field that stores the order value
 */
function ensureValidOrder(nodes, hiddenName)
{
	//create an array of dom elements and the current order value
	let toSort = [];
	for(let node of nodes)
	{
		toSort.push({
			elm: node,
			order: parseInt(getComputedStyle(node).order)
		})
	}

	//sort the array by the order
	toSort.sort((a, b) => a.order > b.order ? 1 : -1);

	//loop through each element and update the order with a valid value
	for(let [index, node] of toSort.entries())
	{
		node.elm.style.order = index + 1;
		node.elm.querySelector('input[name="' + hiddenName + '"]').value = index + 1;
	}
}

function navClick(e)
{
	hideSections();
	document.getElementById(e.target.hash.substr(1) + "-content").classList.add("show");
	e.target.classList.add("selected");
}

function hideSections()
{
	for(let tab of document.querySelectorAll("nav .selected"))
	{
		tab.classList.remove("selected");
	}
	for(let section of document.querySelectorAll("section.show"))
	{
		section.classList.remove("show");
	}
}

let navTabs = document.querySelectorAll("nav a");
for(let tab of navTabs)
{
	tab.addEventListener("click", navClick);
}

//load a specific tab if a hash exists
if(document.location.hash != "")
{
	document.querySelector('nav a[href="' + document.location.hash + '"]').dispatchEvent(new Event("click"));
}



/**
 * Callback for when socket receives a message
 * @param SocketEvent e - the message socket event
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

	//any message counts as liveness (see the watchdog below)
	lastRx = Date.now();

	//the server pushes a fresh config whenever the desk structure, a preset or the admin settings change
	if(json.config)
	{
		if(formDirty)
		{
			showStaleNotice();
		}
		else
		{
			reloadLists();
		}
		pollStatus();
		return;
	}

	if(!json.address)
	{
		return;
	}

	if(json.address == "/Webmixer/Status")
	{
		try
		{
			applyDeskState(JSON.parse(json.args[0]).desk);
		}
		catch(err)
		{
		}
		return;
	}

	//update channel names
	let channelNameMatch = json.address.match(/^\/Input_Channels\/([0-9]+)\/Channel_Input\/name$/);
	if(channelNameMatch !== null)
	{
		const row = channels.childNodes[channelNameMatch[1]-1];
		if(!row)
		{
			return;
		}
		const input = row.querySelector('input[name="channelName[]"]')
		if(!input)
		{
			return;
		}
		input.value = json.args[0];
	}

	//update Aux names
	let auxNameMatch = json.address.match(/^\/Aux_Outputs\/([0-9]+)\/Buss_Trim\/name$/);
	if(auxNameMatch !== null)
	{
		const row = auxiliaries.childNodes[auxNameMatch[1]-1];
		if(!row)
		{
			return;
		}
		const input = row.querySelector('input[name="auxName[]"]')
		if(!input)
		{
			return;
		}
		input.value = json.args[0];
	}
}

const WEBSOCKET_TIMEOUT = 2000;

/**
 * When socket is connected
 */
function onOpen()
{
	clearTimeout(timeout);

	document.body.classList.remove("disconnected");

	lastRx = Date.now();

	//make sure we have the latest whenever the socket (re)connects, unless the user is mid-edit
	if(formDirty)
	{
		showStaleNotice();
	}
	else
	{
		reloadLists();
	}
	pollStatus();
}

/**
 * When a socket connection fails
 */
function noConnection()
{
	document.body.classList.add("disconnected");

	clearTimeout(timeout);
	timeout = setTimeout(startWebsocket, WEBSOCKET_TIMEOUT);
}

/**
 * Start the connection to the server
 */
function startWebsocket()
{
	if(ws)
	{
		ws.close();
	}
	ws = new WebSocket((document.location.protocol == "https:" ? "wss://" : "ws://") + document.location.host);
	lastRx = Date.now();
	ws.onopen = onOpen;
	ws.onmessage = onMessage;
	ws.onclose = noConnection;
	ws.onerror = noConnection;

	//retry connection in 2 seconds
	clearTimeout(timeout);
	timeout = setTimeout(startWebsocket, WEBSOCKET_TIMEOUT);
}


startWebsocket();

//the server sends a keep-alive every 5 s; more than 12 s of silence means the connection is dead
setInterval(() => {
	if(ws && ws.readyState == WebSocket.OPEN && Date.now() - lastRx > 12000)
	{
		const dead = ws;
		ws = null;
		dead.onclose = dead.onerror = dead.onmessage = null;
		try { dead.close(); } catch(err) {}
		noConnection();
	}
}, 2000);

/**
 * Tell the user the server changed things while they have unsaved edits
 */
function showStaleNotice()
{
	staleNotice.hidden = false;
}


function refreshPresetList() {
    apiFetch('/api/presets')
        .then(res => {
            if (!res.ok) throw new Error('Network response was not ok');
            return res.json();
        })
        .then(presets => {
            const listContainer = document.getElementById('preset-list');

            if (!presets || presets.length === 0) {
                listContainer.innerHTML = '<p class="notice">No presets found</p>';
                return;
            }

            listContainer.innerHTML = presets.map(p => {
                const date = new Date(p.lastChanged);
                const dateString = date.toLocaleDateString() + ', ' + 
                                 date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

                return `
                    <div class="preset-item" data-id="${p.uuid}">
                        <div class="preset-info">
                            <span class="name">${p.name}</span>
                            <span class="date">${dateString}</span>
                        </div>
                        <div class="preset-actions">
                            <button type="button" class="btn-load" onclick="loadPreset(event)">Load</button>
                            <button type="button" class="btn-delete" onclick="deletePreset(event)">Delete</button>
                        </div>
                    </div>
                `;
            }).join('');
        })
        .catch(err => {
            console.error("Failed to refresh presets:", err);
        });
}
refreshPresetList()

document.getElementById("refresh-presets").addEventListener("click", async (e) => {
	e.preventDefault()
	refreshPresetList();
});


async function savePreset() {
	const nameInput = document.getElementById("new-preset-name");
	const name = nameInput.value.trim()

	if (!name) {
		alert("Please enter a name for the preset.");
		return;
	}

	try {
		// persist the current settings first so the preset captures the latest
		// edits, not just whatever was last saved
		if (!(await submitConfigForm())) {
			return;
		}

		const response = await apiFetch('/api/presets/save-current-state', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name })
		});

		const data = await response.json();

		if (!response.ok) {
			throw new Error(data.message || "Something went wrong");
		}

		// Success Path
		nameInput.value = '';
		refreshPresetList();
		console.log("Success:", data.message);

	} catch (err) {
		// Catches the 'throw' above OR network/parsing failures
		alert(err.message);
		console.error("Save error:", err);
	}
}

document.getElementById("save-preset").addEventListener("click", async (e) => {
	e.preventDefault();
	await savePreset();
})

async function loadPreset(event) {
	event.preventDefault()

	const presetItem = event.target.closest('.preset-item');
	const uuid = presetItem.getAttribute('data-id');
	const presetName = presetItem.querySelector('.name').textContent;

	if (confirm(`Load preset "${presetName}"?`)) {
		const response = await apiFetch(`/api/presets/${uuid}/load`, { method: 'POST' });
		if (!response.ok) {
			const data = await response.json();
			alert(data.message);
			return;
		}

		reloadLists();
	}
}

async function deletePreset(event) {
	event.preventDefault()

	const presetItem = event.target.closest('.preset-item');
	const uuid = presetItem.getAttribute('data-id');
	const presetName = presetItem.querySelector('.name').textContent;

	if (confirm(`Delete preset "${presetName}"?`)) {
		const response = await apiFetch(`/api/presets/${uuid}`, { method: 'DELETE' });
		if (!response.ok) {
			const data = await response.json();
			alert(data.message);
			return;
		}

		refreshPresetList();
	}
}



/**
 * Locked devices
 */
const deviceList = document.getElementById("device-list"),
devicesPasswordWarning = document.getElementById("devices-password-warning");

/**
 * Build a single device row
 * @param {{id: string, aux: number|null, auxName: string, ip: string, lockedAt: string|null, connected: boolean}} device
 * @param {{name: string}[]} auxes - the auxes from /aux
 * @returns {HTMLElement}
 */
function createDeviceRow(device, auxes)
{
	const row = document.createElement("div");
	row.className = "device-item";

	const info = document.createElement("div");
	info.className = "device-info";

	const name = document.createElement("span");
	name.className = "name";
	name.textContent = device.aux ? "Locked to " + device.aux + ": " + device.auxName : "Not locked";
	info.appendChild(name);

	const details = document.createElement("span");
	details.className = "date";
	let detailText = (device.connected ? "Connected" : "Offline") + " · " + (device.ip || "unknown IP") + " · ID " + device.id.slice(0, 8);
	if(device.lockedAt)
	{
		const date = new Date(device.lockedAt);
		detailText += " · since " + date.toLocaleDateString() + ", " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	}
	details.textContent = detailText;
	info.appendChild(details);

	row.classList.toggle("connected", device.connected);
	row.appendChild(info);

	const actions = document.createElement("div");
	actions.className = "device-actions";

	const select = document.createElement("select");
	for(const [index, aux] of auxes.entries())
	{
		const option = document.createElement("option");
		option.value = index + 1;
		option.textContent = (index + 1) + ": " + aux.name;
		select.appendChild(option);
	}
	if(device.aux)
	{
		select.value = device.aux;
	}
	actions.appendChild(select);

	const lock = document.createElement("button");
	lock.type = "button";
	lock.textContent = device.aux ? "Change" : "Lock";
	lock.addEventListener("click", () => deviceAction(device.id, "lock", { aux: parseInt(select.value, 10) }));
	actions.appendChild(lock);

	if(device.aux)
	{
		const unlock = document.createElement("button");
		unlock.type = "button";
		unlock.className = "btn-delete";
		unlock.textContent = "Unlock";
		unlock.addEventListener("click", () => {
			if(confirm("Unlock this device?"))
			{
				deviceAction(device.id, "unlock");
			}
		});
		actions.appendChild(unlock);
	}

	row.appendChild(actions);
	return row;
}

/**
 * Lock or unlock a device
 * @param {string} id - device ID
 * @param {"lock"|"unlock"} action
 * @param {object} body
 */
async function deviceAction(id, action, body = {})
{
	const response = await apiFetch("/api/devices/" + encodeURIComponent(id) + "/" + action, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body)
	});
	if(!response.ok)
	{
		let message = "Request failed.";
		try
		{
			message = (await response.json()).message || message;
		}
		catch(e)
		{
			//ignore
		}
		alert(message);
	}
	refreshDeviceList();
}

/**
 * Load the list of locked and connected devices
 */
async function refreshDeviceList()
{
	try
	{
		const [devicesResponse, auxResponse] = await Promise.all([
			apiFetch("/api/devices", { cache: "no-store" }),
			fetch("/aux", { cache: "no-store" })
		]);
		const { devices, unlockNeedsPassword } = await devicesResponse.json();
		const auxes = await auxResponse.json();

		devicesPasswordWarning.hidden = unlockNeedsPassword;

		deviceList.innerHTML = "";
		if(devices.length == 0)
		{
			deviceList.innerHTML = '<p class="notice">No webmixer devices connected or locked</p>';
			return;
		}

		//locked first, then connected
		devices.sort((a, b) => (b.aux ? 1 : 0) - (a.aux ? 1 : 0) || (b.connected ? 1 : 0) - (a.connected ? 1 : 0));
		for(const device of devices)
		{
			deviceList.appendChild(createDeviceRow(device, auxes));
		}
	}
	catch(err)
	{
		console.error("Failed to refresh devices:", err);
	}
}

document.getElementById("refresh-devices").addEventListener("click", (e) => {
	e.preventDefault();
	refreshDeviceList();
});
document.querySelector('nav a[href="#devices"]').addEventListener("click", refreshDeviceList);
refreshDeviceList();


/**
 * Channel groups
 */
const groupsDiv = document.getElementById("groups");

/**
 * Create a random group id
 * @returns {string}
 */
function newGroupId()
{
	return [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Create a group row in the Groups tab
 * @param {string} id
 * @param {string} name
 * @param {string} icon
 */
function createGroup(id = newGroupId(), name = "", icon = "")
{
	const groupWrap = document.createElement("div");
	groupWrap.className = "group-row";

	const idField = document.createElement("input");
	idField.type = "hidden";
	idField.name = "groupId[]";
	idField.value = id;
	groupWrap.appendChild(idField);

	const nameLabel = document.createElement("label");
	const nameField = document.createElement("input");
	nameField.name = "groupName[]";
	nameField.placeholder = "Group name, e.g. Drums";
	nameField.value = name;
	nameField.addEventListener("input", refreshGroupSelects);
	nameLabel.appendChild(nameField);
	groupWrap.appendChild(nameLabel);

	addIconPicker(groupWrap, "groupIcon[]", icon);

	const deleteButton = document.createElement("button");
	deleteButton.type = "button";
	deleteButton.innerHTML = "&times;";
	deleteButton.className = "delete";
	deleteButton.addEventListener("click", (e) => {
		e.preventDefault();
		groupWrap.remove();
		refreshGroupSelects();
	});
	groupWrap.appendChild(deleteButton);

	groupsDiv.appendChild(groupWrap);
	refreshGroupSelects();
	return nameField;
}

/**
 * The groups currently in the Groups tab (including unsaved edits)
 * @returns {{id: string, name: string}[]}
 */
function currentGroups()
{
	return [...groupsDiv.querySelectorAll(".group-row")].map((row, index) => ({
		id: row.querySelector('input[name="groupId[]"]').value,
		name: row.querySelector('input[name="groupName[]"]').value || "Group " + (index + 1)
	}));
}

/**
 * Rebuild the options of every channel's group select, keeping the selected group
 */
function refreshGroupSelects()
{
	const groups = currentGroups();
	for(const select of document.querySelectorAll('select[name="channelGroup[]"]'))
	{
		const selected = select.dataset.value ?? select.value;
		delete select.dataset.value;
		select.innerHTML = "";

		const none = document.createElement("option");
		none.value = "";
		none.textContent = "No group";
		select.appendChild(none);

		for(const group of groups)
		{
			const option = document.createElement("option");
			option.value = group.id;
			option.textContent = group.name;
			select.appendChild(option);
		}
		select.value = groups.some(group => group.id === selected) ? selected : "";
	}
}

document.getElementById("addGroup").addEventListener("click", (e) => {
	e.preventDefault();
	createGroup().focus();
});

function fetchGroups()
{
	fetch("/groups", { cache: "no-store" })
		.then((response) => response.json())
		.then((json) => {
			groupsDiv.innerHTML = "";
			for(const group of json)
			{
				createGroup(group.id, group.name, group.icon || "");
			}
			refreshGroupSelects();
		});
}
fetchGroups();


/**
 * Status tab, desk banner and identity-change banner
 */
const deskBanner = document.getElementById("deskBanner"),
identityBanner = document.getElementById("identityBanner"),
statusDesk = document.getElementById("status-desk"),
statusClients = document.getElementById("status-clients"),
navStatusDot = document.getElementById("navStatusDot"),
staleNotice = document.createElement("div");

staleNotice.className = "banner banner-warn";
staleNotice.hidden = true;
staleNotice.appendChild(document.createTextNode("The server's configuration changed while you have unsaved edits. "));
{
	const reload = document.createElement("button");
	reload.type = "button";
	reload.textContent = "Discard my edits and reload";
	reload.addEventListener("click", () => { staleNotice.hidden = true; reloadLists(); });
	staleNotice.appendChild(reload);
	document.body.insertBefore(staleNotice, document.body.firstChild);
}

let statusFailures = 0;

/**
 * Format a duration in ms as a short "x s ago" string
 * @param {number|null} ms
 * @returns {string}
 */
function ago(ms)
{
	if(ms === null || ms === undefined)
	{
		return "never";
	}
	const s = Math.round(ms / 1000);
	if(s < 60) return s + " s ago";
	if(s < 3600) return Math.floor(s / 60) + " min " + (s % 60) + " s ago";
	return Math.floor(s / 3600) + " h " + Math.floor((s % 3600) / 60) + " min ago";
}

/**
 * Show the desk state in the banner and on the nav dot (used by both the status poll and the websocket)
 * @param {string} state - "online", "offline", "loading" or "unreachable"
 * @param {object} desk - optional desk details from /api/status
 */
function applyDeskState(state, desk)
{
	navStatusDot.className = "status-dot " + (state || "");
	if(state == "online")
	{
		deskBanner.hidden = true;
		return;
	}
	const target = desk && desk.ip ? " (" + desk.ip + ":" + desk.port + ")" : "";
	let text;
	if(state == "offline") text = "MIXING DESK NOT RESPONDING" + target + ". Musicians' faders are disabled and values may be stale.";
	else if(state == "loading") text = "Waiting for the mixing desk" + target + ". Loading desk data, mixers are on hold.";
	else if(state == "unreachable") text = "Cannot reach the webmixer server. Status unknown.";
	else return;
	deskBanner.textContent = text;
	deskBanner.hidden = false;
}

/**
 * Render the "desk name changed" banner
 * @param {Array} changes - identityChanges from /api/status
 */
function renderIdentityChanges(changes)
{
	//don't rebuild while a button is being pressed/confirmed
	const key = JSON.stringify(changes);
	if(identityBanner.dataset.key === key)
	{
		return;
	}
	identityBanner.dataset.key = key;

	identityBanner.innerHTML = "";
	identityBanner.hidden = changes.length == 0;
	if(changes.length == 0)
	{
		return;
	}

	const title = document.createElement("div");
	title.textContent = "The desk reports changed names. Confirm what should happen to the settings:";
	identityBanner.appendChild(title);

	//auxes/channels that moved to another number (desk restructure): follow them all at once
	for(const type of ["aux", "channel"])
	{
		const moved = changes.filter(change => change.type == type && change.movedFrom);
		if(moved.length == 0)
		{
			continue;
		}
		const row = document.createElement("div");
		row.className = "identity-change identity-follow";
		const plural = type == "aux" ? (moved.length == 1 ? "aux" : "auxes") : (moved.length == 1 ? "channel" : "channels");
		row.appendChild(document.createTextNode(moved.length + " " + plural + " moved to a different number on the desk. "));
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = "Follow the moved " + plural;
		button.title = "Moves their colour, icon, settings, layouts" + (type == "aux" ? " and locked devices" : "") + " to the new numbers";
		button.addEventListener("click", () => followMoves(type, row));
		row.appendChild(button);
		identityBanner.appendChild(row);
	}

	for(const change of changes)
	{
		const row = document.createElement("div");
		row.className = "identity-change";
		const label = change.type == "aux" ? "Aux" : "Channel";
		row.appendChild(document.createTextNode(change.movedFrom
			? label + " '" + change.currentName + "' moved from " + change.movedFrom + " to " + change.number + (change.previousName ? " (was '" + change.previousName + "')" : "")
			: label + " " + change.number + " was '" + change.previousName + "', now '" + change.currentName + "'"));

		for(const [text, keep] of [["Keep settings", true], ["Reset to defaults", false]])
		{
			const button = document.createElement("button");
			button.type = "button";
			button.textContent = text;
			button.addEventListener("click", () => confirmIdentity(change, keep, row));
			row.appendChild(button);
		}
		identityBanner.appendChild(row);
	}
}

/**
 * Follow every aux (or channel) that moved to another number on the desk
 * @param {"aux"|"channel"} type
 * @param {HTMLElement} row - banner row whose button is disabled while saving
 */
async function followMoves(type, row)
{
	for(const button of row.querySelectorAll("button"))
	{
		button.disabled = true;
	}
	try
	{
		const response = await apiFetch("/api/identity/follow", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type })
		});
		if(!response.ok)
		{
			const body = await response.json().catch(() => ({}));
			throw new Error(body.message || "Server answered " + response.status);
		}
		await pollStatus();
		if(!formDirty)
		{
			reloadLists();
		}
	}
	catch(err)
	{
		alert("Could not follow the moved " + type + "s: " + err.message);
		for(const button of row.querySelectorAll("button"))
		{
			button.disabled = false;
		}
	}
}

/**
 * Switch the send of every enabled channel to one aux on or off
 * @param {number} aux
 * @param {string} name - aux name, for the confirmation
 * @param {boolean} on
 */
async function switchAllSends(aux, name, on)
{
	const enabledChannels = document.querySelectorAll('#channels input[type="hidden"][name="channelEnabled[]"][value="true"]').length;
	const message = on
		? "Switch ON the sends of all " + enabledChannels + " enabled channels to aux " + aux + " '" + name + "'?\n\nEvery channel whose send level is up will be heard in this mix straight away."
		: "Switch OFF the sends of all " + enabledChannels + " enabled channels to aux " + aux + " '" + name + "'?\n\nThis mix will go silent.";
	if(!confirm(message))
	{
		return;
	}
	try
	{
		const response = await apiFetch("/api/aux/" + aux + "/sends", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ on: on ? 1 : 0 })
		});
		if(!response.ok)
		{
			const body = await response.json().catch(() => ({}));
			throw new Error(body.message || "Server answered " + response.status);
		}
	}
	catch(err)
	{
		alert("Could not switch the sends: " + err.message);
	}
}

/**
 * Confirm an identity change
 */
async function confirmIdentity(change, keepSettings, row)
{
	if(!keepSettings && !confirm("Reset " + change.type + " " + change.number + " to defaults? Its colour, icon, title and group will be cleared."))
	{
		return;
	}
	for(const button of row.querySelectorAll("button"))
	{
		button.disabled = true;
	}
	try
	{
		const response = await apiFetch("/api/identity/confirm", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type: change.type, number: change.number, keepSettings })
		});
		if(!response.ok)
		{
			throw new Error("Server answered " + response.status);
		}
		await pollStatus();
		if(!formDirty)
		{
			reloadLists();
		}
	}
	catch(err)
	{
		alert("Could not confirm: " + err.message);
		for(const button of row.querySelectorAll("button"))
		{
			button.disabled = false;
		}
	}
}

/**
 * Render the Status tab
 * @param {object} status - response from /api/status
 */
function renderStatus(status)
{
	const desk = status.desk || {};
	statusDesk.className = "status-card " + (desk.state || "");
	statusDesk.innerHTML = "";
	const state = document.createElement("div");
	state.className = "state";
	state.textContent = "Desk: " + (desk.state || "unknown");
	statusDesk.appendChild(state);
	const detail = document.createElement("div");
	detail.textContent = (desk.ip ? desk.ip + ":" + desk.port : "no desk IP set") + " - last reply " + ago(desk.lastRxAgoMs) + (status.loaded ? "" : " - not fully loaded yet");
	statusDesk.appendChild(detail);

	statusClients.innerHTML = "";
	const clients = status.clients || [];
	if(clients.length == 0)
	{
		statusClients.innerHTML = '<p class="notice">No clients connected</p>';
		return;
	}
	const table = document.createElement("table");
	table.className = "status-table";
	const head = table.createTHead().insertRow();
	for(const h of ["Device", "IP", "Locked aux", "Connected since", "Last seen"])
	{
		const th = document.createElement("th");
		th.textContent = h;
		head.appendChild(th);
	}
	const body = table.createTBody();
	for(const client of clients)
	{
		const tr = body.insertRow();
		const since = client.connectedAt ? new Date(client.connectedAt).toLocaleTimeString() : "";
		const cells = [
			client.deviceId ? client.deviceId.slice(0, 8) : "(admin / external)",
			client.ip || "",
			client.lockedAux ? "Aux " + client.lockedAux : "-",
			since,
			ago(client.lastSeenAgoMs)
		];
		for(const text of cells)
		{
			tr.insertCell().textContent = text;
		}
	}
	statusClients.appendChild(table);
}

/**
 * Poll /api/status and update the status tab and banners
 */
async function pollStatus()
{
	try
	{
		const response = await fetch("/api/status", { cache: "no-store", credentials: "same-origin" });
		if(!response.ok)
		{
			throw new Error("Status " + response.status);
		}
		const status = await response.json();
		statusFailures = 0;
		applyDeskState(status.desk && status.desk.state, status.desk);
		renderStatus(status);
		renderIdentityChanges(status.identityChanges || []);
	}
	catch(err)
	{
		if(++statusFailures >= 2)
		{
			applyDeskState("unreachable");
		}
	}
}

setInterval(pollStatus, 3000);
pollStatus();

"use strict";

const osc = require("osc");
const express = require("express");
const http = require('http');
const net = require('net');
const dgram = require('dgram');
const webSocket = require("ws");
const fs = require('fs');
const path = require('path');

const logger = require('./lib/logging/logger.js');

/**
 * Last-resort handlers so an unexpected error is logged instead of silently
 * killing the server (which would drop every connected device mid-show).
 * Registered before anything else so even config loading problems are logged.
 */
process.on('uncaughtException', function(err)
{
	logger.error("Uncaught exception: " + (err && err.stack ? err.stack : err));
});
process.on('unhandledRejection', function(reason)
{
	logger.error("Unhandled promise rejection: " + (reason && reason.stack ? reason.stack : reason));
});

const configManager = require("./lib/config/configManager.js")
const { getMainIPAddress } = require('./lib/utils/utils.js');
const { createAdminAuthMiddleware } = require('./lib/adminAuth.js');
const deviceLock = require('./lib/deviceLocks.js');
const groupTrim = require('./lib/groupTrim.js');
const channelLayout = require('./lib/channelLayout.js');
const identity = require('./lib/identity.js');
const deskSync = require('./lib/deskSync.js');
const oscValidation = require('./lib/oscValidation.js');
const { createEchoTracker } = require('./lib/echoTracker.js');

/**
 * Stores global configuration for webmixer
 */
configManager.ensureConfigDirectoryExists();
let config = configManager.getGlobalConfigOrDefault();
let currentState = configManager.getCurrentStateOrDefault();

/**
 * Devices locked to a single aux, keyed by device ID. Persisted in config/devices.json.
 * `auxName` is the aux's desk name when the lock was made (or last confirmed); when the desk
 * reports a different name the lock is suspended until the engineer confirms (lib/identity.js).
 * @type {Object<string, {aux: number, ip: string, lockedAt: string, auxName?: string}>}
 */
let deviceLocks = configManager.getDeviceLocks();

/**
 * Channel order and hidden channels per aux, set from the mixer's "Arrange channels" mode.
 * Persisted in config/layouts.json. An aux without an entry uses the admin layout.
 * @type {Object<string, {order: number[], hidden: number[]}>}
 */
let channelLayouts = configManager.getChannelLayouts();

// Configure logger to use settings from global config. Timestamps on: the log is often the
// only record of what happened during a show.
logger.configure(config.debug, true);

/** How often to ping websocket clients; a client that misses one ping is dropped. */
const WEBSOCKET_HEARTBEAT_MS = 30000;
/** Largest websocket message accepted from a client. */
const WEBSOCKET_MAX_PAYLOAD = 256 * 1024;
/** How often the desk/status state is re-evaluated. */
const STATUS_TICK_MS = 1000;
/** /Webmixer/Status keep-alive interval (clients treat 12 s of silence as a dead connection). */
const STATUS_KEEPALIVE_MS = 5000;
/** How often the desk is asked something cheap to check it is still there. */
const DESK_POLL_MS = 5000;
/** Every Nth poll also asks for the aux modes, to notice aux restructures. */
const DESK_POLL_MODES_EVERY = 6;
/** No message from the desk for this long => desk is offline. */
const DESK_OFFLINE_MS = 10000;
/** How often to repeat the "still waiting for the desk" warning. */
const WAITING_LOG_MS = 30000;
/** While loading, resend the pending query this often. */
const LOAD_RETRY_MS = 2000;
/** Don't resend the same load query more often than this when desk messages arrive. */
const LOAD_QUERY_MIN_GAP_MS = 500;
/** Several desk changes in a row (renames, restructure) produce one config push. */
const CONFIG_PUSH_DEBOUNCE_MS = 300;
/** Names learnt from the desk are saved to state.json at most this often. */
const STATE_SAVE_DEBOUNCE_MS = 1000;
/** Background requests for send levels/pans and missing names. */
const PRIME_TICK_MS = 100;

const STATUS_ADDRESS = "/Webmixer/Status";

/**
 * the osc.js UDP Listening Port
 */
let udpPort = undefined;

/**
 * Socket connections that have connected
 * @type {Array}
 */
let connections = [];

/**
 * Whether or not the system has finished loading
 * @type {Boolean}
 */
let loaded = false;

/**
 * Stores OSC messages that have been cached
 * @type {Map}
 */
let cache = new Map();

/**
 * Current group trim fader level (dB) for each aux and group, keyed by "{aux}/{groupId}".
 * Missing entries are at unity (0 dB).
 * @type {Map<string, number>}
 */
let groupLevels = new Map();

/**
 * Unclamped send levels remembered after a group trim pushed a send past the floor/ceiling,
 * keyed by send_level address. See lib/groupTrim.js.
 * @type {Map<string, number>}
 */
let trimOvershoot = new Map();

/**
 * Stores the name of the current snapshot
 * @type string
 */
let currentSnapshotName = "";

/**
 * Stores the number of the current snapshot
 * @type int
 */
let currentSnapshot = -1;

/** Time (ms) the desk last sent us anything; 0 = never. */
let lastDeskRx = 0;

/** The desk state last published to sockets ("loading" | "online" | "offline"). */
let publishedDeskState = null;

let lastKeepAliveAt = 0;
let lastDeskPollAt = 0;
let deskPollCount = 0;
let lastWaitingLogAt = 0;

/** Retry timer for the initial load, and the last load query sent. */
let loadTimer = null;
let lastLoadQuery = null;
let lastLoadQueryAt = 0;

/** Cached addresses whose values must be re-read from the desk (after it was offline). */
const staleAddresses = new Set();

/** Paces the background queries for send levels/pans and names. */
const queryPacer = deskSync.createQueryPacer();
let primeTimer = null;

/** Values recently sent to the desk, to recognise the desk echoing them back. */
const deskEchoes = createEchoTracker();

let configPushTimer = null;
let stateSaveTimer = null;

/**
 * The main http server
 * @type {http.Server}
 */
let server = null;

/**
 * The socket server attached to `server`
 * @type {WebSocketServer}
 */
let wss = null;

const mixServerIP = getMainIPAddress();


/**
 * Directory plugins are loaded from: OSCWEBMIXER_PLUGINS_DIR, else "plugins" next to the
 * executable (packaged builds) or next to index.js. Not the working directory, so a double-clicked
 * binary (macOS starts those in the home folder) still finds its plugins.
 * @returns {string}
 */
function getPluginDirectory() {
	if (process.env.OSCWEBMIXER_PLUGINS_DIR) {
		return path.resolve(process.env.OSCWEBMIXER_PLUGINS_DIR);
	}
	return path.join(process.pkg ? path.dirname(process.execPath) : __dirname, "plugins");
}

/**
 * Load all plugins from the plugin directory. A plugin that fails to load is skipped.
 * @returns - Array of plugins (empty if none found/enabled)
 */
function loadPlugins() {
	const pluginDir = getPluginDirectory();
	let pluginFiles;
	try {
		if (!fs.existsSync(pluginDir)) {
			logger.warn(`Plugin directory ${pluginDir} not found. Creating empty directory.`);
			fs.mkdirSync(pluginDir, {recursive: true});
			logger.info(`To use plugins, please add them to ${pluginDir}.`);
			return [];
		}
		pluginFiles = fs.readdirSync(pluginDir);
	}
	catch(e) {
		logger.error(`Could not read or create ${pluginDir}: ${e.message}`);
		return [];
	}

	let plugins = [];

	for (const file of pluginFiles) {
		if (file.startsWith('_')) {
			logger.info(`Not loading plugin "${file}".`);
			continue;
		}
		if (!file.endsWith('.js')) {
			logger.warn(`Ignoring non-JS file "${file}" in plugin directory.`);
			continue;
		}
		try {
			let plugin = require(path.join(pluginDir, file));
			const instance = new plugin();
			if (typeof instance.handleOSC !== "function") {
				logger.error(`Plugin "${file}" has no handleOSC() method. Not loaded.`);
				continue;
			}
			instance.__file = file;
			plugins.push(instance);
			logger.info(`Loaded plugin "${file}".`);
		}
		catch(e) {
			logger.error(`Failed to load plugin "${file}": ${e && e.stack ? e.stack : e}`);
		}
	}

	return plugins;
}

const plugins = loadPlugins();

/* ------------------------------------------------------------------------------------------
 * State helpers
 * ---------------------------------------------------------------------------------------- */

/**
 * Settings for an aux with defaults filled in.
 * @param {number} index - 0-based
 */
function auxSettings(index)
{
	const slot = currentState.auxes?.[index];
	return {
		enabled: slot?.enabled ?? true,
		icon: slot?.icon ?? "",
		name: slot?.name
	};
}

/**
 * Settings for a channel with defaults filled in.
 * @param {number} index - 0-based
 */
function channelSettings(index)
{
	const slot = currentState.channels?.[index];
	return {
		enabled: slot?.enabled ?? true,
		displayOrder: slot?.displayOrder ?? index,
		title: slot?.title ?? "",
		icon: slot?.icon ?? "",
		group: slot?.group ?? "",
		name: slot?.name
	};
}

/**
 * The aux name the desk reports, if the aux exists on the desk.
 * @param {number} aux - 1-based
 * @returns {string|undefined}
 */
function deskAuxName(aux)
{
	if(!Number.isInteger(aux) || aux < 1 || aux > deskSync.auxCount(cache))
	{
		return undefined;
	}
	const name = cache.get(deskSync.auxNameAddress(aux))?.args?.[0];
	return typeof name === "string" ? name : undefined;
}

/**
 * The channel name the desk reports, if the channel exists on the desk.
 * @param {number} channel - 1-based
 * @returns {string|undefined}
 */
function deskChannelName(channel)
{
	if(!Number.isInteger(channel) || channel < 1 || channel > deskSync.channelCount(cache))
	{
		return undefined;
	}
	const name = cache.get(deskSync.channelNameAddress(channel))?.args?.[0];
	return typeof name === "string" ? name : undefined;
}

/**
 * Get the aux name from the cache
 * @param {number} aux
 * @returns {string}
 */
function auxName(aux)
{
	return deskAuxName(aux) ?? `Aux ${aux}`;
}

/**
 * @param {{aux: number, auxName?: string}} lock
 * @returns {{suspended: boolean, auxName: string}}
 */
function lockInfo(lock)
{
	return identity.lockState(lock, deskAuxName(lock.aux));
}

/**
 * @returns {{type: "aux"|"channel", number: number, previousName: string, currentName: string}[]}
 */
function currentIdentityChanges()
{
	if(!loaded)
	{
		return [];
	}
	return identity.identityChanges({
		auxCount: deskSync.auxCount(cache),
		channelCount: deskSync.channelCount(cache),
		auxName: deskAuxName,
		channelName: deskChannelName,
		state: currentState,
		locks: deviceLocks
	});
}

/**
 * Is the cached message identical to this one?
 * @param {{address: string, args: any[]}} oscMsg
 */
function sameAsCached(oscMsg)
{
	const cached = cache.get(oscMsg.address);
	return cached !== undefined && JSON.stringify(cached.args) === JSON.stringify(oscMsg.args);
}

/**
 * Uncached /Console/... messages last received from the desk. The desk answers the periodic
 * liveness poll (/Console/Channels/?) with several of these; unchanged ones are not
 * re-broadcast every 5 s.
 * @type {Map<string, string>}
 */
const consoleInfoSeen = new Map();

/**
 * Remember an uncached /Console/ message and tell whether it is unchanged.
 * @param {{address: string, args: any[]}} oscMsg
 * @returns {boolean} true if the same value was received before
 */
function sameAsLastConsoleInfo(oscMsg)
{
	if(!oscMsg.address.startsWith("/Console/") || cache.has(oscMsg.address) || consoleInfoSeen.size > 500)
	{
		return false;
	}
	const value = JSON.stringify(oscMsg.args);
	const same = consoleInfoSeen.get(oscMsg.address) === value;
	consoleInfoSeen.set(oscMsg.address, value);
	return same;
}

/**
 * The desk state reported to clients.
 * @returns {"loading"|"online"|"offline"}
 */
function computeDeskState()
{
	if(!loaded)
	{
		return "loading";
	}
	return Date.now() - lastDeskRx > DESK_OFFLINE_MS ? "offline" : "online";
}

/* ------------------------------------------------------------------------------------------
 * Sending
 * ---------------------------------------------------------------------------------------- */

/**
 * Send a message to one socket if it is open.
 * @param {WebSocket} socket
 * @param {object|string} msg
 */
function sendToSocket(socket, msg)
{
	if(!socket || socket.readyState !== webSocket.OPEN)
	{
		return;
	}
	try
	{
		socket.send(typeof msg === "string" ? msg : JSON.stringify(msg));
	}
	catch(e)
	{
		logger.warn(`Could not send to websocket client (${socket.remoteIp || "unknown ip"}): ${e.message}`);
	}
}

/**
 * Send a message to every webmixer socket except one. Unlike broadcast() this doesn't go to
 * the desk or external devices, so it's used for webmixer-only messages.
 * @param {object} msg
 * @param {WebSocket} [except]
 */
function sendToSockets(msg, except)
{
	const json = JSON.stringify(msg);
	for(const connection of connections)
	{
		if(connection !== except)
		{
			sendToSocket(connection, json);
		}
	}
}

/**
 * Send a message to the mixing desk.
 * @param {{address: string, args: any[]}} msg
 * @returns {boolean} false if it couldn't be sent
 */
function sendToDesk(msg)
{
	if(!udpPort || !config.desk.ip)
	{
		return false;
	}
	try
	{
		udpPort.send(msg, config.desk.ip, config.desk.port);
	}
	catch(e)
	{
		logger.error(`Could not send ${msg.address} to the mixing desk (${config.desk.ip}:${config.desk.port}): ${e.message}`);
		return false;
	}
	if(!oscValidation.isQuery(msg.address))
	{
		deskEchoes.record(msg.address, msg.args);
	}
	return true;
}

/**
 * Send to an external device.
 */
function sendToExternal(msg, ip, port, name)
{
	try
	{
		udpPort.send(msg, ip, port);
		logger.debug(`Sent ${JSON.stringify(msg)} to External "${name}" (${ip}:${port})`);
	}
	catch(e)
	{
		logger.warn(`Could not send to external "${name}" (${ip}:${port}): ${e.message}`);
	}
}

/**
 * Broadcast an OSC message to all connections. Queries ("/?") go to the desk and external
 * devices only, never to webmixer sockets.
 * @param {Object} oscMsg - the OSC message to send
 * @param {string|WebSocketConnection} source - don't broadcast to this connection
 * @returns {void}
 */
function broadcast(oscMsg, source)
{
	//notify desk
	if(config.desk.ip != source)
	{
		if(sendToDesk(oscMsg))
		{
			logger.debug(`Sent ${JSON.stringify(oscMsg)} to Mixing Desk (${config.desk.ip}:${config.desk.port})`);
		}
	}

	//notify all external devices
	if(config.externalDevices && udpPort)
	{
		for(let external of config.externalDevices)
		{
			if(external.broadcast && (external.loopback || external.ip != source))
			{
				sendToExternal(oscMsg, external.ip, external.port, external.name);
			}
		}
	}

	if(oscValidation.isQuery(oscMsg.address))
	{
		return;
	}

	//notify all webmixer connections
	connections = connections.filter(connection => connection.readyState <= webSocket.OPEN);
	const json = JSON.stringify(oscMsg);
	let sent = 0;
	for(const connection of connections)
	{
		if(connection != source)
		{
			sendToSocket(connection, json);
			sent++;
		}
	}
	if(sent > 0)
	{
		logger.debug(`Sent ${json} to ${sent} socket(s)`);
	}
}

/**
 * Send a OSC message to a device via UDP
 * @param {string} name - the name of the device to send to
 * @param {object} msg - the OSC message to send
 */
function sendUDP(name, msg)
{
	if(config.externalDevices)
	{
		for(let external of config.externalDevices)
		{
			if(external.name == name)
			{
				sendToExternal(msg, external.ip, external.port, external.name);
			}
		}
	}
}

/* ------------------------------------------------------------------------------------------
 * Config / status pushed to sockets
 * ---------------------------------------------------------------------------------------- */

/**
 * Build the configuration message for a socket
 * @param {string|null} deviceId - the connecting device, used to report its lock state
 * @returns - the configuration message (JSON string)
 */
function buildConfig(deviceId = null)
{
	const lock = deviceId ? deviceLocks[deviceId] : undefined;

	let auxilaries = [];
	if(cache.has(deskSync.AUX_MODES))
	{
		let auxModes = cache.get(deskSync.AUX_MODES).args;
		for(const [index, mode] of auxModes.entries())
		{
			const name = deskAuxName(index + 1);
			//skip auxes whose name hasn't arrived from the desk yet (matches the /aux route)
			if(name === undefined)
			{
				continue;
			}
			const settings = auxSettings(index);
			auxilaries.push({
				enabled: settings.enabled,
				label: name,
				channel: index + 1,
				stereo: mode == 2,
				colour: identity.effectiveAuxColour(currentState.auxes?.[index], name, index, auxModes.length),
				icon: settings.icon,
				changed: identity.isChanged(settings.name, name)
			});
		}
	}

	let channels = [];
	const channelTotal = deskSync.channelCount(cache);
	for(let i=0; i<channelTotal; i++)
	{
		const name = deskChannelName(i + 1);
		if(name === undefined)
		{
			continue;
		}
		const settings = channelSettings(i);
		channels.push({
			enabled: settings.enabled,
			label: name,
			channel: i + 1,
			order: settings.displayOrder,
			title: settings.title,
			icon: settings.icon,
			group: settings.group,
			changed: identity.isChanged(settings.name, name)
		});
	}

	return JSON.stringify({
		"config": {
			channels: channels,
			aux: auxilaries,
			snapshot: currentSnapshotName,
			groups: (currentState.groups || [])
				.filter(group => channels.some(channel => channel.enabled && channel.group === group.id))
				.map(group => ({ id: group.id, name: group.name, icon: group.icon || "" })),
			lock: lock ? { aux: lock.aux, ...lockInfo(lock) } : null,
			unlockNeedsPassword: Boolean(process.env.ADMIN_PASSWORD),
			layouts: channelLayouts
		}
	});
}

/**
 * Send the current config to one socket (only once the desk data has loaded).
 * @param {WebSocket} socket
 */
function pushConfig(socket)
{
	if(loaded)
	{
		sendToSocket(socket, buildConfig(socket.deviceId));
	}
}

/**
 * Send a fresh config to every socket, e.g. after an admin save, preset load or desk change.
 */
function pushConfigToAll()
{
	clearTimeout(configPushTimer);
	configPushTimer = null;
	for(const connection of connections)
	{
		pushConfig(connection);
	}
}

/**
 * Push config to every socket soon. Several desk changes in a row produce one push.
 */
function scheduleConfigPush()
{
	if(configPushTimer)
	{
		return;
	}
	configPushTimer = setTimeout(pushConfigToAll, CONFIG_PUSH_DEBOUNCE_MS);
}

/**
 * Push config to every socket of one device so its UI switches between locked and unlocked.
 * @param {string} deviceId
 */
function pushConfigToDevice(deviceId)
{
	for(const connection of connections)
	{
		if(connection.deviceId === deviceId)
		{
			pushConfig(connection);
		}
	}
}

/**
 * @returns {string} the /Webmixer/Status message
 */
function statusMessage()
{
	return JSON.stringify({address: STATUS_ADDRESS, args: [JSON.stringify({desk: computeDeskState()})]});
}

/**
 * Send the desk status to every socket.
 */
function sendStatusToAll()
{
	const msg = statusMessage();
	for(const connection of connections)
	{
		sendToSocket(connection, msg);
	}
	lastKeepAliveAt = Date.now();
}

/**
 * Publish the desk status if it changed.
 */
function publishStatus()
{
	const state = computeDeskState();
	if(state === publishedDeskState)
	{
		return;
	}
	const previous = publishedDeskState;
	publishedDeskState = state;
	if(state === "offline")
	{
		logger.warn(`Mixing desk (${config.desk.ip}:${config.desk.port}) is not responding. Musicians see "Mixing desk not responding".`);
		lastWaitingLogAt = Date.now();
	}
	else if(state === "online" && previous === "offline")
	{
		logger.info("Mixing desk is responding again.");
	}
	sendStatusToAll();
}

/**
 * Persist state.json soon. Used for names learnt from the desk, which are derived data
 * (if the save fails they are simply learnt again next time).
 */
function scheduleStateSave()
{
	if(stateSaveTimer)
	{
		return;
	}
	stateSaveTimer = setTimeout(function()
	{
		stateSaveTimer = null;
		try
		{
			configManager.saveCurrentState(currentState);
		}
		catch(e)
		{
			logger.error("Failed to save state.json: " + e.message);
		}
	}, STATE_SAVE_DEBOUNCE_MS);
}

/**
 * Persist new device locks, then (only if that worked) use them and update the devices' UI.
 * @param {Object<string, object>} nextLocks
 * @param {string[]} deviceIds - devices whose UI must be refreshed
 * @returns {boolean} false if the locks couldn't be saved (nothing changed)
 */
function commitDeviceLocks(nextLocks, deviceIds)
{
	try
	{
		configManager.saveDeviceLocks(nextLocks);
	}
	catch(e)
	{
		logger.error("Failed to save device locks: " + e.message);
		return false;
	}
	deviceLocks = nextLocks;
	for(const id of deviceIds)
	{
		pushConfigToDevice(id);
	}
	return true;
}

/* ------------------------------------------------------------------------------------------
 * Identity tracking
 * ---------------------------------------------------------------------------------------- */

/**
 * Make sure a state list has an entry at index (holes would be saved as null).
 * @param {"auxes"|"channels"} key
 * @param {number} index
 * @param {object} state
 * @returns {object} the entry
 */
function ensureSlot(state, key, index)
{
	if(!Array.isArray(state[key]))
	{
		state[key] = [];
	}
	for(let i = 0; i <= index; i++)
	{
		if(!state[key][i] || typeof state[key][i] !== "object")
		{
			state[key][i] = {enabled: true};
		}
	}
	return state[key][index];
}

/**
 * Remember the desk name of every slot that has none stored yet ("first time seen"), and
 * give legacy device locks the name of their aux.
 */
function reconcileNames()
{
	if(!loaded)
	{
		return;
	}
	let stateChanged = false;
	for(let aux = 1; aux <= deskSync.auxCount(cache); aux++)
	{
		const name = deskAuxName(aux);
		if(identity.nameStatus(currentState.auxes?.[aux - 1]?.name, name) === "first")
		{
			ensureSlot(currentState, "auxes", aux - 1).name = name;
			stateChanged = true;
		}
	}
	for(let channel = 1; channel <= deskSync.channelCount(cache); channel++)
	{
		const name = deskChannelName(channel);
		if(identity.nameStatus(currentState.channels?.[channel - 1]?.name, name) === "first")
		{
			ensureSlot(currentState, "channels", channel - 1).name = name;
			stateChanged = true;
		}
	}
	if(stateChanged)
	{
		scheduleStateSave();
	}

	let nextLocks = null;
	for(const [id, lock] of Object.entries(deviceLocks))
	{
		const name = deskAuxName(lock.aux);
		if(identity.nameStatus(lock.auxName, name) === "first")
		{
			nextLocks = nextLocks || {...deviceLocks};
			nextLocks[id] = {...lock, auxName: name};
		}
	}
	if(nextLocks)
	{
		commitDeviceLocks(nextLocks, []);
	}

	for(const change of currentIdentityChanges())
	{
		logger.warn(`${change.type === "aux" ? "Aux" : "Channel"} ${change.number} is now "${change.currentName}" on the desk ` +
			`(was "${change.previousName}"). Confirm it in the admin page.`);
	}
}

/**
 * A name arrived from the desk after loading.
 * @param {"aux"|"channel"} type
 * @param {number} number - 1-based
 * @param {string} name
 */
function onDeskName(type, number, name)
{
	const key = type === "aux" ? "auxes" : "channels";
	const stored = currentState[key]?.[number - 1]?.name;
	const status = identity.nameStatus(stored, name);
	if(status === "first")
	{
		ensureSlot(currentState, key, number - 1).name = name;
		scheduleStateSave();
	}
	else if(status === "changed")
	{
		let detail = "";
		if(type === "aux")
		{
			const locked = Object.values(deviceLocks).filter(lock => lock.aux === number).length;
			detail = locked > 0 ? ` ${locked} device(s) locked to it are suspended until you confirm.` : "";
		}
		logger.warn(`${type === "aux" ? "Aux" : "Channel"} ${number} renamed on the desk from "${stored}" to "${name}". ` +
			`Confirm it in the admin page.${detail}`);
	}
	if(type === "aux")
	{
		//locks whose own aux name differs are suspended too (e.g. after a preset load)
		for(const lock of Object.values(deviceLocks))
		{
			if(lock.aux === number && status !== "changed" && identity.isChanged(lock.auxName, name))
			{
				logger.warn(`Aux ${number} is now "${name}" (device locked when it was "${lock.auxName}"). Lock suspended until confirmed.`);
			}
		}
	}
	scheduleConfigPush();
}

/**
 * A message from the desk changed a cached value after loading: react to renames and
 * structure changes (channel count, aux count/modes).
 * @param {{address: string, args: any[]}} oscMsg
 * @param {{address: string, args: any[]}|undefined} previous - the cached message before
 */
function onDeskValueChanged(oscMsg, previous)
{
	const address = oscMsg.address;
	if(address === deskSync.CHANNEL_COUNT || address === deskSync.AUX_MODES)
	{
		if(address === deskSync.CHANNEL_COUNT)
		{
			logger.info(`Desk now has ${deskSync.channelCount(cache)} input channels (was ${previous ? previous.args[0] : "unknown"}).`);
		}
		else
		{
			logger.info(`Desk aux outputs changed: ${deskSync.auxCount(cache)} auxes (was ${previous ? previous.args.length : "unknown"}).`);
		}
		queryPacer.reset();
		ensurePrimer(); //fetch names and sends for new channels/auxes
		reconcileNames();
		scheduleConfigPush();
		return;
	}

	let match = address.match(/^\/Aux_Outputs\/(\d{1,3})\/Buss_Trim\/name$/);
	if(match && typeof oscMsg.args[0] === "string")
	{
		onDeskName("aux", parseInt(match[1], 10), oscMsg.args[0]);
		return;
	}
	match = address.match(/^\/Input_Channels\/(\d{1,3})\/Channel_Input\/name$/);
	if(match && typeof oscMsg.args[0] === "string")
	{
		onDeskName("channel", parseInt(match[1], 10), oscMsg.args[0]);
	}
}

/* ------------------------------------------------------------------------------------------
 * Webmixer-only messages: layouts, locks, group trims
 * ---------------------------------------------------------------------------------------- */

/**
 * Handle /Webmixer/Aux/{aux}/Layout [json]: save the channel layout for an aux and pass it
 * to every other webmixer device, so everyone on that aux sees the same layout.
 * @param {WebSocket} socket - the sending socket
 * @param {{address: string, args: any[]}} oscMsg
 * @returns {boolean} true if the message was a layout message and has been handled
 */
function handleLayoutMessage(socket, oscMsg)
{
	const aux = channelLayout.parseLayoutAddress(oscMsg.address);
	if(aux === null)
	{
		return false;
	}

	const layout = channelLayout.sanitizeLayout(Array.isArray(oscMsg.args) ? oscMsg.args[0] : undefined);
	const nextLayouts = {...channelLayouts};
	if(layout)
	{
		nextLayouts[aux] = layout;
	}
	else
	{
		delete nextLayouts[aux];
	}
	try
	{
		configManager.saveChannelLayouts(nextLayouts);
	}
	catch(e)
	{
		logger.error("Failed to save channel layouts: " + e.message);
		sendToSocket(socket, {address: "/Webmixer/Error", args: ["Could not save the channel layout on the server."]});
		const current = channelLayouts[aux];
		sendToSocket(socket, {address: channelLayout.layoutAddress(aux), args: current ? [JSON.stringify(current)] : []});
		return true;
	}
	channelLayouts = nextLayouts;

	sendToSockets({address: channelLayout.layoutAddress(aux), args: layout ? [JSON.stringify(layout)] : []}, socket);
	return true;
}

/**
 * Handle lock/unlock requests sent by a webmixer device.
 * @param {WebSocket} socket - the requesting socket
 * @param {{address: string, args: any[]}} oscMsg
 * @returns {boolean} true if the message was a lock message and has been handled
 */
function handleLockMessage(socket, oscMsg)
{
	if(oscMsg.address !== "/Webmixer/Lock" && oscMsg.address !== "/Webmixer/Unlock")
	{
		return false;
	}

	const deviceId = socket.deviceId;
	const reply = (message) => sendToSocket(socket, {address: "/Webmixer/Error", args: [message]});

	if(!deviceId)
	{
		reply("This device has no ID. Reload the page and try again.");
		return true;
	}

	if(oscMsg.address === "/Webmixer/Lock")
	{
		const aux = Number(Array.isArray(oscMsg.args) ? oscMsg.args[0] : undefined);
		if(deviceLocks[deviceId])
		{
			reply("This device is already locked.");
			return true;
		}
		if(!deviceLock.isValidAux(aux) || deskAuxName(aux) === undefined)
		{
			reply("Unknown aux.");
			return true;
		}
		const nextLocks = {...deviceLocks, [deviceId]: {aux: aux, ip: socket.remoteIp, lockedAt: new Date().toISOString(), auxName: deskAuxName(aux)}};
		if(!commitDeviceLocks(nextLocks, [deviceId]))
		{
			reply("Could not save the lock on the server.");
			return true;
		}
		logger.info(`Device ${deviceId} (${socket.remoteIp}) locked to aux ${aux} "${auxName(aux)}".`);
		return true;
	}

	//unlock
	if(!deviceLocks[deviceId])
	{
		pushConfigToDevice(deviceId); //already unlocked - just resync the client
		return true;
	}
	const password = Array.isArray(oscMsg.args) ? oscMsg.args[0] : undefined;
	if(!deviceLock.canSelfUnlock(process.env.ADMIN_PASSWORD, password))
	{
		logger.warn(`Rejected unlock attempt with wrong password from device ${deviceId} (${socket.remoteIp}).`);
		reply("Wrong password.");
		return true;
	}
	const nextLocks = {...deviceLocks};
	delete nextLocks[deviceId];
	if(!commitDeviceLocks(nextLocks, [deviceId]))
	{
		reply("Could not save the unlock on the server.");
		return true;
	}
	logger.info(`Device ${deviceId} (${socket.remoteIp}) unlocked.`);
	return true;
}

/**
 * The send level we know the desk has, or undefined while it is unknown or being refreshed.
 * @param {number} channel
 * @param {number} aux
 * @returns {number|undefined}
 */
function knownSendLevel(channel, aux)
{
	const address = deskSync.sendAddress(channel, aux, "level");
	if(staleAddresses.has(address))
	{
		return undefined;
	}
	const value = cache.get(address)?.args?.[0];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Handle group trim messages: /Webmixer/Aux/{aux}/Group/{groupId}/level [dB] and its /? query.
 * Moving a group fader moves every member channel's send on that aux by the same amount.
 * Any other /Webmixer/ address is dropped so it never reaches the desk.
 * @param {WebSocket} socket - the sending socket
 * @param {{address: string, args: any[]}} oscMsg
 * @returns {boolean} true if the message was handled and needs no further processing
 */
function handleGroupMessage(socket, oscMsg)
{
	if(!oscMsg.address.startsWith("/Webmixer/"))
	{
		return false;
	}

	const parsed = groupTrim.parseGroupAddress(oscMsg.address);
	if(!parsed || !(currentState.groups || []).some(group => group.id === parsed.groupId))
	{
		logger.debug(`Ignoring unknown webmixer message ${oscMsg.address}`);
		return true;
	}

	const key = `${parsed.aux}/${parsed.groupId}`;
	const address = groupTrim.groupAddress(parsed.aux, parsed.groupId);
	const current = groupLevels.has(key) ? groupLevels.get(key) : groupTrim.UNITY_DB;
	const replyCurrent = () => sendToSocket(socket, {address: address, args: [current]});

	if(parsed.query)
	{
		replyCurrent();
		return true;
	}

	//a relative move on stale or unknown values could make a send louder than intended
	if(computeDeskState() !== "online" || deskAuxName(parsed.aux) === undefined)
	{
		logger.debug(`Group move ${oscMsg.address} ignored: desk not online or aux unknown.`);
		replyCurrent();
		return true;
	}

	const channelTotal = deskSync.channelCount(cache);
	const members = groupTrim.groupMembers(currentState.channels, parsed.groupId,
		channel => channel <= channelTotal && channelSettings(channel - 1).enabled);
	const memberLevels = new Map(members.map(channel => [channel, knownSendLevel(channel, parsed.aux)]));
	const plan = groupTrim.planGroupMove(current, Array.isArray(oscMsg.args) ? oscMsg.args[0] : undefined, memberLevels);

	if(plan.action === "ignore")
	{
		replyCurrent();
		return true;
	}
	if(plan.action === "reject")
	{
		logger.info(`Group "${parsed.groupId}" move on aux ${parsed.aux} ignored: waiting for ${plan.missing.length} send level(s) from the desk.`);
		for(const channel of plan.missing)
		{
			sendToDesk({address: deskSync.sendAddress(channel, parsed.aux, "level") + "/?", args: []});
		}
		replyCurrent();
		return true;
	}

	const level = plan.levelDb;
	groupLevels.set(key, level);

	//keep other devices on the same aux in sync; tell the sender if its move was limited
	sendToSockets({address: address, args: [level]}, socket);
	if(plan.limited)
	{
		sendToSocket(socket, {address: address, args: [level]});
	}

	if(plan.deltaDb === 0)
	{
		return true;
	}

	for(const channel of members)
	{
		const sendAddress = deskSync.sendAddress(channel, parsed.aux, "level");
		const result = groupTrim.applyTrim(memberLevels.get(channel), trimOvershoot.get(sendAddress), plan.deltaDb);
		if(result.virtualDb === null)
		{
			trimOvershoot.delete(sendAddress);
		}
		else
		{
			trimOvershoot.set(sendAddress, result.virtualDb);
		}

		let sendMsg = processPlugins({address: sendAddress, args: [result.sendDb]});
		if(sendMsg === false)
		{
			continue;
		}
		maybeCacheResponse(sendMsg);
		broadcast(sendMsg); //desk, external devices and every socket including the sender
	}
	return true;
}

/**
 * A send level was moved by something other than a group trim, so forget any remembered
 * overshoot for it.
 * @param {string} address
 */
function forgetTrimOvershoot(address)
{
	if(trimOvershoot.size > 0 && address.endsWith("/send_level"))
	{
		trimOvershoot.delete(address);
	}
}

/* ------------------------------------------------------------------------------------------
 * HTTP server
 * ---------------------------------------------------------------------------------------- */

/**
 * @param {unknown} value
 * @returns {number|null} a valid port number, or null
 */
function parsePort(value)
{
	const port = Number(value);
	return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/**
 * @param {unknown} value
 * @returns {boolean} true for something that looks like an IP address or host name
 */
function isValidHost(value)
{
	return typeof value === "string" && /^[A-Za-z0-9.:_-]{1,253}$/.test(value);
}

/**
 * Explain a failed bind.
 * @param {NodeJS.ErrnoException} err
 * @param {number} port
 * @param {string} what
 */
function portErrorMessage(err, port, what)
{
	if(err.code === "EADDRINUSE")
	{
		return `${what} ${port} is already in use by another program.`;
	}
	if(err.code === "EACCES")
	{
		return `${what} ${port} is not permitted (ports below 1024 need elevated privileges).`;
	}
	return `${what} ${port} can't be used: ${err.message}`;
}

/**
 * Check that a TCP port can be listened on.
 * @param {number} port
 * @returns {Promise<Error|null>}
 */
function checkTcpPortFree(port)
{
	return new Promise(resolve => {
		const probe = net.createServer();
		probe.once("error", err => resolve(err));
		probe.once("listening", () => probe.close(() => resolve(null)));
		probe.listen(port);
	});
}

/**
 * Check that a UDP port can be bound.
 * @param {number} port
 * @returns {Promise<Error|null>}
 */
function checkUdpPortFree(port)
{
	return new Promise(resolve => {
		const probe = dgram.createSocket("udp4");
		probe.once("error", err => {
			try { probe.close(); } catch(e) { /* already closed */ }
			resolve(err);
		});
		probe.bind({port: port, address: "0.0.0.0"}, () => probe.close(() => resolve(null)));
	});
}

/**
 * Start the main web server (and the websocket server attached to it)
 */
function startServer()
{
	// Create an Express-based Web Socket server that clients can connect to
	let app = express();

	// Apply no-cache policy for admin endpoints to prevent stale browser state
	app.use(["/admin", "/admin.html", "/admin.js", "/admin.css", "/api", "/healthz"], (req, res, next) => {
		res.set("Cache-Control", "no-store");
		next();
	});

	// Tell express to use all the static files in /web
	app.use("/", express.static(__dirname + "/web"));

	// Tell express that we are expecting post data
	app.use(express.urlencoded({
		extended: true,
		//the admin form posts several fields per channel, which passes the default 1000 on big desks
		parameterLimit: 10000
	}));

	app.use(express.json());

	// Protects the admin area. Unauthenticated by default (matches the trusted-LAN
	// deployment model); set ADMIN_USER/ADMIN_PASSWORD to require Basic Auth instead.
	const requireAdminAuth = createAdminAuthMiddleware();

	//health check for Docker / monitoring. No auth, no details.
	app.get('/healthz', (req, res) => {
		res.json({ok: true, loaded: loaded, desk: computeDeskState()});
	});

	//when a post request occurs in the admin area
	app.post('/admin', requireAdminAuth, async (req, res) => {
		try
		{
			await saveAdminForm(req, res);
		}
		catch(e)
		{
			logger.error("Error saving admin settings: " + (e && e.stack ? e.stack : e));
			if(!res.headersSent)
			{
				res.status(500).json({success: false, message: "An internal server error occurred."});
			}
		}
	});

	//when a get request occurs in the admin area
	app.get('/admin', requireAdminAuth, (req, res) => {
		res.sendFile(__dirname + "/web/admin.html");
	});

	//provide the current config to the admin area when it has been requested by ajax.
	app.get('/config', (req, res) => {
		res.json({...config, server: {...config.server, ip: mixServerIP}});
	});

	app.get('/api/status', requireAdminAuth, (req, res) => {
		const now = Date.now();
		res.json({
			loaded: loaded,
			desk: {
				state: computeDeskState(),
				ip: config.desk.ip,
				port: config.desk.port,
				lastRxAgoMs: lastDeskRx ? now - lastDeskRx : null
			},
			clients: connections
				.filter(connection => connection.readyState === webSocket.OPEN)
				.map(connection => ({
					deviceId: connection.deviceId || null,
					ip: connection.remoteIp,
					lockedAux: connection.deviceId && deviceLocks[connection.deviceId] ? deviceLocks[connection.deviceId].aux : null,
					connectedAt: connection.connectedAt.toISOString(),
					lastSeenAgoMs: now - connection.lastSeen
				})),
			identityChanges: currentIdentityChanges()
		});
	});

	//accept the desk's new name for an aux or channel slot
	app.post('/api/identity/confirm', requireAdminAuth, (req, res) => {
		confirmIdentity(req, res);
	});

	app.get('/api/presets', requireAdminAuth, (req, res) => {
		let presets = configManager.getPresets()

		res.json(presets.map(p => ({
			uuid: p.uuid,
			name: p.name,
			lastChanged: p.lastChanged
		})));
	});

	app.post('/api/presets/:uuid/load', requireAdminAuth, (req, res) => {
		try {
			const { uuid } = req.params;

			if (!uuid) {
				return res.status(400).json({
					success: false,
					message: "Preset UUID is required."
				});
			}

			const preset = configManager.getPresetById(uuid);

			if (!preset) {
				return res.status(404).json({
					success: false,
					message: `Preset with ID "${uuid}" not found.`
				});
			}

			const nextState = structuredClone(preset);
			configManager.saveCurrentState(nextState); //throws on failure, before anything changes
			currentState = nextState;
			logger.info(`Preset "${preset.name}" loaded.`);

			reconcileNames();
			queryPacer.reset();
			ensurePrimer();
			pushConfigToAll();

			res.json({
				success: true,
				message: `Preset "${preset.name}" loaded successfully.`,
				state: currentState
			});
		} catch (err) {
			logger.error(`Error loading preset: ${err}`);
			res.status(500).json({
				success: false,
				message: "An internal server error occurred."
			});
		}
	});

	app.post('/api/presets/save-current-state', requireAdminAuth, (req, res) => {
		try {
			const { name } = req.body;

			if (!name || typeof name !== "string" || name.trim() === "") {
				return res.status(400).json({ success: false, message: "Preset name is required." });
			}

			const newPreset = configManager.saveCurrentStateAsPreset(currentState, name);

			res.status(201).json({
				success: true,
				message: "Preset saved successfully.",
				preset: newPreset
			});
		} catch (err) {
			if (err.code === 'PRESET_EXISTS') {
				return res.status(409).json({
					success: false,
					message: err.message
				});
			}

			logger.error(`Error saving preset: ${err}`);
			res.status(500).json({
				success: false,
				message: "An internal server error occurred."
			});
		}
	});

	app.delete('/api/presets/:uuid', requireAdminAuth, (req, res) => {
		try {
			const { uuid } = req.params;
			configManager.deletePreset(uuid);

			res.json({
				success: true,
				message: "Preset deleted successfully."
			});

		} catch (err) {
			if (err.code === 'PRESET_NOT_FOUND') {
				return res.status(404).json({
					success: false,
					message: err.message
				});
			}

			logger.error(`Error deleting preset: ${err}`);
			res.status(500).json({
				success: false,
				message: "Failed to delete preset."
			});
		}
	});

	app.get('/api/presets/:uuid/download', requireAdminAuth, (req, res) => {
		try {
			const { uuid } = req.params;
			const preset = configManager.getPresetById(uuid);

			if (!preset) {
				return res.status(404).json({ success: false, message: "Preset not found." });
			}

			const filename = `${String(preset.name).replace(/[^A-Za-z0-9._-]+/g, '_')}.json`;
			res.setHeader('Content-Type', 'application/json');
			res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

			res.send(JSON.stringify(preset, null, 4));
		} catch (err) {
			res.status(500).send("Error generating download.");
		}
	});

	//list locked and connected webmixer devices
	app.get('/api/devices', requireAdminAuth, (req, res) => {
		const now = Date.now();
		let devices = new Map();

		for(const [id, lock] of Object.entries(deviceLocks))
		{
			devices.set(id, {
				id: id,
				aux: lock.aux,
				auxName: auxName(lock.aux),
				suspended: loaded ? lockInfo(lock).suspended : false,
				ip: lock.ip,
				lockedAt: lock.lockedAt,
				connected: false,
				lastSeenAgoMs: null
			});
		}

		for(const connection of connections)
		{
			if(!connection.deviceId || connection.readyState !== webSocket.OPEN)
			{
				continue;
			}
			const device = devices.get(connection.deviceId) || {id: connection.deviceId, aux: null, auxName: "", suspended: false, ip: connection.remoteIp, lockedAt: null, lastSeenAgoMs: null};
			device.connected = true;
			device.ip = connection.remoteIp;
			const seen = now - connection.lastSeen;
			device.lastSeenAgoMs = device.lastSeenAgoMs === null ? seen : Math.min(device.lastSeenAgoMs, seen);
			devices.set(connection.deviceId, device);
		}

		res.json({
			devices: [...devices.values()],
			unlockNeedsPassword: Boolean(process.env.ADMIN_PASSWORD)
		});
	});

	//lock a device to an aux, or move a locked device to a different aux
	app.post('/api/devices/:id/lock', requireAdminAuth, (req, res) => {
		const id = req.params.id;
		const aux = Number(req.body && req.body.aux);
		if(!deviceLock.isValidDeviceId(id))
		{
			return res.status(400).json({success: false, message: "Invalid device ID."});
		}
		if(!deviceLock.isValidAux(aux) || deskAuxName(aux) === undefined)
		{
			return res.status(400).json({success: false, message: "Unknown aux."});
		}
		const connected = connections.find(c => c.deviceId === id);
		const nextLocks = {...deviceLocks, [id]: {
			aux: aux,
			ip: connected ? connected.remoteIp : (deviceLocks[id] ? deviceLocks[id].ip : ""),
			lockedAt: new Date().toISOString(),
			auxName: deskAuxName(aux)
		}};
		if(!commitDeviceLocks(nextLocks, [id]))
		{
			return res.status(500).json({success: false, message: "Could not save the device locks."});
		}
		logger.info(`Admin locked device ${id} to aux ${aux} "${auxName(aux)}".`);
		res.json({success: true});
	});

	//remove a device lock
	app.post('/api/devices/:id/unlock', requireAdminAuth, (req, res) => {
		const id = req.params.id;
		if(!deviceLocks[id])
		{
			return res.status(404).json({success: false, message: "Device is not locked."});
		}
		const nextLocks = {...deviceLocks};
		delete nextLocks[id];
		if(!commitDeviceLocks(nextLocks, [id]))
		{
			return res.status(500).json({success: false, message: "Could not save the device locks."});
		}
		logger.info(`Admin unlocked device ${id}.`);
		res.json({success: true});
	});

	//provide the current config for the auxilaries
	app.get('/aux', (req, res) => {
		let auxDetails = [];

		if(cache.has(deskSync.AUX_MODES))
		{
			const total = deskSync.auxCount(cache);
			for(let i=0; i<total; i++)
			{
				const name = deskAuxName(i + 1);
				if(name === undefined)
				{
					continue;
				}
				const settings = auxSettings(i);
				const changed = identity.isChanged(settings.name, name);
				auxDetails.push({
					"number": i + 1,
					"enabled": settings.enabled,
					"name": name,
					"colour": identity.effectiveAuxColour(currentState.auxes?.[i], name, i, total),
					"icon": settings.icon,
					"previousName": changed ? settings.name : null
				});
			}
		}
		res.json(auxDetails);
	});

	//provide the current config for the channels
	app.get('/channels', (req, res) => {

		let channelDetails = [];
		const total = deskSync.channelCount(cache);
		for(let i=0; i<total; i++)
		{
			const name = deskChannelName(i + 1);
			if(name === undefined)
			{
				continue;
			}
			const settings = channelSettings(i);
			const changed = identity.isChanged(settings.name, name);
			channelDetails.push({
				"number": i + 1,
				"enabled": settings.enabled,
				"name": name,
				//the admin page historically shows 1-based order for channels without a saved order
				"order": currentState.channels?.[i]?.displayOrder ?? i + 1,
				"title": settings.title,
				"icon": settings.icon,
				"group": settings.group,
				"previousName": changed ? settings.name : null
			});
		}
		res.json(channelDetails);
	});

	//provide the configured channel groups
	app.get('/groups', (req, res) => {
		res.json(currentState.groups || []);
	});

	// Create the web server, with its websocket server
	const httpServer = http.createServer(app);
	httpServer.on("error", function(err)
	{
		if(err.code == "EADDRINUSE" || err.code == "EACCES")
		{
			logger.error(portErrorMessage(err, config.server.port, "Web server port") +
				` Close whatever is using it or change the Webserver Port in config/global.json.`);
			process.exit(1);
		}
		logger.error("Web server error: " + (err && err.stack ? err.stack : err));
	});
	const wsServer = createWebSocketServer(httpServer);
	httpServer.listen(config.server.port);

	server = httpServer;
	wss = wsServer;

	logger.info(`Web Server Ready. Please visit ${getServerURL()}/admin in a web browser to configure OSC Web Mixer.`);
}

/**
 * Handle POST /admin. Everything is validated, ports are test-bound, and the new settings are
 * saved before anything in memory changes.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function saveAdminForm(req, res)
{
	const body = req.body || {};
	const list = value => Array.isArray(value) ? value : (value === undefined ? undefined : [value]);
	const fail = (message) => res.status(400).json({success: false, message: message});

	const serverPort = parsePort(body.server_port);
	const oscPort = parsePort(body.osc_port);
	const deskPort = parsePort(body.desk_port);
	const deskIp = typeof body.desk_ip === "string" ? body.desk_ip.trim() : "";
	if(serverPort === null)
	{
		return fail("Webserver Port must be a whole number from 1 to 65535.");
	}
	if(oscPort === null)
	{
		return fail("OSC Receive Port must be a whole number from 1 to 65535.");
	}
	if(deskPort === null)
	{
		return fail("Mixing desk Receive Port must be a whole number from 1 to 65535.");
	}
	if(deskIp !== "" && net.isIP(deskIp) === 0)
	{
		return fail("Mixing desk IP Address must be an IP address (e.g. 192.168.1.10).");
	}

	const externalDevices = [];
	const externalNames = list(body.externalName);
	if(externalNames)
	{
		const ips = list(body.externalIP) || [], ports = list(body.externalReceive) || [];
		const broadcasts = list(body.externalBroadcast) || [], loopbacks = list(body.externalLoopback) || [];
		for(let x = 0; x < externalNames.length; x++)
		{
			const port = parsePort(ports[x]);
			const ip = typeof ips[x] === "string" ? ips[x].trim() : "";
			if(port === null || !isValidHost(ip))
			{
				return fail(`External device "${externalNames[x]}" needs a valid IP address and port.`);
			}
			externalDevices.push({
				broadcast: broadcasts[x] == "true",
				name: String(externalNames[x]),
				ip: ip,
				port: port,
				loopback: loopbacks[x] == "true"
			});
		}
	}

	const portChanged = serverPort !== Number(config.server.port);
	const oscPortChanged = oscPort !== Number(config.osc.port);
	if(portChanged)
	{
		const err = await checkTcpPortFree(serverPort);
		if(err)
		{
			return fail(portErrorMessage(err, serverPort, "Webserver Port") + " Settings were not saved.");
		}
	}
	if(oscPortChanged)
	{
		const err = await checkUdpPortFree(oscPort);
		if(err)
		{
			return fail(portErrorMessage(err, oscPort, "OSC Receive Port") + " Settings were not saved.");
		}
	}

	//build the new config and state on copies
	const nextConfig = structuredClone(config);
	nextConfig.server = {...nextConfig.server, port: serverPort};
	delete nextConfig.server.ip;
	nextConfig.osc = {...nextConfig.osc, port: oscPort};
	nextConfig.debug = body.debug == "debug";
	nextConfig.desk = {...nextConfig.desk, ip: deskIp, port: deskPort};
	nextConfig.externalDevices = externalDevices;

	const nextState = structuredClone(currentState);
	const renames = [];

	const auxEnabled = list(body.auxEnabled), auxColour = list(body.auxColour), auxIcon = list(body.auxIcon);
	if(auxEnabled && auxColour && auxIcon)
	{
		const auxNames = list(body.auxName) || [];
		nextState.auxes = auxEnabled.map((enabledValue, index) => {
			const previous = currentState.auxes?.[index];
			const slot = {
				enabled: enabledValue === "true",
				colour: auxColour[index],
				icon: auxIcon[index],
				name: previous?.name
			};
			const deskName = deskAuxName(index + 1);
			const formName = auxNames[index];
			if(typeof formName === "string" && deskName !== undefined && formName !== deskName)
			{
				//renamed from the admin page: that's the engineer's decision, so it is confirmed
				renames.push({address: deskSync.auxNameAddress(index + 1), name: formName});
				slot.name = formName;
			}
			if(slot.name === undefined)
			{
				delete slot.name;
			}
			return slot;
		});
	}

	//groupsSubmitted is always in the form, so an empty group list clears the groups
	if(body.groupsSubmitted !== undefined)
	{
		const ids = list(body.groupId) || [];
		const names = list(body.groupName) || [], icons = list(body.groupIcon) || [];
		nextState.groups = ids
			.map((id, index) => ({
				id: id,
				name: names[index] || `Group ${index + 1}`,
				icon: icons[index] || ""
			}))
			.filter(group => groupTrim.isValidGroupId(group.id));
	}
	const groupIds = new Set((nextState.groups || []).map(group => group.id));

	const channelEnabled = list(body.channelEnabled), channelOrder = list(body.channelOrder), channelIcon = list(body.channelIcon);
	if(channelEnabled && channelOrder && channelIcon)
	{
		const titles = list(body.sectionTitle), channelGroups = list(body.channelGroup), channelNames = list(body.channelName) || [];
		nextState.channels = channelEnabled.map((enabledValue, index) => {
			const previous = currentState.channels?.[index];
			const slot = {
				enabled: enabledValue === "true",
				displayOrder: parseInt(channelOrder[index]) || index,
				title: titles ? titles[index] : "",
				icon: channelIcon[index] ?? "",
				group: channelGroups && groupIds.has(channelGroups[index]) ? channelGroups[index] : "",
				name: previous?.name
			};
			const deskName = deskChannelName(index + 1);
			const formName = channelNames[index];
			if(typeof formName === "string" && deskName !== undefined && formName !== deskName)
			{
				renames.push({address: deskSync.channelNameAddress(index + 1), name: formName});
				slot.name = formName;
			}
			if(slot.name === undefined)
			{
				delete slot.name;
			}
			return slot;
		});
	}

	//save first: if the disk is full or read-only nothing changes
	try
	{
		configManager.saveCurrentState(nextState);
	}
	catch(e)
	{
		logger.error("Failed to save state.json: " + e.message);
		return res.status(500).json({success: false, message: "Could not save the settings: " + e.message});
	}
	currentState = nextState;

	try
	{
		configManager.saveGlobalConfig(nextConfig);
	}
	catch(e)
	{
		logger.error("Failed to save global.json: " + e.message);
		reconcileNames();
		pushConfigToAll();
		return res.status(500).json({success: false, message: "Aux and channel settings were saved, but the network settings could not be: " + e.message});
	}

	const deskChanged = nextConfig.desk.ip !== config.desk.ip || Number(nextConfig.desk.port) !== Number(config.desk.port);
	config = nextConfig;
	logger.setDebug(config.debug);
	logger.info("Configuration updated via web interface and saved.");

	//rename on the desk and let everyone know (not when switching to another desk: the names
	//in the form belong to the old one)
	for(const rename of (deskChanged ? [] : renames))
	{
		const msg = {address: rename.address, args: [rename.name]};
		cache.set(rename.address, msg);
		broadcast(msg);
	}

	if(oscPortChanged)
	{
		stopOSC();
		startOSC();
	}

	if(deskChanged)
	{
		restartDeskLoad(`Mixing desk address changed to ${config.desk.ip}:${config.desk.port}.`);
	}
	else
	{
		reconcileNames();
		queryPacer.reset();
		ensurePrimer(); //newly enabled channels/auxes need their sends
		pushConfigToAll();
	}

	if(portChanged)
	{
		logger.warn(`Server port has changed. Please visit ${getServerURL()} to continue.`);

		//respond with redirection to the new port
		res.send(`<script>document.location.href="${getServerURL()}/admin";</script>`);

		const oldServer = server, oldWss = wss;
		closeAllWebsocketConnections();
		oldWss.close();
		oldServer.close();
		startServer();
		return;
	}

	res.sendFile(__dirname + "/web/admin.html");
}

/**
 * Handle POST /api/identity/confirm {type, number, keepSettings}.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function confirmIdentity(req, res)
{
	const body = req.body || {};
	const type = body.type;
	const number = Number(body.number);
	const keepSettings = body.keepSettings === true || body.keepSettings === "true";
	if((type !== "aux" && type !== "channel") || !Number.isInteger(number) || number < 1 || number > 999)
	{
		return res.status(400).json({ok: false, message: "Expected {type: \"aux\"|\"channel\", number, keepSettings}."});
	}
	const deskName = type === "aux" ? deskAuxName(number) : deskChannelName(number);
	if(deskName === undefined)
	{
		return res.status(404).json({ok: false, message: `Unknown ${type} ${number}.`});
	}

	const key = type === "aux" ? "auxes" : "channels";
	const total = type === "aux" ? deskSync.auxCount(cache) : deskSync.channelCount(cache);
	const nextState = structuredClone(currentState);
	ensureSlot(nextState, key, number - 1);
	nextState[key][number - 1] = identity.confirmSlot(type, currentState[key]?.[number - 1], deskName, keepSettings, number - 1, total);

	let nextLayouts = channelLayouts;
	if(type === "aux" && !keepSettings && channelLayouts[number])
	{
		nextLayouts = {...channelLayouts};
		delete nextLayouts[number];
	}

	let nextLocks = deviceLocks;
	const lockedDevices = [];
	if(type === "aux")
	{
		for(const [id, lock] of Object.entries(deviceLocks))
		{
			if(lock.aux === number && lock.auxName !== deskName)
			{
				nextLocks = nextLocks === deviceLocks ? {...deviceLocks} : nextLocks;
				nextLocks[id] = {...lock, auxName: deskName};
				lockedDevices.push(id);
			}
		}
	}

	//save each file before using it; stop at the first failure
	try
	{
		configManager.saveCurrentState(nextState);
		currentState = nextState;
		if(nextLayouts !== channelLayouts)
		{
			configManager.saveChannelLayouts(nextLayouts);
			channelLayouts = nextLayouts;
			sendToSockets({address: channelLayout.layoutAddress(number), args: []});
		}
		if(nextLocks !== deviceLocks)
		{
			configManager.saveDeviceLocks(nextLocks);
			deviceLocks = nextLocks;
		}
	}
	catch(e)
	{
		logger.error(`Failed to save confirmation of ${type} ${number}: ${e.message}`);
		pushConfigToAll();
		return res.status(500).json({ok: false, message: "Could not save: " + e.message});
	}

	logger.info(`Confirmed ${type} ${number} is now "${deskName}" (${keepSettings ? "settings kept" : "settings reset"}).` +
		(lockedDevices.length ? ` ${lockedDevices.length} locked device(s) resumed.` : ""));
	queryPacer.reset();
	ensurePrimer();
	pushConfigToAll();
	res.json({ok: true});
}

/**
 * Get the current server url
 */
function getServerURL()
{
	let url = `http://${mixServerIP}`;
	if(config.server.port != 80)
	{
		url += ":" + config.server.port;
	}
	return url;
}

/* ------------------------------------------------------------------------------------------
 * WebSocket server
 * ---------------------------------------------------------------------------------------- */

/**
 * Create the websocket server for an http server. One per http server; it is closed together
 * with that server when the web port changes.
 * @param {http.Server} httpServer
 * @returns {webSocket.Server}
 */
function createWebSocketServer(httpServer)
{
	const wsServer = new webSocket.Server({
		server: httpServer,
		maxPayload: WEBSOCKET_MAX_PAYLOAD
	});

	//when a webmixer user has connected. Sockets are accepted while the desk data is loading;
	//they get the status ("loading") now and the config once loading has finished.
	wsServer.on("connection", function(socket, req)
	{
		//webmixer clients identify themselves with ?device=<id>. The admin page doesn't, so deviceId is null there.
		socket.deviceId = deviceLock.deviceIdFromUrl(req && req.url);
		socket.remoteIp = req && req.socket ? String(req.socket.remoteAddress || "").replace(/^::ffff:/, "") : "";
		socket.connectedAt = new Date();
		socket.lastSeen = Date.now();
		socket.isAlive = true;

		//per-socket errors (malformed frames, connection reset by a device dropping off wifi...).
		//Without this listener they surface as uncaught exceptions. ws closes the socket itself.
		socket.on("error", function(err)
		{
			logger.warn(`Websocket client error (${socket.remoteIp || "unknown ip"}): ${err && err.message ? err.message : err}`);
		});

		socket.on("pong", function()
		{
			socket.isAlive = true;
			socket.lastSeen = Date.now();
		});

		socket.on("close", function() {
			connections = connections.filter(conn => conn !== socket);
			logger.debug(`Websocket client disconnected. (Total: ${connections.length})`);
		});

		if(socket.deviceId && deviceLocks[socket.deviceId] && deviceLocks[socket.deviceId].ip !== socket.remoteIp)
		{
			commitDeviceLocks({...deviceLocks, [socket.deviceId]: {...deviceLocks[socket.deviceId], ip: socket.remoteIp}}, []);
		}

		//save the new connection
		connections.push(socket);

		logger.debug(`New WebSocket client connected from ${socket.remoteIp}. (Total: ${connections.length})`);

		sendToSocket(socket, statusMessage());
		pushConfig(socket);

		//when a message has been sent from a webmixer user
		socket.on('message', function message(data)
		{
			try
			{
				handleSocketMessage(socket, data);
			}
			catch(e)
			{
				logger.error("Error handling websocket message: " + (e && e.stack ? e.stack : e));
			}
		});
	});

	//drop sockets that stopped answering pings (tablets going to sleep, wifi drop-outs)
	//so they don't pile up in the connection list
	const heartbeat = setInterval(function()
	{
		for(const socket of wsServer.clients)
		{
			if(socket.isAlive === false)
			{
				logger.debug(`Terminating unresponsive websocket client (${socket.remoteIp || "unknown ip"}).`);
				socket.terminate();
				continue;
			}
			socket.isAlive = false;
			try
			{
				socket.ping();
			}
			catch(e)
			{
				socket.terminate();
			}
		}
	}, WEBSOCKET_HEARTBEAT_MS);

	wsServer.on("close", function()
	{
		clearInterval(heartbeat);
	});

	//when a websocket error occurs
	wsServer.on("error", function (err)
	{
		logger.error("wss error: " + (err && err.stack ? err.stack : err));
	});

	return wsServer;
}

/**
 * Handle one message from a webmixer socket.
 * @param {WebSocket} socket
 * @param {Buffer|string} data
 */
function handleSocketMessage(socket, data)
{
	socket.lastSeen = Date.now();

	let oscMsg;
	try
	{
		oscMsg = JSON.parse(data);
	}
	catch(e)
	{
		logger.warn("Ignoring malformed message from socket client: " + String(data).slice(0, 200));
		return;
	}
	if(!oscMsg || typeof oscMsg.address !== "string" || (oscMsg.args !== undefined && !Array.isArray(oscMsg.args)))
	{
		logger.warn("Ignoring message without a valid address/args from socket client: " + String(data).slice(0, 200));
		return;
	}
	logger.debug("Message recieved from websocket client: " + JSON.stringify(oscMsg));

	if(handleLockMessage(socket, oscMsg))
	{
		return;
	}

	if(!loaded)
	{
		logger.debug(`Ignoring ${oscMsg.address}: still loading values from the mixing desk.`);
		return;
	}

	//a locked device may only change its own aux, and nothing at all while its aux changed identity
	const lock = socket.deviceId ? deviceLocks[socket.deviceId] : undefined;
	if(lock)
	{
		if(lockInfo(lock).suspended)
		{
			logger.debug(`Blocked ${oscMsg.address} from device ${socket.deviceId}: lock on aux ${lock.aux} is suspended.`);
			return;
		}
		if(!deviceLock.isAddressAllowedForAux(oscMsg.address, lock.aux))
		{
			logger.debug(`Blocked ${oscMsg.address} from device ${socket.deviceId} (locked to aux ${lock.aux}).`);
			return;
		}
	}

	if(handleLayoutMessage(socket, oscMsg) || handleGroupMessage(socket, oscMsg))
	{
		return;
	}

	const checked = oscValidation.sanitizeClientMessage(oscMsg);
	if(!checked.ok)
	{
		logger.debug(`Rejected ${String(oscMsg.address).slice(0, 100)} from socket client (${socket.remoteIp}): ${checked.reason}.`);
		return;
	}

	let msg = processPlugins(checked.msg);
	if(msg === false)
	{
		return;
	}

	//respond from cache if a value exists; otherwise ask the desk (the reply is broadcast)
	if(oscValidation.isQuery(msg.address))
	{
		const key = msg.address.slice(0, -2);
		if(cache.has(key))
		{
			sendToSocket(socket, cache.get(key));
			return;
		}
		broadcast(msg, socket);
		return;
	}

	forgetTrimOvershoot(msg.address);
	const unchanged = sameAsCached(msg);
	maybeCacheResponse(msg);

	//set commands always reach the desk, even when the cache already has that value (the cache
	//is updated before the desk confirms, so it may be wrong); others only need real changes
	if(unchanged)
	{
		sendToDesk(msg);
		return;
	}
	broadcast(msg, socket);
}

/**
 * Close all webmixer connections
 */
function closeAllWebsocketConnections()
{
	for(let connection of connections)
	{
		try
		{
			connection.close(1012, "Server restarting");
		}
		catch(e)
		{
			connection.terminate();
		}
	}
	connections = [];
}

/* ------------------------------------------------------------------------------------------
 * Desk communication
 * ---------------------------------------------------------------------------------------- */

/**
 * Throw away everything known about the desk and load it again (session change, new desk address).
 * Sockets stay connected; they see "loading" and get a fresh config when it is done.
 * @param {string} reason
 */
function restartDeskLoad(reason)
{
	logger.info(reason + " Reloading values from the mixing desk.");
	cache.clear();
	groupLevels.clear();
	trimOvershoot.clear();
	staleAddresses.clear();
	consoleInfoSeen.clear();
	queryPacer.reset();
	deskEchoes.clear();
	stopPrimer();
	currentSnapshot = -1;
	currentSnapshotName = "";
	loaded = false;
	lastDeskRx = 0;
	publishStatus();
	startLoading();
}

/**
 * Start (or restart) the initial load. Retries the pending query until the desk answers.
 */
function startLoading()
{
	clearTimeout(loadTimer);
	lastLoadQuery = null;
	lastWaitingLogAt = Date.now();
	const tick = function()
	{
		if(loaded)
		{
			return;
		}
		if(!config.desk.ip)
		{
			logger.debug("Mixing desk IP address not set.");
		}
		else
		{
			loadNextRequiredParameter(true);
		}
		loadTimer = setTimeout(tick, LOAD_RETRY_MS);
	};
	tick();
}

/**
 * Request the required parameters from the desk in order.
 * This gets called every time a message arrives until all the required parameters have loaded,
 * and by the retry timer (force) so a lost reply doesn't stall loading.
 * @param {boolean} [force] - resend even if the same query was just sent
 */
function loadNextRequiredParameter(force = false)
{
	if(loaded)
	{
		return;
	}
	const query = deskSync.nextLoadQuery(cache);
	if(query === null)
	{
		finishLoading();
		return;
	}
	const now = Date.now();
	if(!force && query === lastLoadQuery && now - lastLoadQueryAt < LOAD_QUERY_MIN_GAP_MS)
	{
		return;
	}
	lastLoadQuery = query;
	lastLoadQueryAt = now;
	logger.debug(`Requesting ${query} from Mixing Desk`);
	sendToDesk({address: query, args: []});
}

/**
 * Everything required has arrived from the desk.
 */
function finishLoading()
{
	clearTimeout(loadTimer);
	loaded = true;

	//request current snapshot. If there is a snapshot then the index on the snapshot will be returned.
	//We can then request the name of that snapshot
	sendToDesk({address: "/Snapshots/Current_Snapshot/?", args: []});

	logger.info(`Loaded values from mixing desk (${deskSync.channelCount(cache)} channels, ${deskSync.auxCount(cache)} auxes).`);
	reconcileNames();
	queryPacer.reset();
	ensurePrimer();
	publishStatus();
	pushConfigToAll();
	logger.info("Webmixer ready to use.");
}

/**
 * The desk said something.
 */
function noteDeskRx()
{
	const wasOffline = loaded && publishedDeskState === "offline";
	lastDeskRx = Date.now();
	if(wasOffline)
	{
		publishStatus();
		resyncFromDesk();
	}
}

/**
 * The desk came back after being silent: values may have changed meanwhile, so re-read
 * everything (counts, names, sends). Cached values stay visible until the answers arrive.
 */
function resyncFromDesk()
{
	logger.info("Re-reading values from the mixing desk.");
	for(const address of cache.keys())
	{
		if(address === deskSync.CHANNEL_COUNT || address === deskSync.AUX_MODES ||
			/\/(send_level|send_pan|send_on|Buss_Trim\/name|Channel_Input\/name)$/.test(address))
		{
			staleAddresses.add(address);
		}
	}
	queryPacer.reset();
	ensurePrimer();
}

function ensurePrimer()
{
	if(primeTimer || !loaded)
	{
		return;
	}
	primeTimer = setInterval(primeTick, PRIME_TICK_MS);
}

function stopPrimer()
{
	clearInterval(primeTimer);
	primeTimer = null;
}

/**
 * Load missing/stale names and AUX levels and panning values into the cache, a few at a time.
 * These aren't essential to start using webmixer so they load in the background.
 */
function primeTick()
{
	if(!loaded)
	{
		stopPrimer();
		return;
	}
	if(computeDeskState() === "offline")
	{
		return; //wait for the desk; resyncFromDesk() takes over when it is back
	}
	const wanted = deskSync.wantedQueries(cache, {
		channelEnabled: channel => channelSettings(channel - 1).enabled,
		auxEnabled: aux => auxSettings(aux - 1).enabled,
		stale: staleAddresses
	});
	const {send, done} = queryPacer.pick(wanted);
	for(const query of send)
	{
		sendToDesk({address: query, args: []});
	}
	if(done)
	{
		stopPrimer();
		if(wanted.length > 0)
		{
			logger.warn(`The mixing desk did not answer ${wanted.length} request(s), e.g. ${wanted[0]}. Giving up on those.`);
		}
		staleAddresses.clear();
		logger.debug("Cache Primed");
	}
}

/**
 * Every second: publish status changes, keep-alives, poll the desk, warn while it is missing.
 */
function statusTick()
{
	const now = Date.now();
	publishStatus();

	if(now - lastKeepAliveAt >= STATUS_KEEPALIVE_MS)
	{
		sendStatusToAll();
	}

	if(loaded && now - lastDeskPollAt >= DESK_POLL_MS)
	{
		lastDeskPollAt = now;
		deskPollCount++;
		sendToDesk({address: "/Console/Channels/?", args: []});
		if(deskPollCount % DESK_POLL_MODES_EVERY === 0)
		{
			sendToDesk({address: deskSync.AUX_MODES + "/?", args: []});
		}
	}

	const state = computeDeskState();
	if(state !== "online" && now - lastWaitingLogAt >= WAITING_LOG_MS)
	{
		lastWaitingLogAt = now;
		if(!config.desk.ip)
		{
			logger.warn(`Mixing desk IP address is not set. Set it in the admin page: ${getServerURL()}/admin`);
		}
		else
		{
			const ago = lastDeskRx ? `last reply ${Math.round((now - lastDeskRx) / 1000)} s ago` : "no reply yet";
			const pending = !loaded && lastLoadQuery ? `, waiting for an answer to ${lastLoadQuery}` : "";
			logger.warn(`Still waiting for the mixing desk at ${config.desk.ip}:${config.desk.port} (${ago}${pending}). ` +
				`Check the desk's IP, that its OSC/iPad output points at this server (${mixServerIP}) on port ${config.osc.port}, and the network.`);
		}
	}
}

/**
 * Answer a query from an external device from the cache, replying only to that device.
 * @param {{address: string, args: any[]}} oscMsg
 * @param {{address: string, port: number}} info - sender
 */
function answerExternalQuery(oscMsg, info)
{
	const key = oscMsg.address.slice(0, -2);
	if(!cache.has(key))
	{
		broadcast(oscMsg, info.address); //ask the desk; its reply is broadcast to everyone
		return;
	}
	const reply = cache.get(key);
	const externals = (config.externalDevices || []).filter(external => external.ip === info.address);
	if(externals.length > 0)
	{
		for(const external of externals)
		{
			sendToExternal(reply, external.ip, external.port, external.name);
		}
	}
	else
	{
		sendToExternal(reply, info.address, info.port, info.address);
	}
}

/** When the "desk looks like it is at another IP" warning was last logged, per IP. */
const deskLookalikeWarnedAt = new Map();

/**
 * Desk replies only count when they come from the configured desk IP. If desk-like messages
 * arrive from another address that isn't a configured external device, the desk IP is probably
 * wrong (or the desk has several network ports) - say so, loudly.
 * @param {{address: string}} oscMsg
 * @param {{address: string}} info
 */
function warnIfLooksLikeDesk(oscMsg, info)
{
	if(!/^/(Console|Input_Channels|Aux_Outputs|Snapshots)//.test(oscMsg.address) ||
		(config.externalDevices || []).some(external => external.ip === info.address))
	{
		return;
	}
	const now = Date.now();
	if(now - (deskLookalikeWarnedAt.get(info.address) || 0) < 60000)
	{
		return;
	}
	deskLookalikeWarnedAt.set(info.address, now);
	logger.warn(`Received desk messages (${oscMsg.address}) from ${info.address}, but the mixing desk IP is set to ` +
		`"${config.desk.ip}". If ${info.address} is the desk, set it as the desk IP in the admin page.`);
}

/**
 * Handle one OSC message received over UDP (from the desk or an external device).
 * @param {{address: string, args: any[]}} oscMsg
 * @param {{address: string, port: number}} info
 */
function handleUdpMessage(oscMsg, info)
{
	if(!oscMsg || typeof oscMsg.address !== "string")
	{
		return;
	}
	if(!Array.isArray(oscMsg.args))
	{
		oscMsg = {...oscMsg, args: oscMsg.args === undefined ? [] : [oscMsg.args]};
	}
	logger.debug("Message received over UDP: " + JSON.stringify(oscMsg));

	const fromDesk = Boolean(config.desk.ip) && info.address === config.desk.ip;
	if(fromDesk)
	{
		noteDeskRx();
		staleAddresses.delete(oscMsg.address);
		queryPacer.forget(oscMsg.address + "/?");
	}

	//session has changed. Reload
	if(oscMsg.address == "/Console/Session/!")
	{
		restartDeskLoad(`Session changed on the desk (from ${info.address}).`);
		return;
	}

	if(fromDesk)
	{
		//ignore values we already have, and the desk echoing values we sent it - but never let
		//that stall loading
		const echo = deskEchoes.isEcho(oscMsg.address, oscMsg.args);
		if(echo || sameAsCached(oscMsg) || sameAsLastConsoleInfo(oscMsg))
		{
			logger.debug(`${echo ? "Desk echo" : "Message already in cache"} ${JSON.stringify(oscMsg)}`);
			if(!loaded)
			{
				loadNextRequiredParameter();
			}
			return;
		}
	}
	else
	{
		warnIfLooksLikeDesk(oscMsg, info);

		//ignore values we already have (stops loops with devices that send values back)
		if(sameAsCached(oscMsg))
		{
			logger.debug("Message already in cache " + JSON.stringify(oscMsg));
			return;
		}
		if(!loaded)
		{
			return;
		}
		oscMsg = oscValidation.sanitizeExternalMessage(oscMsg);
		if(!oscMsg)
		{
			logger.debug(`Dropped invalid message from ${info.address}.`);
			return;
		}
	}

	oscMsg = processPlugins(oscMsg);
	if(oscMsg === false)
	{
		return;
	}

	processSnapshotMsg(oscMsg);

	forgetTrimOvershoot(oscMsg.address);
	const previous = cache.get(oscMsg.address);
	maybeCacheResponse(oscMsg);

	if(!loaded)
	{
		loadNextRequiredParameter();
		return;
	}

	if(fromDesk)
	{
		onDeskValueChanged(oscMsg, previous);
	}

	if(oscValidation.isQuery(oscMsg.address))
	{
		answerExternalQuery(oscMsg, info);
		return;
	}

	broadcast(oscMsg, info.address); //send to everyone except the IP that it came from
}

/**
 * Start listening to OSC messages from the network
 */
function startOSC()
{
	const port = new osc.UDPPort({
		localAddress: "0.0.0.0",
		localPort: config.osc.port
	});
	udpPort = port;

	port.on("error", function (err)
	{
		if(err.code == "EHOSTDOWN" || err.code == "EHOSTUNREACH")
		{
			logger.error(err.address + " is not responding");
			return;
		}
		if(err.code == "EADDRINUSE" || err.code == "EACCES")
		{
			//can't receive OSC without this port - retrying is pointless, so fail loudly
			logger.error("Could not open OSC port.");
			logger.error(portErrorMessage(err, config.osc.port, "OSC port") +
				` Close whatever is using it or change the OSC Receive Port in config/global.json.`);
			process.exit(1);
		}
		logger.error("UDP error: " + (err && err.stack ? err.stack : err));
	});

	port.on("message", function(oscMsg, timeTag, info)
	{
		if(port !== udpPort)
		{
			return; //a port that is being closed
		}
		try
		{
			handleUdpMessage(oscMsg, info);
		}
		catch(e)
		{
			logger.error("Error handling OSC message: " + (e && e.stack ? e.stack : e));
		}
	});

	port.on("ready", function()
	{
		if(!loaded)
		{
			logger.info(`Loading values from mixing desk ${config.desk.ip || "(IP not set)"}:${config.desk.port}...`);
			startLoading();
		}
	});

	port.open();
}

/**
 * Handles Current Snapshot messages sent by the console
 * @param {object} oscMsg
 */
function processSnapshotMsg(oscMsg)
{
	if(oscMsg.address == "/Snapshots/Current_Snapshot")
	{
		currentSnapshot = oscMsg.args[0];

		//when the current snapshot has been deleted
		if(currentSnapshot < 0)
		{
			currentSnapshotName = "";
			broadcast({
				"address": "/SnapshotName",
				args: [
					currentSnapshotName
				]
			}, config.desk.ip);
			return;
		}

		//request the names for the current snapshots. We will use the response to store the snapshot name below.
		sendToDesk({address: "/Snapshots/names/?", args: []});

		return;
	}

	//rename the current snapshot
	let renameSnapshot = oscMsg.address.match(/^\/Snapshots\/Rename_Snapshot\/([0-9]+)$/);
	if(renameSnapshot !== null && renameSnapshot[1] == currentSnapshot)
	{
		currentSnapshotName = oscMsg.args[0];

		broadcast({
			"address": "/SnapshotName",
			args: [
				currentSnapshotName
			]
		}, config.desk.ip);

		return;
	}

	//if the message is the snapshot name we are waiting for
	if(oscMsg.address == "/Snapshots/name" && oscMsg.args[0] == currentSnapshot)
	{
		currentSnapshotName = oscMsg.args[oscMsg.args.length - 1];

		broadcast({
			"address": "/SnapshotName",
			args: [
				currentSnapshotName
			]
		}, config.desk.ip);
	}
}

/**
 * Stop listening to OSC messages
 */
function stopOSC()
{
	const port = udpPort;
	udpPort = undefined;
	try
	{
		port.close();
	}
	catch(e)
	{
		logger.warn("Error closing OSC port: " + e.message);
	}
}

/**
 * Determine if we should cache the message and store it in memory.
 * @param {object} msg - the osc message to
 */
function maybeCacheResponse(msg)
{
	let matchAddresses = [
		/^\/Input_Channels\/(\d{1,3})\/Aux_Send\/(\d{1,3})\/send_level$/, //cache channel aux level
		/^\/Input_Channels\/(\d{1,3})\/Aux_Send\/(\d{1,3})\/send_pan$/, //cache channel aux pan
		/^\/Input_Channels\/(\d{1,3})\/Aux_Send\/(\d{1,3})\/send_on$/, //cache channel aux send on/off
		/^\/Input_Channels\/(\d{1,3})\/Channel_Input\/name$/, //cache channel name
		/^\/Aux_Outputs\/(\d{1,3})\/Buss_Trim\/name$/, //cache aux name
		/^\/Console\/Aux_Outputs\/modes$/, //cache aux modes (stereo or mono)
		/^\/Console\/Input_Channels$/ //cache total number of channels
	];

	for(let address of matchAddresses)
	{
		if(address.test(msg.address))
		{
			cache.set(msg.address, {address: msg.address, args: Array.isArray(msg.args) ? msg.args : []});
			logger.debug(`Cached ${JSON.stringify(msg)}`);
			return;
		}
	}
}

/** Last time each plugin's error was logged, so a broken plugin can't flood the log. */
const pluginErrorLoggedAt = new Map();

/**
 * Processes all loaded plugins. A plugin that throws is logged and skipped (the message
 * carries on unchanged) so one broken plugin can't stop the mixer.
 * @param {Object} oscMsg
 * @return {bool|object} - false when nothing should happen after the plugins have executed or the OSC message which may have been modified.
 */
function processPlugins(oscMsg)
{
	for(const plugin of plugins)
	{
		let response;
		try
		{
			response = plugin.handleOSC(oscMsg, {broadcast: broadcast, cache: cache, send: sendUDP});
		}
		catch(e)
		{
			const now = Date.now();
			if(now - (pluginErrorLoggedAt.get(plugin) || 0) > 10000)
			{
				pluginErrorLoggedAt.set(plugin, now);
				logger.error(`Plugin "${plugin.__file}" failed on ${oscMsg.address}: ${e && e.stack ? e.stack : e}`);
			}
			continue;
		}
		if(response === false)
		{
			return false;
		}
		if(response !== undefined)
		{
			if(response && typeof response.address === "string")
			{
				oscMsg = Array.isArray(response.args) ? response : {...response, args: []};
			}
			else
			{
				logger.warn(`Plugin "${plugin.__file}" returned an invalid message for ${oscMsg.address}; ignoring it.`);
			}
		}
	}
	return oscMsg;
}

startServer();
startOSC();
setInterval(statusTick, STATUS_TICK_MS);

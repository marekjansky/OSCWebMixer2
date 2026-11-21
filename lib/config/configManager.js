const fs = require("fs");
const path = require("path");
const logger = require("../logging/logger.js")
const crypto = require("crypto")

/**
 * Resolve the config directory. Order: OSCWEBMIXER_CONFIG_DIR env var, then (pkg builds) a "config"
 * folder next to the executable, otherwise "<app dir>/config" (independent of process.cwd()).
 * Evaluated on every call so tests can change the env var.
 */
function getConfigDirectory() {
	if (process.env.OSCWEBMIXER_CONFIG_DIR) {
		return path.resolve(process.env.OSCWEBMIXER_CONFIG_DIR)
	}
	if (process.pkg) {
		return path.join(path.dirname(process.execPath), "config")
	}
	return path.resolve(__dirname, "..", "..", "config")
}

const configFile = name => path.join(getConfigDirectory(), name)
const GLOBAL_FILE = "global.json"
const STATE_FILE = "state.json"
const PRESETS_FILE = "presets.json"
const DEVICES_FILE = "devices.json"
const LAYOUTS_FILE = "layouts.json"

function sleepSync(ms) {
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
	} catch (e) { /* ignore */ }
}

/**
 * Checks if the config directory exists and creates it if not
 * @returns {boolean} Whether the config directory existed prior to executing this function.
 */
function ensureConfigDirectoryExists() {
	const dir = getConfigDirectory()
	try {
		if (!fs.existsSync(dir)) {
			logger.warn(`Configuration directory "${dir}" not found. Creating empty directory.`)
			fs.mkdirSync(dir, { recursive: true })
			return false
		}
	} catch (e) {
		logger.error(`Cannot create configuration directory "${dir}": ${e.message}`)
		return false
	}
	return true
}

function renameWithRetry(from, to) {
	const delays = [10, 25, 50, 100, 200, 400, 800]
	for (let i = 0; ; i++) {
		try {
			fs.renameSync(from, to)
			return
		} catch (e) {
			const transient = e.code === "EPERM" || e.code === "EBUSY" || e.code === "EACCES"
			if (!transient || i >= delays.length) throw e
			sleepSync(delays[i])
		}
	}
}

function isParsable(file) {
	try {
		JSON.parse(fs.readFileSync(file, "utf-8"))
		return true
	} catch (e) {
		return false
	}
}

/**
 * Atomically write a file: temp file in the same directory, fsync, then rename over the target.
 * The previous (valid) target is kept as "<file>.bak". Throws on failure.
 * @param {string} file absolute path
 * @param {string} data
 */
function atomicWriteFile(file, data) {
	fs.mkdirSync(path.dirname(file), { recursive: true })
	const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`
	let fd
	try {
		fd = fs.openSync(tmp, "w")
		fs.writeSync(fd, data, 0, "utf8")
		fs.fsyncSync(fd)
		fs.closeSync(fd)
		fd = undefined

		// Keep the previous good file (never replace a good .bak with a corrupt file)
		if (fs.existsSync(file) && isParsable(file)) {
			try {
				fs.copyFileSync(file, `${file}.bak`)
			} catch (e) {
				logger.warn(`Could not update backup ${file}.bak: ${e.message}`)
			}
		}
		renameWithRetry(tmp, file)
	} catch (err) {
		if (fd !== undefined) {
			try { fs.closeSync(fd) } catch (e) { /* ignore */ }
		}
		try { fs.unlinkSync(tmp) } catch (e) { /* ignore */ }
		logger.error(`Failed to write ${file}: ${err.message}`)
		throw err
	}
}

function saveJson(name, value) {
	atomicWriteFile(configFile(name), JSON.stringify(value, null, 2))
}

/**
 * Load and parse a JSON config file. Never throws.
 * Missing -> defaults. Corrupt/invalid -> file renamed to "<name>.corrupt-<timestamp>", then "<name>.bak", then defaults.
 * @param {string} name file name inside the config directory
 * @param {(v:any)=>boolean} isValid
 * @param {()=>any} makeDefault
 * @param {string} missingMessage warning when the file doesn't exist
 */
function loadJson(name, isValid, makeDefault, missingMessage) {
	const file = configFile(name)
	try {
		if (!fs.existsSync(file)) {
			if (missingMessage) logger.warn(missingMessage)
			return makeDefault()
		}
		let reason
		try {
			const parsed = JSON.parse(fs.readFileSync(file, "utf-8"))
			if (isValid(parsed)) return parsed
			reason = "unexpected content"
		} catch (e) {
			reason = e.message
		}

		logger.error(`!!! CONFIG FILE "${file}" IS CORRUPT (${reason}) !!!`)
		const corruptPath = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`
		try {
			renameWithRetry(file, corruptPath)
			logger.error(`Corrupt file preserved as "${corruptPath}".`)
		} catch (e) {
			logger.error(`Could not move corrupt file aside: ${e.message}`)
		}

		const bak = `${file}.bak`
		try {
			if (fs.existsSync(bak)) {
				const parsed = JSON.parse(fs.readFileSync(bak, "utf-8"))
				if (isValid(parsed)) {
					logger.error(`Recovered "${name}" from backup "${bak}". Recent changes may be lost.`)
					try { fs.copyFileSync(bak, file) } catch (e) { /* will be rewritten on next save */ }
					return parsed
				}
			}
		} catch (e) {
			logger.error(`Backup "${bak}" is unusable too: ${e.message}`)
		}
		logger.error(`No usable backup for "${name}". Using default values.`)
		return makeDefault()
	} catch (e) {
		logger.error(`Unexpected error loading "${name}": ${e.message}. Using default values.`)
		return makeDefault()
	}
}

const isObject = v => v !== null && typeof v === "object" && !Array.isArray(v)

function defaultGlobalConfig() {
	return {
		debug: false,
		server: {
			port: 80
		},
		osc: {
			port: 8000
		},
		desk: {
			ip: "",
			port: 9000
		},
		externalDevices: []
	}
}

/**
 * Load global config from disk. If it doesn't exist (or is unrecoverable) then use default values.
 * Never throws.
 * @returns {AppGlobalConfig} Global config object
 */
function getGlobalConfigOrDefault() {
	const loaded = loadJson(GLOBAL_FILE, isObject, defaultGlobalConfig,
		`Global configuration file "${configFile(GLOBAL_FILE)}" does not exist. Using default values.`)
	// Fill in sections missing from an old/partial file so the rest of the app doesn't crash
	const defaults = defaultGlobalConfig()
	for (const key of Object.keys(defaults)) {
		if (loaded[key] === undefined || loaded[key] === null) {
			loaded[key] = defaults[key]
		} else if (isObject(defaults[key]) && !isObject(loaded[key])) {
			loaded[key] = defaults[key]
		}
	}
	if (!Array.isArray(loaded.externalDevices)) loaded.externalDevices = []
	return loaded
}

/**
 * @param {AppGlobalConfig} config 
 * @throws if the file cannot be written
 */
function saveGlobalConfig(config) {
	saveJson(GLOBAL_FILE, config)
}


/**
 * Get application save state. Never throws.
 * @returns {AppWebmixerPreset}
 */
function getCurrentStateOrDefault() {
	return loadJson(STATE_FILE, isObject, () => ({
		uuid: "",
		name: "Default",
		sessionName: "",
		auxes: [],
		channels: []
	}), `Current state configuration file "${configFile(STATE_FILE)}" does not exist. Starting from a blank state.`)
}

/**
 * Saves the current runtime state to state.json
 * @param {AppWebmixerPreset} state 
 * @throws if the file cannot be written
 */
function saveCurrentState(state) {
	saveJson(STATE_FILE, state)
}


/**
 * @returns {AppWebmixerPreset[]}
 */
function getPresets() {
	return loadJson(PRESETS_FILE, Array.isArray, () => [], null)
}

/**
 * @param {string} uuid 
 * @returns {AppWebmixerPreset | undefined}
 */
function getPresetById(uuid) {
    return getPresets().find(p => p.uuid === uuid);
}

/**
 * @param {string} name 
 * @returns {AppWebmixerPreset | undefined}
 */
function getPresetByName(name) {
    return getPresets().find(p => p.name === name);
}

/**
 * 
 * @param {AppWebmixerPreset} preset
 * @param {string} presetName
 * @returns {AppWebmixerPreset}
 */
function saveCurrentStateAsPreset(currentState, presetName) {
	let presets = getPresets();

	if (presets.find(p => p.name === presetName) !== undefined) {
        const error = new Error(`A preset named '${presetName}' already exists.`);
        error.code = 'PRESET_EXISTS';
        throw error;
    }

	const newPreset = {
		...structuredClone(currentState),
		uuid: crypto.randomUUID(),
		name: presetName,
		lastChanged: new Date().toISOString()
	};

	presets.push(newPreset);
	savePresetsToFile(presets);
	return newPreset;
}


/**
 * @throws if the file cannot be written
 */
function savePresetsToFile(presets) {
	saveJson(PRESETS_FILE, presets)
}

/**
 * Deletes a preset by its UUID
 * @param {string} uuid 
 */
function deletePreset(uuid) {
    let presets = getPresets();
    const index = presets.findIndex(p => p.uuid === uuid);

    if (index === -1) {
        const error = new Error(`Preset with UUID "${uuid}" not found.`);
        error.code = 'PRESET_NOT_FOUND';
        throw error;
    }

    presets.splice(index, 1);
    savePresetsToFile(presets);
    
    return true; 
}

/**
 * Device locks are stored separately from state.json so that loading a preset never changes them.
 * Never throws.
 * @returns {Object<string, AppDeviceLock>} map of device ID to lock
 */
function getDeviceLocks() {
	return loadJson(DEVICES_FILE, isObject, () => ({}), null)
}

/**
 * @param {Object<string, AppDeviceLock>} locks
 * @throws if the file cannot be written
 */
function saveDeviceLocks(locks) {
	saveJson(DEVICES_FILE, locks)
}

/**
 * Per-aux channel layouts (order and hidden channels) set from the mixer, keyed by aux number.
 * Never throws.
 * @returns {Object<string, {order: number[], hidden: number[]}>}
 */
function getChannelLayouts() {
	return loadJson(LAYOUTS_FILE, isObject, () => ({}), null)
}

/**
 * @param {Object<string, {order: number[], hidden: number[]}>} layouts
 * @throws if the file cannot be written
 */
function saveChannelLayouts(layouts) {
	saveJson(LAYOUTS_FILE, layouts)
}

module.exports = {
	ensureConfigDirectoryExists,
	getGlobalConfigOrDefault,
	getCurrentStateOrDefault,
	saveGlobalConfig,
	saveCurrentState,
	getPresets,
	getPresetById,
	getPresetByName,
	saveCurrentStateAsPreset,
	deletePreset,
	getDeviceLocks,
	saveDeviceLocks,
	getChannelLayouts,
	saveChannelLayouts,
	// new: resolved config directory (useful for logging / diagnostics)
	getConfigDirectory
}

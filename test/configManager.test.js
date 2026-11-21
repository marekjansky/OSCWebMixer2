const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

let dir;
let cm;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "oscmixer-cfg-"));
	process.env.OSCWEBMIXER_CONFIG_DIR = dir;
	cm = require("../lib/config/configManager.js");
});

afterEach(() => {
	delete process.env.OSCWEBMIXER_CONFIG_DIR;
	fs.rmSync(dir, { recursive: true, force: true });
});

const files = () => fs.readdirSync(dir).sort();

test("config dir honours env var", () => {
	assert.strictEqual(cm.getConfigDirectory(), path.resolve(dir));
});

test("atomic write leaves no temp files and a complete file", () => {
	cm.saveDeviceLocks({ a: { aux: 1, ip: "x", lockedAt: "t" } });
	assert.deepStrictEqual(files(), ["devices.json"]);
	assert.deepStrictEqual(cm.getDeviceLocks(), { a: { aux: 1, ip: "x", lockedAt: "t" } });
});

test("previous good file is kept as .bak", () => {
	cm.saveChannelLayouts({ 1: { order: [1], hidden: [] } });
	cm.saveChannelLayouts({ 1: { order: [2], hidden: [] } });
	assert.deepStrictEqual(files(), ["layouts.json", "layouts.json.bak"]);
	const bak = JSON.parse(fs.readFileSync(path.join(dir, "layouts.json.bak"), "utf8"));
	assert.deepStrictEqual(bak, { 1: { order: [1], hidden: [] } });
});

test("corrupt file recovered from .bak and corrupt copy preserved", () => {
	cm.saveCurrentState({ name: "one", auxes: [], channels: [] });
	cm.saveCurrentState({ name: "two", auxes: [], channels: [] });
	fs.writeFileSync(path.join(dir, "state.json"), "{ truncated");
	const s = cm.getCurrentStateOrDefault();
	assert.strictEqual(s.name, "one");
	assert.ok(files().some(f => f.startsWith("state.json.corrupt-")));
	// restored, so a normal load works again
	assert.strictEqual(cm.getCurrentStateOrDefault().name, "one");
});

test("corrupt file without .bak gives defaults and is preserved", () => {
	fs.writeFileSync(path.join(dir, "global.json"), "garbage");
	const g = cm.getGlobalConfigOrDefault();
	assert.strictEqual(g.server.port, 80);
	assert.strictEqual(g.osc.port, 8000);
	assert.ok(files().some(f => f.startsWith("global.json.corrupt-")));
	assert.ok(!files().includes("global.json"));
});

test("load functions never throw and return defaults when missing", () => {
	assert.deepStrictEqual(cm.getPresets(), []);
	assert.deepStrictEqual(cm.getDeviceLocks(), {});
	assert.deepStrictEqual(cm.getChannelLayouts(), {});
	assert.strictEqual(cm.getCurrentStateOrDefault().name, "Default");
	for (const f of ["global.json", "state.json", "presets.json", "devices.json", "layouts.json"]) {
		fs.writeFileSync(path.join(dir, f), "[[[");
	}
	assert.doesNotThrow(() => {
		cm.getGlobalConfigOrDefault();
		cm.getCurrentStateOrDefault();
		cm.getPresets();
		cm.getDeviceLocks();
		cm.getChannelLayouts();
	});
});

test("wrong-typed content is treated as corrupt", () => {
	fs.writeFileSync(path.join(dir, "presets.json"), "{}");
	assert.deepStrictEqual(cm.getPresets(), []);
});

test("save throws on failure and leaves existing file intact", () => {
	cm.saveDeviceLocks({ a: 1 });
	const circular = {};
	circular.self = circular;
	assert.throws(() => cm.saveDeviceLocks(circular));
	assert.deepStrictEqual(cm.getDeviceLocks(), { a: 1 });
	assert.deepStrictEqual(files(), ["devices.json"]);
});

test("presets save/delete round trip", () => {
	const p = cm.saveCurrentStateAsPreset({ auxes: [], channels: [] }, "x");
	assert.strictEqual(cm.getPresetById(p.uuid).name, "x");
	assert.throws(() => cm.saveCurrentStateAsPreset({}, "x"), { code: "PRESET_EXISTS" });
	cm.deletePreset(p.uuid);
	assert.deepStrictEqual(cm.getPresets(), []);
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
	isValidDeviceId,
	deviceIdFromUrl,
	isValidAux,
	isAddressAllowedForAux,
	canSelfUnlock
} = require("../lib/deviceLocks.js");

test("device IDs must be 8-64 url-safe characters", () =>
{
	assert.equal(isValidDeviceId("abcdef12"), true);
	assert.equal(isValidDeviceId("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"), true);
	assert.equal(isValidDeviceId("short"), false);
	assert.equal(isValidDeviceId("has space here"), false);
	assert.equal(isValidDeviceId("../../etc/passwd"), false);
	assert.equal(isValidDeviceId("x".repeat(65)), false);
	assert.equal(isValidDeviceId(undefined), false);
	assert.equal(isValidDeviceId(12345678), false);
});

test("device ID is read from the websocket url query string", () =>
{
	assert.equal(deviceIdFromUrl("/?device=abcdef1234"), "abcdef1234");
	assert.equal(deviceIdFromUrl("/?foo=1&device=abcdef1234"), "abcdef1234");
	assert.equal(deviceIdFromUrl("/"), null);
	assert.equal(deviceIdFromUrl("/?device=bad id"), null);
	assert.equal(deviceIdFromUrl(undefined), null);
});

test("aux numbers must be positive integers", () =>
{
	assert.equal(isValidAux(1), true);
	assert.equal(isValidAux(0), false);
	assert.equal(isValidAux(-2), false);
	assert.equal(isValidAux(1.5), false);
	assert.equal(isValidAux("3"), false);
});

test("locked device may change and query sends on its own aux only", () =>
{
	assert.equal(isAddressAllowedForAux("/Input_Channels/1/Aux_Send/3/send_level", 3), true);
	assert.equal(isAddressAllowedForAux("/Input_Channels/12/Aux_Send/3/send_pan", 3), true);
	assert.equal(isAddressAllowedForAux("/Input_Channels/12/Aux_Send/3/send_level/?", 3), true);

	assert.equal(isAddressAllowedForAux("/Input_Channels/1/Aux_Send/4/send_level", 3), false);
	assert.equal(isAddressAllowedForAux("/Input_Channels/1/Aux_Send/13/send_level", 3), false);
	assert.equal(isAddressAllowedForAux("/Input_Channels/1/Aux_Send/3/send_level/extra", 3), false);
});

test("locked device may move group trims on its own aux only", () =>
{
	assert.equal(isAddressAllowedForAux("/Webmixer/Aux/3/Group/drums_1/level", 3), true);
	assert.equal(isAddressAllowedForAux("/Webmixer/Aux/3/Group/drums_1/level/?", 3), true);
	assert.equal(isAddressAllowedForAux("/Webmixer/Aux/2/Group/drums_1/level", 3), false);
});

test("locked device may not send anything else", () =>
{
	for(const address of [
		"/Input_Channels/1/Channel_Input/name",
		"/Aux_Outputs/3/Buss_Trim/name",
		"/Input_Channels/1/fader",
		"/Console/Session/!",
		"/Snapshots/Recall_Snapshot",
		"",
		undefined
	])
	{
		assert.equal(isAddressAllowedForAux(address, 3), false, String(address));
	}
});

test("self unlock is free without an admin password", () =>
{
	assert.equal(canSelfUnlock(undefined, undefined), true);
	assert.equal(canSelfUnlock("", "anything"), true);
});

test("self unlock requires the admin password when one is set", () =>
{
	assert.equal(canSelfUnlock("s3cret", "s3cret"), true);
	assert.equal(canSelfUnlock("s3cret", "wrong"), false);
	assert.equal(canSelfUnlock("s3cret", ""), false);
	assert.equal(canSelfUnlock("s3cret", undefined), false);
});

test("locked device may switch sends on/off on its own aux only", () =>
{
	assert.equal(isAddressAllowedForAux("/Input_Channels/1/Aux_Send/3/send_on", 3), true);
	assert.equal(isAddressAllowedForAux("/Input_Channels/1/Aux_Send/3/send_on/?", 3), true);
	assert.equal(isAddressAllowedForAux("/Input_Channels/1/Aux_Send/4/send_on", 3), false);
});

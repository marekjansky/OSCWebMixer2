"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
	isSafeAddress,
	parseSendAddress,
	normaliseArgs,
	clampSendValue,
	sanitizeClientMessage,
	sanitizeExternalMessage
} = require("../lib/oscValidation.js");

const LEVEL = "/Input_Channels/3/Aux_Send/2/send_level";
const PAN = "/Input_Channels/3/Aux_Send/2/send_pan";

test("safe addresses", () =>
{
	assert.ok(isSafeAddress(LEVEL));
	assert.ok(isSafeAddress(LEVEL + "/?"));
	assert.ok(isSafeAddress("/Console/Session/!"));
	assert.ok(!isSafeAddress("/Input_Channels/*/Aux_Send/2/send_level"), "OSC wildcard");
	assert.ok(!isSafeAddress("/Input_Channels/{1,2}/x"), "OSC alternatives");
	assert.ok(!isSafeAddress("/a/?/b"), "? only allowed at the end");
	assert.ok(!isSafeAddress("/a b"));
	assert.ok(!isSafeAddress("no-slash"));
	assert.ok(!isSafeAddress("/" + "a".repeat(300)));
	assert.ok(!isSafeAddress(42));
});

test("parseSendAddress", () =>
{
	assert.deepEqual(parseSendAddress(LEVEL), {channel: 3, aux: 2, param: "level", query: false});
	assert.deepEqual(parseSendAddress(PAN + "/?"), {channel: 3, aux: 2, param: "pan", query: true});
	assert.equal(parseSendAddress("/Input_Channels/0/Aux_Send/2/send_level"), null);
	assert.equal(parseSendAddress("/Input_Channels/1000/Aux_Send/2/send_level"), null);
});

test("normaliseArgs rejects non-finite numbers, objects and huge lists", () =>
{
	assert.deepEqual(normaliseArgs(undefined), []);
	assert.deepEqual(normaliseArgs([1, "a", true]), [1, "a", true]);
	assert.equal(normaliseArgs([NaN]), null);
	assert.equal(normaliseArgs([Infinity]), null);
	assert.equal(normaliseArgs([{}]), null);
	assert.equal(normaliseArgs("x"), null);
	assert.equal(normaliseArgs(new Array(17).fill(0)), null);
	assert.equal(normaliseArgs(["x".repeat(300)]), null);
});

test("clampSendValue", () =>
{
	assert.equal(clampSendValue("level", 50), 10);
	assert.equal(clampSendValue("level", -500), -150);
	assert.equal(clampSendValue("level", -6), -6);
	assert.equal(clampSendValue("pan", 2), 1);
	assert.equal(clampSendValue("pan", -1), 0);
	assert.equal(clampSendValue("level", "5"), null);
	assert.equal(clampSendValue("level", NaN), null);
});

test("clients may set aux sends, clamped", () =>
{
	assert.deepEqual(sanitizeClientMessage({address: LEVEL, args: [-6]}), {ok: true, msg: {address: LEVEL, args: [-6]}});
	assert.deepEqual(sanitizeClientMessage({address: LEVEL, args: [99]}).msg.args, [10]);
	assert.deepEqual(sanitizeClientMessage({address: PAN, args: [0.25]}).msg.args, [0.25]);
});

test("clients can't send bad values", () =>
{
	assert.equal(sanitizeClientMessage({address: LEVEL, args: [null]}).ok, false);
	assert.equal(sanitizeClientMessage({address: LEVEL, args: ["-6"]}).ok, false);
	assert.equal(sanitizeClientMessage({address: LEVEL, args: []}).ok, false);
	assert.equal(sanitizeClientMessage({address: LEVEL, args: [1, 2]}).ok, false);
	assert.equal(sanitizeClientMessage({address: LEVEL, args: "x"}).ok, false);
	assert.equal(sanitizeClientMessage(null).ok, false);
});

test("clients can only set aux sends, but may query anything plain", () =>
{
	assert.equal(sanitizeClientMessage({address: "/Console/Session/!", args: []}).ok, false);
	assert.equal(sanitizeClientMessage({address: "/Input_Channels/1/Channel_Input/name", args: ["x"]}).ok, false);
	assert.equal(sanitizeClientMessage({address: "/Input_Channels/1/fader", args: [10]}).ok, false);
	assert.equal(sanitizeClientMessage({address: "/Input_Channels/*/Aux_Send/1/send_level", args: [0]}).ok, false);
	assert.deepEqual(sanitizeClientMessage({address: LEVEL + "/?", args: [1]}), {ok: true, msg: {address: LEVEL + "/?", args: []}});
	assert.equal(sanitizeClientMessage({address: "/Input_Channels/1/Channel_Input/name/?"}).ok, true);
});

test("external devices: any address, but send values are checked", () =>
{
	const other = {address: "/track/1/volume", args: [0.5]};
	assert.equal(sanitizeExternalMessage(other), other);
	assert.deepEqual(sanitizeExternalMessage({address: LEVEL, args: [20]}), {address: LEVEL, args: [10]});
	assert.equal(sanitizeExternalMessage({address: LEVEL, args: [NaN]}), null);
	assert.equal(sanitizeExternalMessage({address: LEVEL, args: ["loud"]}), null);
	assert.deepEqual(sanitizeExternalMessage({address: LEVEL + "/?"}), {address: LEVEL + "/?", args: []});
	assert.equal(sanitizeExternalMessage({}), null);
});

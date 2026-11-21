"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
	nextLoadQuery,
	wantedQueries,
	createQueryPacer,
	channelCount,
	auxCount
} = require("../lib/deskSync.js");

function cacheOf(entries)
{
	return new Map(Object.entries(entries).map(([address, args]) => [address, {address, args}]));
}

test("load order: channel count, aux modes, aux names, channel names, then done", () =>
{
	const cache = new Map();
	assert.equal(nextLoadQuery(cache), "/Console/Channels/?");
	cache.set("/Console/Input_Channels", {args: [2]});
	assert.equal(nextLoadQuery(cache), "/Console/Aux_Outputs/modes/?");
	cache.set("/Console/Aux_Outputs/modes", {args: [1, 2]});
	assert.equal(nextLoadQuery(cache), "/Aux_Outputs/1/Buss_Trim/name/?");
	cache.set("/Aux_Outputs/1/Buss_Trim/name", {args: ["A"]});
	cache.set("/Aux_Outputs/2/Buss_Trim/name", {args: ["B"]});
	assert.equal(nextLoadQuery(cache), "/Input_Channels/1/Channel_Input/name/?");
	cache.set("/Input_Channels/1/Channel_Input/name", {args: ["Kick"]});
	assert.equal(nextLoadQuery(cache), "/Input_Channels/2/Channel_Input/name/?");
	cache.set("/Input_Channels/2/Channel_Input/name", {args: ["Snare"]});
	assert.equal(nextLoadQuery(cache), null);
});

test("the same pending query is returned until it is answered (so a retry timer can resend it)", () =>
{
	const cache = cacheOf({"/Console/Input_Channels": [1]});
	assert.equal(nextLoadQuery(cache), nextLoadQuery(cache));
});

test("counts are bounded and tolerate junk", () =>
{
	assert.equal(channelCount(cacheOf({"/Console/Input_Channels": [5000]})), 999);
	assert.equal(channelCount(cacheOf({"/Console/Input_Channels": ["x"]})), 0);
	assert.equal(channelCount(new Map()), 0);
	assert.equal(auxCount(cacheOf({"/Console/Aux_Outputs/modes": [1, 1, 2]})), 3);
});

test("wantedQueries: names first, then enabled sends only, within the desk's counts", () =>
{
	const cache = cacheOf({
		"/Console/Input_Channels": [3],
		"/Console/Aux_Outputs/modes": [1, 1],
		"/Aux_Outputs/1/Buss_Trim/name": ["A"],
		"/Input_Channels/1/Channel_Input/name": ["Kick"],
		"/Input_Channels/2/Channel_Input/name": ["Snare"],
		"/Input_Channels/1/Aux_Send/1/send_level": [-10]
	});
	const wanted = wantedQueries(cache, {
		channelEnabled: channel => channel !== 2,
		auxEnabled: aux => aux === 1
	});
	assert.deepEqual(wanted, [
		"/Aux_Outputs/2/Buss_Trim/name/?",
		"/Input_Channels/3/Channel_Input/name/?",
		"/Input_Channels/1/Aux_Send/1/send_pan/?",
		"/Input_Channels/1/Aux_Send/1/send_on/?",
		"/Input_Channels/3/Aux_Send/1/send_level/?",
		"/Input_Channels/3/Aux_Send/1/send_pan/?",
		"/Input_Channels/3/Aux_Send/1/send_on/?"
	]);
});

test("wantedQueries: stale cached values are re-requested", () =>
{
	const cache = cacheOf({
		"/Console/Input_Channels": [1],
		"/Console/Aux_Outputs/modes": [1],
		"/Aux_Outputs/1/Buss_Trim/name": ["A"],
		"/Input_Channels/1/Channel_Input/name": ["Kick"],
		"/Input_Channels/1/Aux_Send/1/send_level": [-10],
		"/Input_Channels/1/Aux_Send/1/send_pan": [0.5],
		"/Input_Channels/1/Aux_Send/1/send_on": [1]
	});
	const enabled = {channelEnabled: () => true, auxEnabled: () => true};
	assert.deepEqual(wantedQueries(cache, enabled), []);
	const stale = new Set(["/Console/Input_Channels", "/Input_Channels/1/Aux_Send/1/send_level"]);
	assert.deepEqual(wantedQueries(cache, {...enabled, stale}), [
		"/Console/Channels/?",
		"/Input_Channels/1/Aux_Send/1/send_level/?"
	]);
});

test("pacer sends a few per tick, retries, and gives up", () =>
{
	let time = 0;
	const pacer = createQueryPacer({perTick: 2, retryMs: 100, maxAttempts: 2, now: () => time});
	const wanted = ["a", "b", "c"];

	assert.deepEqual(pacer.pick(wanted), {send: ["a", "b"], done: false});
	time += 10;
	assert.deepEqual(pacer.pick(wanted), {send: ["c"], done: false}, "a and b wait for their retry time");
	time += 100;
	assert.deepEqual(pacer.pick(wanted), {send: ["a", "b"], done: false});
	time += 10;
	assert.deepEqual(pacer.pick(wanted), {send: ["c"], done: false});
	time += 100;
	assert.deepEqual(pacer.pick(wanted), {send: [], done: true}, "every query tried twice");
	assert.ok(pacer.gaveUp("a"));

	pacer.forget("a");
	assert.deepEqual(pacer.pick(wanted), {send: ["a"], done: false});
	pacer.reset();
	assert.ok(!pacer.gaveUp("b"));
});

test("pacer is done when nothing is wanted", () =>
{
	const pacer = createQueryPacer();
	assert.deepEqual(pacer.pick([]), {send: [], done: true});
});

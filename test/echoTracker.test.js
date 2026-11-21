"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createEchoTracker, argsMatch } = require("../lib/echoTracker.js");

function clock(start = 1000)
{
	let time = start;
	return { now: () => time, advance: ms => { time += ms; } };
}

const LEVEL = "/Input_Channels/1/Aux_Send/2/send_level";

test("a value sent to the desk and echoed back is recognised once", () =>
{
	const c = clock();
	const echoes = createEchoTracker({ now: c.now });
	echoes.record(LEVEL, [-10]);
	assert.equal(echoes.isEcho(LEVEL, [-10]), true);
	assert.equal(echoes.isEcho(LEVEL, [-10]), false, "consumed");
});

test("an older echo arriving after a newer value was sent is still an echo (no fader jump back)", () =>
{
	const c = clock();
	const echoes = createEchoTracker({ now: c.now });
	echoes.record(LEVEL, [-10]);
	echoes.record(LEVEL, [-11]);
	echoes.record(LEVEL, [-12]);
	assert.equal(echoes.isEcho(LEVEL, [-10]), true);
	assert.equal(echoes.isEcho(LEVEL, [-11]), true);
	assert.equal(echoes.isEcho(LEVEL, [-12]), true);
	assert.equal(echoes.hasPending(LEVEL), false);
});

test("a lost echo is skipped: a later match consumes everything before it", () =>
{
	const c = clock();
	const echoes = createEchoTracker({ now: c.now });
	echoes.record(LEVEL, [-10]);
	echoes.record(LEVEL, [-11]);
	assert.equal(echoes.isEcho(LEVEL, [-11]), true);
	assert.equal(echoes.isEcho(LEVEL, [-10]), false);
});

test("a different value from the desk is not an echo (desk clamped it, or the engineer moved it)", () =>
{
	const c = clock();
	const echoes = createEchoTracker({ now: c.now });
	echoes.record(LEVEL, [-10]);
	assert.equal(echoes.isEcho(LEVEL, [-20]), false);
	assert.equal(echoes.isEcho("/Input_Channels/1/Aux_Send/3/send_level", [-10]), false);
});

test("echoes expire after the window", () =>
{
	const c = clock();
	const echoes = createEchoTracker({ now: c.now, windowMs: 1000 });
	echoes.record(LEVEL, [-10]);
	c.advance(1001);
	assert.equal(echoes.isEcho(LEVEL, [-10]), false);
	assert.equal(echoes.size, 0);
});

test("float rounding by the desk is tolerated", () =>
{
	const c = clock();
	const echoes = createEchoTracker({ now: c.now });
	echoes.record(LEVEL, [-10.25]);
	assert.equal(echoes.isEcho(LEVEL, [-10.2500001]), true);
});

test("queries are never recorded", () =>
{
	const echoes = createEchoTracker();
	echoes.record(LEVEL + "/?", []);
	assert.equal(echoes.size, 0);
});

test("clear forgets everything", () =>
{
	const echoes = createEchoTracker();
	echoes.record(LEVEL, [1]);
	echoes.clear();
	assert.equal(echoes.isEcho(LEVEL, [1]), false);
});

test("argsMatch", () =>
{
	assert.ok(argsMatch(["a", 1], ["a", 1.001], 0.01));
	assert.ok(!argsMatch(["a"], ["b"], 0.01));
	assert.ok(!argsMatch([1], [1, 2], 0.01));
	assert.ok(!argsMatch([NaN], [NaN], 0.01));
	assert.ok(!argsMatch(undefined, [], 0.01));
});

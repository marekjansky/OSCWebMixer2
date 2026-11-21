"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
	nameStatus,
	isChanged,
	effectiveAuxColour,
	lockState,
	identityChanges,
	confirmSlot
} = require("../lib/identity.js");
const { colourForName } = require("../lib/colour.js");

test("nameStatus", () =>
{
	assert.equal(nameStatus(undefined, undefined), "unknown");
	assert.equal(nameStatus("Bob", undefined), "unknown");
	assert.equal(nameStatus(undefined, "Bob"), "first");
	assert.equal(nameStatus("", "Bob"), "first");
	assert.equal(nameStatus("Bob", "Bob"), "same");
	assert.equal(nameStatus("bob ", "BOB"), "same", "spelling/case changes are the same musician");
	assert.equal(nameStatus("Bob", "Alice"), "changed");
	assert.equal(nameStatus("Bob", ""), "changed", "a cleared name is a change");
	assert.ok(isChanged("Bob", "Alice"));
	assert.ok(!isChanged(undefined, "Alice"));
});

test("unset colour follows the desk name", () =>
{
	assert.equal(effectiveAuxColour(undefined, "Alice", 0, 8), colourForName("Alice"));
	assert.equal(effectiveAuxColour({colour: ""}, "Alice", 0, 8), colourForName("Alice"));
	assert.equal(effectiveAuxColour({}, "", 2, 8), colourForName("", 2, 8));
});

test("a colour that was the old name's automatic colour follows the new name", () =>
{
	const slot = {colour: colourForName("Bob").toUpperCase(), name: "Bob"};
	assert.equal(effectiveAuxColour(slot, "Alice", 0, 8), colourForName("Alice"));
	assert.equal(effectiveAuxColour(slot, "Bob", 0, 8), slot.colour, "unchanged name keeps it");
});

test("a custom colour stays on a renamed slot until confirmed", () =>
{
	const slot = {colour: "#123456", name: "Bob"};
	assert.equal(effectiveAuxColour(slot, "Alice", 0, 8), "#123456");
});

test("lockState", () =>
{
	assert.deepEqual(lockState({aux: 1, auxName: "Bob"}, "Bob"), {suspended: false, auxName: "Bob"});
	assert.deepEqual(lockState({aux: 1, auxName: "Bob"}, "Alice"), {suspended: true, auxName: "Alice"});
	assert.deepEqual(lockState({aux: 1}, "Alice"), {suspended: false, auxName: "Alice"}, "legacy lock without a name");
	assert.deepEqual(lockState({aux: 9, auxName: "Bob"}, undefined), {suspended: true, auxName: ""}, "aux gone from the desk");
});

test("identityChanges lists changed auxes and channels, and auxes with mismatched locks", () =>
{
	const auxNames = ["Bob", "Carol", "Dave"];
	const channelNames = ["Kick", "Snare"];
	const changes = identityChanges({
		auxCount: 3,
		channelCount: 2,
		auxName: aux => auxNames[aux - 1],
		channelName: channel => channelNames[channel - 1],
		state: {
			auxes: [{name: "Bob"}, {name: "Eve"}, {name: "Dave"}],
			channels: [{name: "Kick"}, {name: "Tom"}]
		},
		locks: {
			dev1: {aux: 3, auxName: "Frank"}, //state says Dave (e.g. preset loaded) but lock was made for Frank
			dev2: {aux: 1, auxName: "Bob"}
		}
	});
	assert.deepEqual(changes, [
		{type: "aux", number: 2, previousName: "Eve", currentName: "Carol"},
		{type: "aux", number: 3, previousName: "Frank", currentName: "Dave"},
		{type: "channel", number: 2, previousName: "Tom", currentName: "Snare"}
	]);
});

test("identityChanges ignores slots seen for the first time", () =>
{
	const changes = identityChanges({
		auxCount: 1, channelCount: 1,
		auxName: () => "Bob", channelName: () => "Kick",
		state: {auxes: [], channels: [{enabled: true}]}
	});
	assert.deepEqual(changes, []);
});

test("confirmSlot keeping settings", () =>
{
	const slot = {enabled: false, colour: "#123456", icon: "guitar", name: "Bob"};
	assert.deepEqual(confirmSlot("aux", slot, "Alice", true, 0, 4), {enabled: false, colour: "#123456", icon: "guitar", name: "Alice"});

	const auto = {enabled: true, colour: colourForName("Bob"), icon: "", name: "Bob"};
	assert.equal(confirmSlot("aux", auto, "Alice", true, 0, 4).colour, "", "automatic colour keeps following the name");

	const channel = {enabled: true, displayOrder: 4, title: "Drums", icon: "kick", group: "drums", name: "Kick"};
	assert.deepEqual(confirmSlot("channel", channel, "Bass", true, 0, 4), {...channel, name: "Bass"});
});

test("confirmSlot resetting settings", () =>
{
	const slot = {enabled: false, colour: "#123456", icon: "guitar", name: "Bob"};
	assert.deepEqual(confirmSlot("aux", slot, "Alice", false, 0, 4), {enabled: false, colour: "", icon: "", name: "Alice"});

	const channel = {enabled: true, displayOrder: 4, title: "Drums", icon: "kick", group: "drums", name: "Kick"};
	assert.deepEqual(confirmSlot("channel", channel, "Bass", false, 0, 4), {enabled: true, title: "", icon: "", group: "", name: "Bass", displayOrder: 4});

	assert.deepEqual(confirmSlot("aux", undefined, "New", false, 0, 4), {enabled: true, colour: "", icon: "", name: "New"});
});

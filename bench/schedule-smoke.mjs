#!/usr/bin/env node
import assert from "node:assert/strict";
import { rotatedArmOrder } from "./schedule.mjs";

const two = ["baseline", "full"];
assert.deepEqual(rotatedArmOrder(two, 1), ["baseline", "full"]);
assert.deepEqual(rotatedArmOrder(two, 2), ["full", "baseline"]);
assert.deepEqual(rotatedArmOrder(two, 3), ["baseline", "full"]);

const three = ["a", "b", "c"];
assert.deepEqual(rotatedArmOrder(three, 1), ["a", "b", "c"]);
assert.deepEqual(rotatedArmOrder(three, 2), ["b", "c", "a"]);
assert.deepEqual(rotatedArmOrder(three, 3), ["c", "a", "b"]);
assert.deepEqual(rotatedArmOrder(three, 1, 1), ["b", "c", "a"]);

console.log("schedule rotation smoke passed");

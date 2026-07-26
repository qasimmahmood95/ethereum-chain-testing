// Core library surface: pure logic only. The viem adapter lives in
// src/rpc/ and is imported directly so consumers of the core never
// pull in a node dependency.
export * from './types.js';
export * from './watcher.js';

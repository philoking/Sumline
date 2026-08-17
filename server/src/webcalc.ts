#!/usr/bin/env node
/**
 * The `webcalc` command.
 *
 * Nothing but the entry point: everything it does lives in `cli.ts`, which
 * exports rather than runs so the argument parsing and the rendering can be
 * tested without spawning a process.
 */
import { main } from './cli.js';

process.exitCode = await main(process.argv.slice(2));

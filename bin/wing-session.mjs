#!/usr/bin/env node
import { runCli } from '../skills/wing-session-analyzer/scripts/wing-session.mjs';
process.exitCode = await runCli();

#!/usr/bin/env node
import { runPackCli } from '../skills/wing-session-analyzer/scripts/wing-session-pack.mjs';
process.exitCode = await runPackCli();

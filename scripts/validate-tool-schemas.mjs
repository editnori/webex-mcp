#!/usr/bin/env bun

import {TOOLS, validatePublishedToolSchemas} from '../server.mjs';

const tools = validatePublishedToolSchemas(TOOLS);

console.log(`Validated ${tools.length} published tool schemas for MCP client compatibility.`);

#!/usr/bin/env node
import { create } from "./main.js";

process.exitCode = await create(process.argv.slice(2));

#!/usr/bin/env node
import { filterSqliteExperimentalWarning } from "../ports/index.js";
import { runCli } from "./index.js";

filterSqliteExperimentalWarning();
process.exitCode = await runCli(process.argv.slice(2));

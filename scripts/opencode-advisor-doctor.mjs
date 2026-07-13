#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { main } from "../src/doctor.mjs";

export { findPayloadLeaks, formatDoctorJsonReport, formatDoctorReport, runDoctor } from "../src/doctor.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

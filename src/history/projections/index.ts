import type { HistoryProjectionDefinition } from "../index.js";

export { openUsageReads } from "./usage/index.js";
export type { DeviceFactRow, RequestRow } from "./usage/index.js";

export const HISTORY_PROJECTIONS: Readonly<Record<string, HistoryProjectionDefinition>> = {};

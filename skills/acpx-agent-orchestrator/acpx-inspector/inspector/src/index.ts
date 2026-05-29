export { sessionsView } from "./projections/sessions.js";
export { snapshot } from "./projections/snapshot.js";
export { historyView } from "./projections/history.js";
export { diagnose } from "./projections/diagnose.js";
export {
  followFlow,
  followSession,
  formatFollowTickText,
  parseDurationMs,
} from "./projections/follow.js";

// Advanced/internal exports are kept for existing users and tests. They are not
// part of the recommended Agent Core surface.
export { snapshotForRecord, classifyStatus } from "./projections/snapshot.js";
export { suggestActions } from "./projections/actions.js";
export {
  sampleFlow,
  sampleSession,
} from "./projections/follow.js";
export { readSessionEvents } from "./core/event-stream.js";
export { resolveSession } from "./core/resolver.js";
export { listSessionRecords, parseSessionRecord } from "./core/session-record.js";
export { sessionReportModel, oneshotReportModel, flowReportModel } from "./html-report/model.js";
export { renderReportHtml } from "./html-report/render.js";
export { writeReport } from "./html-report/write.js";
export type * from "./types.js";

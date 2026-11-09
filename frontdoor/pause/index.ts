/**
 * Pause (P2-05; C3 req 5 and 6, D15, D16). See README.md in this folder.
 * Framework-free: every piece takes the database (frontdoor/db) as an argument.
 */
export { costTowardLimits, createCostWatch, lastUnpause, WINDOW_DAYS, type AlertEvent, type AlertListener, type CheckResult, type CostTowardLimits, type CostWatch } from "./limits.ts";
export { createPauseControls, type PauseControls } from "./controls.ts";
export { interstitialDecision, interstitialPage, isPageLoad, READ_PATH, readRedirect, type ScreenAction, type ScreenContent } from "./interstitial.ts";
export { DEFAULT_STUDENT_NAME, standInStudentName, type StudentNameLookup } from "./student-name.ts";

/**
 * The source library and the Owner's upload page (P5-01, C4, PD6).
 * Framework-free. The dashboard's HTTP routes are in frontdoor/admin.
 */
export {
	AREA_LABELS,
	checkRelativePath,
	cleanAircraft,
	cleanFileName,
	contentMatchesName,
	isLibraryArea,
	LIBRARY_AREAS,
	LIBRARY_EXTENSIONS,
	LIBRARY_MAX_BYTES,
	targetFolder,
	type LibraryArea,
} from "./rules.ts";
export { LibraryError, listLibrary, removeLibraryFile, saveLibraryFile, type LibraryFile, type SaveOptions } from "./store.ts";

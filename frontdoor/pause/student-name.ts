/**
 * The student's name for the study record (C6 req 1: the header carries the
 * name from the login). w2-dashboard is building a cached Clerk name lookup
 * in frontdoor/admin; at merge the master points data-safety's studentName
 * at that one shared helper (master decision, 2026-11-08). Until then the
 * stand-in answers null and the record says DEFAULT_STUDENT_NAME.
 */
export type StudentNameLookup = (clerkUserId: string) => Promise<string | null>;

export const DEFAULT_STUDENT_NAME = "Student";

export const standInStudentName: StudentNameLookup = async () => null;

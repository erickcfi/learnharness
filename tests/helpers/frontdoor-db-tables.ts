/**
 * The tutor's tables, written out by hand so the tests check the migrations
 * against an independent list. A new table must be added here, which makes
 * the RLS tests cover it too.
 */
export const EXPECTED_TABLES = [
	"account_roles",
	"accounts",
	"alerts",
	"consents",
	"course_leg_starts",
	"invoices",
	"model_usage",
	"owner_settings",
	"pauses",
	"report_sends",
	"report_settings",
	"search_usage",
	"stripe_events",
	"study_time",
	"subscriptions",
	"tenants",
	"topic_labels",
	"trial_claims",
];

/** Tables whose rows belong to no tenant. Everything else carries tenant_id (or is tenants). */
export const NON_TENANT_TABLES = ["accounts", "account_roles", "owner_settings", "stripe_events", "trial_claims"];

/**
 * Billing (W2-8, PRD C2): Stripe Checkout with the trial, the trial gate,
 * Buy now, the customer portal, webhooks, coupons, and the billing emails.
 * See billing/README.md.
 */
export { type Access, accessFor, AccessCache } from "./access.ts";
export { billingState, buyNow, openPortal, removeTesterDiscount, startCheckout } from "./actions.ts";
export { COUPONS, PriceBook, priceSpecs } from "./catalog.ts";
export { clerkEmailLookup, type EmailLookup } from "./clerk-email.ts";
export {
	assertBillingEnv,
	billingEnvProblems,
	billingOff,
	BILLING_PREFIX,
	type BillingConfig,
	loadBillingConfig,
	PLANS_PATH,
	PRODUCT_ID,
	STUDENT_COUPON_ID,
	TESTER_COUPON_ID,
	WEBHOOK_PATH,
} from "./config.ts";
export { type BillingCore, createBillingCore, siteUrlFrom } from "./core.ts";
export { type BillingGatewayHook, type BillingRequestContext, createBillingHook, createBillingOffHook, isTurnRequest } from "./gateway-hook.ts";
export { databaseRetention, type EmailMessage, type EmailSender, RecordingEmailSender, type RetentionHooks } from "./hooks.ts";
export { couponKind, type TenantBilling, tenantBilling, trialConversion } from "./reporting.ts";
export { createStripeClient, type StripeApi } from "./stripe-api.ts";
export type { BillingStatus, BillingView, BillingViewOn } from "./view.ts";
export { receiveWebhook } from "./webhook.ts";

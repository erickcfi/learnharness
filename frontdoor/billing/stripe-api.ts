/**
 * The parts of Stripe's API the front door uses (W2-8, PRD C2).
 *
 * The real client is the official `stripe` package (createStripeClient). The
 * tests use a stand-in with the same shape (billing/testing.ts), so no test
 * ever calls Stripe. The parameter and result types are the SDK's own, so
 * `npm run typecheck` checks every call against Stripe's API version
 * (2026-10-28.endive for stripe 23.1.0).
 */
import Stripe from "stripe";

type List<T> = Promise<Stripe.ApiList<T>>;

export interface StripeApi {
	products: {
		retrieve(id: string): Promise<Stripe.Product>;
		create(params: Stripe.ProductCreateParams): Promise<Stripe.Product>;
		update(id: string, params: Stripe.ProductUpdateParams): Promise<Stripe.Product>;
	};
	prices: {
		list(params: Stripe.PriceListParams): List<Stripe.Price>;
		create(params: Stripe.PriceCreateParams): Promise<Stripe.Price>;
		update(id: string, params: Stripe.PriceUpdateParams): Promise<Stripe.Price>;
	};
	coupons: {
		retrieve(id: string): Promise<Stripe.Coupon>;
		create(params: Stripe.CouponCreateParams): Promise<Stripe.Coupon>;
		update(id: string, params: Stripe.CouponUpdateParams): Promise<Stripe.Coupon>;
	};
	promotionCodes: {
		list(params: Stripe.PromotionCodeListParams): List<Stripe.PromotionCode>;
		create(params: Stripe.PromotionCodeCreateParams): Promise<Stripe.PromotionCode>;
	};
	customers: {
		create(params: Stripe.CustomerCreateParams): Promise<Stripe.Customer>;
	};
	checkout: {
		sessions: {
			create(params: Stripe.Checkout.SessionCreateParams): Promise<Stripe.Checkout.Session>;
			retrieve(id: string, params?: Stripe.Checkout.SessionRetrieveParams): Promise<Stripe.Checkout.Session>;
		};
	};
	subscriptions: {
		retrieve(id: string, params?: Stripe.SubscriptionRetrieveParams): Promise<Stripe.Subscription>;
		update(id: string, params: Stripe.SubscriptionUpdateParams): Promise<Stripe.Subscription>;
		cancel(id: string, params?: Stripe.SubscriptionCancelParams): Promise<Stripe.Subscription>;
		deleteDiscount(id: string): Promise<Stripe.DeletedDiscount>;
	};
	invoices: {
		retrieve(id: string, params?: Stripe.InvoiceRetrieveParams): Promise<Stripe.Invoice>;
	};
	paymentMethods: {
		retrieve(id: string): Promise<Stripe.PaymentMethod>;
		/** A customer's saved cards, newest first. */
		list(params: Stripe.PaymentMethodListParams): List<Stripe.PaymentMethod>;
	};
	billingPortal: {
		sessions: {
			create(params: Stripe.BillingPortal.SessionCreateParams): Promise<Stripe.BillingPortal.Session>;
		};
	};
	webhooks: {
		/** Checks Stripe's signature header and returns the event, or throws. */
		constructEvent(payload: string | Buffer, header: string, secret: string): Stripe.Event;
	};
}

/** The official client, for the key in STRIPE_SECRET_KEY. */
export function createStripeClient(secretKey: string): StripeApi {
	return new Stripe(secretKey, {
		// Retries on network errors and 409s use an idempotency key (Stripe docs, "Idempotent requests").
		maxNetworkRetries: 2,
		timeout: 20_000,
		appInfo: { name: "north-aero-ground-tutor", url: "https://github.com/erickcfi/learnharness" },
	});
}

/** Stripe's "No such ..." answer (HTTP 404, code resource_missing). */
export function isMissing(error: unknown): boolean {
	const e = error as { statusCode?: number; code?: string } | null;
	return e?.statusCode === 404 || e?.code === "resource_missing";
}

/** A card the bank refused, or one that needs the student's action. */
export function isCardError(error: unknown): boolean {
	return (error as { type?: string } | null)?.type === "StripeCardError";
}

/** An id, or the id of an expanded object. */
export function idOf(value: string | { id: string } | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	return typeof value === "string" ? value : value.id;
}

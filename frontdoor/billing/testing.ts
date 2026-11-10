/**
 * A stand-in for Stripe's API, for tests only (W2-8). No test calls Stripe.
 *
 * It holds products, prices, coupons, promotion codes, customers, cards,
 * Checkout Sessions, subscriptions and invoices in memory, and follows the
 * Stripe rules the front door relies on (checked against Stripe's docs,
 * 2026-11-08; billing/README.md lists them):
 *  - Checkout in subscription mode collects a card unless
 *    payment_method_collection is "if_required"; with
 *    consent_collection.terms_of_service "required" the student must tick the terms.
 *  - A coupon or promotion code past max_redemptions is refused.
 *  - trial_end "now" ends the trial and charges at once; with
 *    payment_behavior "pending_if_incomplete" a refused card changes nothing.
 *  - At trial end and at each period end Stripe invoices the price, less the discount.
 *  - Cancel at period end keeps the subscription until the period ends, then deletes it.
 *  - Webhook events carry ids for expandable fields (discounts,
 *    default_payment_method) and are signed with Stripe's own scheme
 *    (the real SDK's generateTestHeaderString / constructEvent).
 *
 * Time is the stand-in's own clock: advanceTo() moves it and runs trial
 * ends, renewals and cancellations in order, like a Stripe test clock.
 */
import Stripe from "stripe";
import type { StripeApi } from "./stripe-api.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const API_VERSION = "2026-10-28.endive";

export class StandInStripeError extends Error {
	type: string;
	code: string | undefined;
	statusCode: number;
	constructor(message: string, opts: { type?: string; code?: string; statusCode?: number } = {}) {
		super(message);
		this.type = opts.type ?? "StripeInvalidRequestError";
		this.code = opts.code;
		this.statusCode = opts.statusCode ?? 400;
	}
}

const missing = (what: string, id: string) => new StandInStripeError(`No such ${what}: '${id}'`, { code: "resource_missing", statusCode: 404 });

export interface TestCard {
	/** Stripe's card fingerprint: the same card number gives the same fingerprint. */
	fingerprint: string;
	last4: string;
	brand: string;
	/** Every charge on it is refused (like Stripe's 4000 0000 0000 0002). */
	declines?: boolean;
}

export const TEST_CARDS = {
	visa: { fingerprint: "fpVisa4242standin", last4: "4242", brand: "visa" },
	mastercard: { fingerprint: "fpMc4444standin", last4: "4444", brand: "mastercard" },
	amex: { fingerprint: "fpAmex8431standin", last4: "8431", brand: "amex" },
	discover: { fingerprint: "fpDisc1117standin", last4: "1117", brand: "discover" },
	declined: { fingerprint: "fpDecline0002standin", last4: "0002", brand: "visa", declines: true },
} satisfies Record<string, TestCard>;

interface PriceRec {
	id: string;
	product: string;
	currency: string;
	unit_amount: number;
	recurring: { interval: "day" | "week" | "month" | "year"; interval_count: number };
	lookup_key: string | null;
	active: boolean;
	nickname: string | null;
	metadata: Record<string, string>;
}
interface CouponRec {
	id: string;
	name: string | null;
	percent_off: number;
	duration: string;
	max_redemptions: number | null;
	times_redeemed: number;
	applies_to: { products: string[] } | undefined;
	metadata: Record<string, string>;
}
interface PromoRec {
	id: string;
	code: string;
	coupon: string;
	active: boolean;
	max_redemptions: number | null;
	times_redeemed: number;
	first_time_transaction: boolean;
}
interface CustomerRec {
	id: string;
	email: string | null;
	metadata: Record<string, string>;
}
interface PaymentMethodRec {
	id: string;
	customer: string;
	card: TestCard;
}
interface SessionRec {
	id: string;
	params: Stripe.Checkout.SessionCreateParams;
	status: "open" | "complete" | "expired";
	customer: string | null;
	subscription: string | null;
	termsAccepted: boolean;
	email: string | null;
	created: number;
}
interface DiscountRec {
	id: string;
	coupon: string;
	promotionCode: string | null;
	start: number;
}
interface SubRec {
	id: string;
	customer: string;
	status: Stripe.Subscription.Status;
	itemId: string;
	price: string;
	created: number;
	trialStart: number | null;
	trialEnd: number | null;
	periodStart: number;
	periodEnd: number;
	cancelAtPeriodEnd: boolean;
	/** When a scheduled cancellation takes effect. Flexible billing mode shows only this (cancel_at_period_end stays false). */
	cancelAt: number | null;
	canceledAt: number | null;
	endedAt: number | null;
	discount: DiscountRec | null;
	paymentMethod: string | null;
	/** Whether the subscription shows the card as default_payment_method (else only the customer has it). */
	showsDefaultPaymentMethod: boolean;
	latestInvoice: string | null;
	metadata: Record<string, string>;
	upcomingSentFor: number | null;
}
interface InvoiceRec {
	id: string;
	customer: string;
	subscription: string;
	status: "draft" | "open" | "paid" | "void";
	billing_reason: Stripe.Invoice.BillingReason;
	amount_due: number;
	amount_paid: number;
	currency: string;
	created: number;
	period_start: number;
	period_end: number;
	paid_at: number | null;
	price: string;
	discount: DiscountRec | null;
}

export interface StandInOptions {
	webhookSecret: string;
	/** Start time, ms. Default 2026-11-09T15:00:00Z. */
	now?: number;
	/** When set, invoice.upcoming is sent this many days before each renewal (Stripe's "Upcoming renewal events" setting). */
	upcomingRenewalDays?: number;
	/**
	 * Whether Checkout sets the subscription's default_payment_method. Stripe's
	 * docs don't say (2026-11-08), so the front door also looks at the
	 * customer's saved cards; tests run both ways. Default true.
	 */
	checkoutSetsDefaultPaymentMethod?: boolean;
}

export interface CheckoutCompletion {
	/** No card: Checkout cannot finish unless the session lets it skip the card. */
	card?: TestCard;
	promotionCode?: string;
	/** The terms-of-service box at Checkout. Default true. */
	acceptTerms?: boolean;
}

export interface StandInCall {
	method: string;
	id?: string;
	params?: unknown;
}

export class StripeStandIn implements StripeApi {
	readonly webhookSecret: string;
	readonly upcomingRenewalDays: number | undefined;
	readonly checkoutSetsDefaultPaymentMethod: boolean;
	/** Every API call, in order, for assertions. */
	readonly calls: StandInCall[] = [];
	/** Events not yet delivered. */
	pending: Stripe.Event[] = [];
	readonly delivered: Stripe.Event[] = [];
	readonly portalSessions: Stripe.BillingPortal.Session[] = [];

	#clock: number;
	#seq = 0;
	#signer = new Stripe("sk_test_standin_never_used_for_calls");
	#products = new Map<string, Stripe.Product>();
	#prices = new Map<string, PriceRec>();
	#coupons = new Map<string, CouponRec>();
	#promos = new Map<string, PromoRec>();
	#customers = new Map<string, CustomerRec>();
	#paymentMethods = new Map<string, PaymentMethodRec>();
	#sessions = new Map<string, SessionRec>();
	#subs = new Map<string, SubRec>();
	#invoices = new Map<string, InvoiceRec>();

	constructor(options: StandInOptions) {
		this.webhookSecret = options.webhookSecret;
		this.upcomingRenewalDays = options.upcomingRenewalDays;
		this.checkoutSetsDefaultPaymentMethod = options.checkoutSetsDefaultPaymentMethod ?? true;
		this.#clock = options.now ?? Date.parse("2026-11-09T15:00:00Z");
	}

	// ---- clock ----

	now(): number {
		return this.#clock;
	}
	#sec(): number {
		return Math.floor(this.#clock / 1000);
	}
	#id(prefix: string): string {
		this.#seq += 1;
		return `${prefix}_standin${this.#seq}`;
	}

	// ---- the API (StripeApi) ----

	products = {
		retrieve: async (id: string): Promise<Stripe.Product> => {
			this.calls.push({ method: "products.retrieve", id });
			const p = this.#products.get(id);
			if (!p) throw missing("product", id);
			return clone(p);
		},
		create: async (params: Stripe.ProductCreateParams): Promise<Stripe.Product> => {
			this.calls.push({ method: "products.create", params });
			const id = params.id ?? this.#id("prod");
			if (this.#products.has(id)) throw new StandInStripeError(`Product already exists: ${id}`, { code: "resource_already_exists" });
			const p = { id, object: "product", name: params.name, active: params.active ?? true, metadata: { ...(params.metadata as Record<string, string>) } } as unknown as Stripe.Product;
			this.#products.set(id, p);
			return clone(p);
		},
		update: async (id: string, params: Stripe.ProductUpdateParams): Promise<Stripe.Product> => {
			this.calls.push({ method: "products.update", id, params });
			const p = this.#products.get(id);
			if (!p) throw missing("product", id);
			if (params.name !== undefined) p.name = params.name;
			if (params.active !== undefined) p.active = params.active;
			return clone(p);
		},
	};

	prices = {
		list: async (params: Stripe.PriceListParams): Promise<Stripe.ApiList<Stripe.Price>> => {
			this.calls.push({ method: "prices.list", params });
			let all = [...this.#prices.values()];
			if (params.lookup_keys) all = all.filter((p) => p.lookup_key !== null && params.lookup_keys?.includes(p.lookup_key));
			if (params.active !== undefined) all = all.filter((p) => p.active === params.active);
			return list(all.slice(0, params.limit ?? 10).map((p) => this.#priceObject(p)));
		},
		create: async (params: Stripe.PriceCreateParams): Promise<Stripe.Price> => {
			this.calls.push({ method: "prices.create", params });
			if (!params.product || !this.#products.has(params.product)) throw missing("product", String(params.product));
			if (!params.recurring) throw new StandInStripeError("The stand-in only models recurring prices.");
			if (params.lookup_key) {
				const holder = [...this.#prices.values()].find((p) => p.lookup_key === params.lookup_key);
				if (holder && !params.transfer_lookup_key) throw new StandInStripeError(`A price (\`${holder.id}\`) already uses that lookup key.`);
				if (holder) holder.lookup_key = null;
			}
			const rec: PriceRec = {
				id: this.#id("price"),
				product: params.product,
				currency: params.currency,
				unit_amount: params.unit_amount ?? 0,
				recurring: { interval: params.recurring.interval as PriceRec["recurring"]["interval"], interval_count: params.recurring.interval_count ?? 1 },
				lookup_key: params.lookup_key ?? null,
				active: params.active ?? true,
				nickname: params.nickname ?? null,
				metadata: { ...(params.metadata as Record<string, string>) },
			};
			this.#prices.set(rec.id, rec);
			return this.#priceObject(rec);
		},
		update: async (id: string, params: Stripe.PriceUpdateParams): Promise<Stripe.Price> => {
			this.calls.push({ method: "prices.update", id, params });
			const p = this.#prices.get(id);
			if (!p) throw missing("price", id);
			if (params.active !== undefined) p.active = params.active;
			return this.#priceObject(p);
		},
	};

	coupons = {
		retrieve: async (id: string): Promise<Stripe.Coupon> => {
			this.calls.push({ method: "coupons.retrieve", id });
			const c = this.#coupons.get(id);
			if (!c) throw missing("coupon", id);
			return this.#couponObject(c);
		},
		create: async (params: Stripe.CouponCreateParams): Promise<Stripe.Coupon> => {
			this.calls.push({ method: "coupons.create", params });
			const id = params.id ?? this.#id("coupon");
			if (this.#coupons.has(id)) throw new StandInStripeError(`Coupon already exists: ${id}`, { code: "resource_already_exists" });
			if (typeof params.percent_off !== "number") throw new StandInStripeError("The stand-in only models percent_off coupons.");
			const rec: CouponRec = {
				id,
				name: params.name ?? null,
				percent_off: params.percent_off,
				duration: params.duration ?? "once",
				max_redemptions: params.max_redemptions ?? null,
				times_redeemed: 0,
				applies_to: params.applies_to?.products ? { products: [...params.applies_to.products] } : undefined,
				metadata: { ...(params.metadata as Record<string, string>) },
			};
			this.#coupons.set(id, rec);
			return this.#couponObject(rec);
		},
		update: async (id: string, params: Stripe.CouponUpdateParams): Promise<Stripe.Coupon> => {
			this.calls.push({ method: "coupons.update", id, params });
			const c = this.#coupons.get(id);
			if (!c) throw missing("coupon", id);
			const allowed = new Set(["name", "metadata", "currency_options"]);
			for (const key of Object.keys(params)) if (!allowed.has(key)) throw new StandInStripeError(`Received unknown parameter: ${key}`);
			if (params.name !== undefined) c.name = params.name;
			return this.#couponObject(c);
		},
	};

	promotionCodes = {
		list: async (params: Stripe.PromotionCodeListParams): Promise<Stripe.ApiList<Stripe.PromotionCode>> => {
			this.calls.push({ method: "promotionCodes.list", params: { ...params, code: params.code ? "<code>" : undefined } });
			let all = [...this.#promos.values()];
			if (params.code) all = all.filter((p) => p.code.toLowerCase() === params.code?.toLowerCase());
			if (params.coupon) all = all.filter((p) => p.coupon === params.coupon);
			if (params.active !== undefined) all = all.filter((p) => p.active === params.active);
			return list(all.map((p) => this.#promoObject(p)));
		},
		create: async (params: Stripe.PromotionCodeCreateParams): Promise<Stripe.PromotionCode> => {
			this.calls.push({ method: "promotionCodes.create", params: { ...params, code: "<code>" } });
			const couponId = params.promotion?.coupon;
			if (!couponId || !this.#coupons.has(couponId)) throw missing("coupon", String(couponId));
			const code = params.code ?? this.#id("CODE");
			if ([...this.#promos.values()].some((p) => p.active && p.code.toLowerCase() === code.toLowerCase())) {
				throw new StandInStripeError("An active promotion code with that code already exists.");
			}
			const rec: PromoRec = {
				id: this.#id("promo"),
				code,
				coupon: couponId,
				active: params.active ?? true,
				max_redemptions: params.max_redemptions ?? null,
				times_redeemed: 0,
				first_time_transaction: params.restrictions?.first_time_transaction ?? false,
			};
			this.#promos.set(rec.id, rec);
			return this.#promoObject(rec);
		},
	};

	customers = {
		create: async (params: Stripe.CustomerCreateParams): Promise<Stripe.Customer> => {
			this.calls.push({ method: "customers.create", params: { ...params, email: params.email ? "<email>" : undefined } });
			const rec: CustomerRec = { id: this.#id("cus"), email: params.email ?? null, metadata: { ...(params.metadata as Record<string, string>) } };
			this.#customers.set(rec.id, rec);
			return { id: rec.id, object: "customer", email: rec.email, metadata: rec.metadata } as unknown as Stripe.Customer;
		},
	};

	checkout = {
		sessions: {
			create: async (params: Stripe.Checkout.SessionCreateParams): Promise<Stripe.Checkout.Session> => {
				this.calls.push({ method: "checkout.sessions.create", params });
				if (params.mode !== "subscription") throw new StandInStripeError("The stand-in only models subscription mode.");
				if (params.allow_promotion_codes && params.discounts) throw new StandInStripeError("You may only specify one of these parameters: allow_promotion_codes, discounts.");
				// Like a new Stripe account: Managed Payments is on unless the session turns it off, and it refuses custom_text.
				if (params.custom_text && params.managed_payments?.enabled !== false) {
					throw new StandInStripeError("custom_text cannot be used with Managed Payments, which is enabled by default on your account.");
				}
				const items = params.line_items ?? [];
				const first = items[0];
				if (items.length !== 1 || !first?.price || !this.#prices.has(first.price)) throw new StandInStripeError("Exactly one known recurring price is needed.");
				if (params.customer && !this.#customers.has(params.customer)) throw missing("customer", params.customer);
				const rec: SessionRec = {
					id: this.#id("cs_test"),
					params: clone(params),
					status: "open",
					customer: params.customer ?? null,
					subscription: null,
					termsAccepted: false,
					email: params.customer ? (this.#customers.get(params.customer)?.email ?? null) : (params.customer_email ?? null),
					created: this.#sec(),
				};
				this.#sessions.set(rec.id, rec);
				return this.#sessionObject(rec);
			},
			retrieve: async (id: string): Promise<Stripe.Checkout.Session> => {
				this.calls.push({ method: "checkout.sessions.retrieve", id });
				const s = this.#sessions.get(id);
				if (!s) throw missing("checkout.session", id);
				return this.#sessionObject(s);
			},
		},
	};

	subscriptions = {
		retrieve: async (id: string, params?: Stripe.SubscriptionRetrieveParams): Promise<Stripe.Subscription> => {
			this.calls.push({ method: "subscriptions.retrieve", id, params });
			const s = this.#subs.get(id);
			if (!s) throw missing("subscription", id);
			return this.#subObject(s, params?.expand ?? []);
		},
		update: async (id: string, params: Stripe.SubscriptionUpdateParams): Promise<Stripe.Subscription> => {
			this.calls.push({ method: "subscriptions.update", id, params });
			const s = this.#subs.get(id);
			if (!s) throw missing("subscription", id);
			const supported = new Set(["metadata", "cancel_at_period_end", "trial_end", "items", "payment_behavior", "proration_behavior", "discounts", "expand"]);
			for (const key of Object.keys(params)) if (!supported.has(key)) throw new StandInStripeError(`The stand-in does not model the parameter ${key}.`);
			if (s.status === "canceled" || s.status === "incomplete_expired") throw new StandInStripeError("A canceled subscription can only update its cancellation_details and metadata.");
			if (params.metadata && typeof params.metadata === "object") s.metadata = { ...s.metadata, ...(params.metadata as Record<string, string>) };
			if (params.discounts === "" || (Array.isArray(params.discounts) && params.discounts.length === 0)) s.discount = null;
			if (params.cancel_at_period_end !== undefined) {
				s.cancelAtPeriodEnd = params.cancel_at_period_end;
				s.cancelAt = params.cancel_at_period_end ? s.periodEnd : null;
				s.canceledAt = params.cancel_at_period_end ? this.#sec() : null;
			}
			const newPrice = params.items?.[0]?.price;
			if (params.items && (params.items.length !== 1 || params.items[0]?.id !== s.itemId)) throw new StandInStripeError("Pass the subscription's one item id to change its price.");
			if (newPrice && !this.#prices.get(newPrice)?.active) throw missing("price", newPrice);

			if (params.trial_end === "now" && s.status === "trialing") {
				const price = newPrice ?? s.price;
				const invoice = this.#newInvoice(s, { reason: "subscription_update", price, periodStart: this.#sec(), periodEnd: this.#periodEnd(this.#sec(), price) });
				const paid = this.#tryPay(invoice, s);
				if (!paid) {
					const behavior = params.payment_behavior ?? "allow_incomplete";
					if (behavior === "error_if_incomplete") {
						invoice.status = "void";
						throw new StandInStripeError("Your card was declined.", { type: "StripeCardError", code: "card_declined", statusCode: 402 });
					}
					if (behavior === "pending_if_incomplete") {
						s.latestInvoice = invoice.id;
						this.#emit("invoice.payment_failed", this.#invoiceObject(invoice));
						const obj = this.#subObject(s, params.expand ?? []);
						(obj as { pending_update: unknown }).pending_update = { trial_end: this.#sec(), subscription_items: [{ price }], expires_at: this.#sec() + 23 * 3600 };
						return obj;
					}
					s.status = "past_due";
				} else s.status = "active";
				s.price = price;
				s.trialEnd = this.#sec();
				s.periodStart = invoice.period_start;
				s.periodEnd = invoice.period_end;
				s.latestInvoice = invoice.id;
				s.upcomingSentFor = null;
				this.#emit("customer.subscription.updated", this.#subObject(s, []));
				this.#emit(paid ? "invoice.paid" : "invoice.payment_failed", this.#invoiceObject(invoice));
				return this.#subObject(s, params.expand ?? []);
			}
			if (newPrice) s.price = newPrice;
			this.#emit("customer.subscription.updated", this.#subObject(s, []));
			return this.#subObject(s, params.expand ?? []);
		},
		cancel: async (id: string, params?: Stripe.SubscriptionCancelParams): Promise<Stripe.Subscription> => {
			this.calls.push({ method: "subscriptions.cancel", id, params });
			const s = this.#subs.get(id);
			if (!s) throw missing("subscription", id);
			this.#end(s, this.#sec());
			return this.#subObject(s, []);
		},
		deleteDiscount: async (id: string): Promise<Stripe.DeletedDiscount> => {
			this.calls.push({ method: "subscriptions.deleteDiscount", id });
			const s = this.#subs.get(id);
			if (!s) throw missing("subscription", id);
			if (!s.discount) throw new StandInStripeError("This subscription has no discount.", { code: "resource_missing", statusCode: 404 });
			const gone = s.discount;
			s.discount = null;
			this.#emit("customer.subscription.updated", this.#subObject(s, []));
			return { id: gone.id, object: "discount", deleted: true } as unknown as Stripe.DeletedDiscount;
		},
	};

	invoices = {
		retrieve: async (id: string): Promise<Stripe.Invoice> => {
			this.calls.push({ method: "invoices.retrieve", id });
			const inv = this.#invoices.get(id);
			if (!inv) throw missing("invoice", id);
			return this.#invoiceObject(inv);
		},
	};

	paymentMethods = {
		retrieve: async (id: string): Promise<Stripe.PaymentMethod> => {
			this.calls.push({ method: "paymentMethods.retrieve", id });
			const pm = this.#paymentMethods.get(id);
			if (!pm) throw missing("payment_method", id);
			return this.#pmObject(pm);
		},
		list: async (params: Stripe.PaymentMethodListParams): Promise<Stripe.ApiList<Stripe.PaymentMethod>> => {
			this.calls.push({ method: "paymentMethods.list", params });
			const mine = [...this.#paymentMethods.values()].filter((pm) => pm.customer === params.customer).reverse();
			return list(mine.slice(0, params.limit ?? 10).map((pm) => this.#pmObject(pm)));
		},
	};

	billingPortal = {
		sessions: {
			create: async (params: Stripe.BillingPortal.SessionCreateParams): Promise<Stripe.BillingPortal.Session> => {
				this.calls.push({ method: "billingPortal.sessions.create", params });
				if (!params.customer || !this.#customers.has(params.customer)) throw missing("customer", String(params.customer));
				const id = this.#id("bps");
				const session = { id, object: "billing_portal.session", customer: params.customer, return_url: params.return_url ?? null, url: `https://billing.stripe.test/p/session/${id}` } as unknown as Stripe.BillingPortal.Session;
				this.portalSessions.push(session);
				return clone(session);
			},
		},
	};

	webhooks = {
		constructEvent: (payload: string | Buffer, header: string, secret: string): Stripe.Event => this.#signer.webhooks.constructEvent(payload, header, secret),
	};

	// ---- what a student does at Stripe (test helpers) ----

	/** The student finishes Checkout. Throws what Checkout would show (no card, terms not ticked, bad code, card refused). */
	async completeCheckout(sessionId: string, completion: CheckoutCompletion = {}): Promise<{ subscriptionId: string; customerId: string }> {
		const s = this.#sessions.get(sessionId);
		if (!s) throw missing("checkout.session", sessionId);
		if (s.status !== "open") throw new StandInStripeError("This Checkout Session is no longer open.");
		const p = s.params;
		if (!completion.card && p.payment_method_collection !== "if_required") throw new StandInStripeError("Checkout needs a card for this subscription.", { code: "payment_method_required" });
		if (p.consent_collection?.terms_of_service === "required" && completion.acceptTerms === false) throw new StandInStripeError("You must agree to the terms of service.");

		const priceId = p.line_items?.[0]?.price as string;
		const price = this.#prices.get(priceId) as PriceRec;
		let customerId = s.customer;
		if (!customerId) {
			customerId = (await this.customers.create({ email: s.email ?? undefined })).id;
		}
		const discount = completion.promotionCode ? this.#redeemable(completion.promotionCode, customerId, price, Boolean(p.allow_promotion_codes)) : null;

		const pm: PaymentMethodRec | null = completion.card ? { id: this.#id("pm"), customer: customerId, card: completion.card } : null;
		if (pm) this.#paymentMethods.set(pm.id, pm);

		const trialDays = p.subscription_data?.trial_period_days ?? 0;
		const now = this.#sec();
		const sub: SubRec = {
			id: this.#id("sub"),
			customer: customerId,
			status: trialDays > 0 ? "trialing" : "active",
			itemId: this.#id("si"),
			price: priceId,
			created: now,
			trialStart: trialDays > 0 ? now : null,
			trialEnd: trialDays > 0 ? now + trialDays * 86400 : null,
			periodStart: now,
			periodEnd: trialDays > 0 ? now + trialDays * 86400 : this.#periodEnd(now, priceId),
			cancelAtPeriodEnd: false,
			cancelAt: null,
			canceledAt: null,
			endedAt: null,
			discount,
			paymentMethod: pm?.id ?? null,
			showsDefaultPaymentMethod: this.checkoutSetsDefaultPaymentMethod,
			latestInvoice: null,
			metadata: { ...((p.subscription_data?.metadata ?? {}) as Record<string, string>) },
			upcomingSentFor: null,
		};
		const invoice = this.#newInvoice(sub, { reason: "subscription_create", price: priceId, periodStart: now, periodEnd: sub.periodEnd, free: trialDays > 0 });
		if (!this.#tryPay(invoice, sub)) {
			this.#invoices.delete(invoice.id);
			throw new StandInStripeError("Your card was declined.", { type: "StripeCardError", code: "card_declined", statusCode: 402 });
		}
		if (discount) this.#redeem(discount, completion.promotionCode as string);
		sub.latestInvoice = invoice.id;
		this.#subs.set(sub.id, sub);
		s.status = "complete";
		s.customer = customerId;
		s.subscription = sub.id;
		s.termsAccepted = p.consent_collection?.terms_of_service === "required";
		void price;

		this.#emit("customer.subscription.created", this.#subObject(sub, []));
		this.#emit("invoice.paid", this.#invoiceObject(invoice));
		this.#emit("checkout.session.completed", this.#sessionObject(s));
		return { subscriptionId: sub.id, customerId };
	}

	/**
	 * The student cancels in the customer portal ("at period end", the setting in
	 * billing/README.md). Flexible billing mode, Stripe's default since API
	 * 2025-09-30: cancel_at is the period end and cancel_at_period_end stays false.
	 */
	portalCancel(subscriptionId: string, mode: "flexible" | "classic" = "flexible"): void {
		const s = this.#subs.get(subscriptionId);
		if (!s) throw missing("subscription", subscriptionId);
		s.cancelAt = s.periodEnd;
		s.cancelAtPeriodEnd = mode === "classic";
		s.canceledAt = this.#sec();
		this.#emit("customer.subscription.updated", this.#subObject(s, []));
	}

	/** Every later charge on this card is refused, or accepted again. */
	setCardDeclines(fingerprint: string, declines: boolean): void {
		for (const pm of this.#paymentMethods.values()) if (pm.card.fingerprint === fingerprint) pm.card = { ...pm.card, declines };
	}

	/** Moves the clock, running trial ends, renewals, cancellations and upcoming-renewal events in time order. */
	advanceTo(targetMs: number): void {
		if (targetMs < this.#clock) throw new Error("The stand-in's clock only moves forward.");
		const target = Math.floor(targetMs / 1000);
		for (;;) {
			let next: { at: number; run: () => void } | null = null;
			const consider = (at: number, run: () => void) => {
				if (at <= target && (!next || at < next.at)) next = { at, run };
			};
			for (const s of this.#subs.values()) {
				if (s.status === "canceled" || s.status === "incomplete_expired") continue;
				const endAt = s.cancelAt;
				if (endAt !== null && endAt <= s.periodEnd) consider(endAt, () => this.#end(s, endAt));
				else consider(s.periodEnd, () => this.#renew(s));
				const days = this.upcomingRenewalDays;
				if (days !== undefined && s.status !== "trialing" && s.cancelAt === null && s.upcomingSentFor !== s.periodEnd) {
					consider(s.periodEnd - days * 86400, () => this.#upcoming(s));
				}
			}
			if (!next) break;
			const step = next as { at: number; run: () => void };
			this.#clock = Math.max(this.#clock, step.at * 1000);
			step.run();
		}
		this.#clock = targetMs;
	}

	/** Advance by whole days. */
	advanceDays(days: number): void {
		this.advanceTo(this.#clock + days * DAY_MS);
	}

	// ---- events ----

	takeEvents(): Stripe.Event[] {
		const out = this.pending;
		this.pending = [];
		this.delivered.push(...out);
		return out;
	}

	/** The body and Stripe-Signature header Stripe would send for this event. */
	sign(event: Stripe.Event, secret: string = this.webhookSecret, timestamp?: number): { payload: string; header: string } {
		const payload = JSON.stringify(event);
		const header = this.#signer.webhooks.generateTestHeaderString({ payload, secret, ...(timestamp !== undefined ? { timestamp } : {}) });
		return { payload, header };
	}

	/** POSTs every pending event to the webhook URL, signed, in order. Returns the HTTP statuses. */
	async deliver(url: string): Promise<number[]> {
		const statuses: number[] = [];
		for (const event of this.takeEvents()) {
			const { payload, header } = this.sign(event);
			const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": header }, body: payload });
			await res.text();
			statuses.push(res.status);
		}
		return statuses;
	}

	// ---- inspection ----

	subscription(id: string): Readonly<SubRec> {
		const s = this.#subs.get(id);
		if (!s) throw missing("subscription", id);
		return s;
	}
	subscriptionsOf(customerId: string): Readonly<SubRec>[] {
		return [...this.#subs.values()].filter((s) => s.customer === customerId);
	}
	invoicesOf(subscriptionId: string): Readonly<InvoiceRec>[] {
		return [...this.#invoices.values()].filter((i) => i.subscription === subscriptionId);
	}
	couponRedemptions(id: string): number {
		return this.#coupons.get(id)?.times_redeemed ?? 0;
	}
	priceOf(subscriptionId: string): Readonly<PriceRec> {
		return this.#prices.get(this.subscription(subscriptionId).price) as PriceRec;
	}
	checkoutSession(id: string): Readonly<SessionRec> {
		const s = this.#sessions.get(id);
		if (!s) throw missing("checkout.session", id);
		return s;
	}
	lastCall(method: string): StandInCall | undefined {
		return [...this.calls].reverse().find((c) => c.method === method);
	}

	// ---- internals ----

	#emit(type: string, object: unknown): void {
		this.pending.push({
			id: this.#id("evt"),
			object: "event",
			api_version: API_VERSION,
			created: this.#sec(),
			data: { object: clone(object) },
			livemode: false,
			pending_webhooks: 1,
			request: { id: null, idempotency_key: null },
			type,
		} as unknown as Stripe.Event);
	}

	#periodEnd(startSec: number, priceId: string): number {
		const price = this.#prices.get(priceId) as PriceRec;
		const { interval, interval_count: n } = price.recurring;
		const d = new Date(startSec * 1000);
		if (interval === "day") return startSec + n * 86400;
		if (interval === "week") return startSec + n * 7 * 86400;
		const months = interval === "year" ? 12 * n : n;
		return Math.floor(addMonthsUtc(d, months).getTime() / 1000);
	}

	#amountFor(priceId: string, discount: DiscountRec | null): number {
		const price = this.#prices.get(priceId) as PriceRec;
		const percent = discount ? (this.#coupons.get(discount.coupon)?.percent_off ?? 0) : 0;
		return price.unit_amount - Math.round((price.unit_amount * percent) / 100);
	}

	#newInvoice(s: SubRec, o: { reason: Stripe.Invoice.BillingReason; price: string; periodStart: number; periodEnd: number; free?: boolean }): InvoiceRec {
		const amount = o.free ? 0 : this.#amountFor(o.price, s.discount);
		const inv: InvoiceRec = {
			id: this.#id("in"),
			customer: s.customer,
			subscription: s.id,
			status: "open",
			billing_reason: o.reason,
			amount_due: amount,
			amount_paid: 0,
			currency: "usd",
			created: this.#sec(),
			period_start: o.periodStart,
			period_end: o.periodEnd,
			paid_at: null,
			price: o.price,
			discount: s.discount,
		};
		this.#invoices.set(inv.id, inv);
		return inv;
	}

	/** Charges the subscription's card. A $0 invoice is paid without a charge. */
	#tryPay(inv: InvoiceRec, s: SubRec): boolean {
		if (inv.amount_due > 0) {
			const pm = s.paymentMethod ? this.#paymentMethods.get(s.paymentMethod) : undefined;
			if (!pm || pm.card.declines) return false;
		}
		inv.status = "paid";
		inv.amount_paid = inv.amount_due;
		inv.paid_at = this.#sec();
		return true;
	}

	#renew(s: SubRec): void {
		const start = s.periodEnd;
		const wasTrial = s.status === "trialing";
		const inv = this.#newInvoice(s, { reason: "subscription_cycle", price: s.price, periodStart: start, periodEnd: this.#periodEnd(start, s.price) });
		const paid = this.#tryPay(inv, s);
		s.periodStart = inv.period_start;
		s.periodEnd = inv.period_end;
		s.latestInvoice = inv.id;
		s.status = paid ? "active" : "past_due";
		if (wasTrial || !paid) this.#emit("customer.subscription.updated", this.#subObject(s, []));
		this.#emit(paid ? "invoice.paid" : "invoice.payment_failed", this.#invoiceObject(inv));
	}

	#upcoming(s: SubRec): void {
		s.upcomingSentFor = s.periodEnd;
		const amount = this.#amountFor(s.price, s.discount);
		this.#emit("invoice.upcoming", {
			object: "invoice",
			customer: s.customer,
			customer_email: this.#customers.get(s.customer)?.email ?? null,
			status: "draft",
			billing_reason: "upcoming",
			amount_due: amount,
			amount_paid: 0,
			currency: "usd",
			period_start: s.periodStart,
			period_end: s.periodEnd,
			next_payment_attempt: s.periodEnd,
			parent: { type: "subscription_details", subscription_details: { subscription: s.id, metadata: s.metadata } },
			lines: { object: "list", data: [{ object: "line_item", amount, pricing: { price_details: { price: s.price } }, period: { start: s.periodEnd, end: this.#periodEnd(s.periodEnd, s.price) } }] },
		});
	}

	#end(s: SubRec, atSec: number): void {
		s.status = "canceled";
		s.endedAt = atSec;
		s.canceledAt = s.canceledAt ?? atSec;
		this.#emit("customer.subscription.deleted", this.#subObject(s, []));
	}

	#redeemable(code: string, customerId: string, price: PriceRec, allowed: boolean): DiscountRec {
		if (!allowed) throw new StandInStripeError("This Checkout Session does not take promotion codes.");
		const promo = [...this.#promos.values()].find((p) => p.active && p.code.toLowerCase() === code.toLowerCase());
		if (!promo) throw new StandInStripeError("This code is invalid.", { code: "promotion_code_invalid" });
		const coupon = this.#coupons.get(promo.coupon) as CouponRec;
		if (coupon.max_redemptions !== null && coupon.times_redeemed >= coupon.max_redemptions) {
			throw new StandInStripeError("This code has reached its maximum redemptions.", { code: "coupon_expired" });
		}
		if (promo.max_redemptions !== null && promo.times_redeemed >= promo.max_redemptions) throw new StandInStripeError("This code has reached its maximum redemptions.", { code: "coupon_expired" });
		if (coupon.applies_to && !coupon.applies_to.products.includes(price.product)) throw new StandInStripeError("This code does not apply to this product.");
		if (promo.first_time_transaction && [...this.#invoices.values()].some((i) => i.customer === customerId)) {
			throw new StandInStripeError("This code is only for first-time customers.", { code: "promotion_code_customer_not_eligible" });
		}
		return { id: this.#id("di"), coupon: coupon.id, promotionCode: promo.id, start: this.#sec() };
	}

	#redeem(discount: DiscountRec, code: string): void {
		const coupon = this.#coupons.get(discount.coupon) as CouponRec;
		coupon.times_redeemed += 1;
		const promo = [...this.#promos.values()].find((p) => p.code.toLowerCase() === code.toLowerCase());
		if (promo) promo.times_redeemed += 1;
	}

	// ---- object shapes (Stripe's, API 2026-10-28.endive) ----

	#priceObject(p: PriceRec): Stripe.Price {
		return clone({ object: "price", ...p, type: "recurring", recurring: { ...p.recurring, usage_type: "licensed" } }) as unknown as Stripe.Price;
	}

	#couponObject(c: CouponRec): Stripe.Coupon {
		return clone({ object: "coupon", valid: c.max_redemptions === null || c.times_redeemed < c.max_redemptions, ...c }) as unknown as Stripe.Coupon;
	}

	#promoObject(p: PromoRec): Stripe.PromotionCode {
		return clone({
			id: p.id,
			object: "promotion_code",
			code: p.code,
			active: p.active,
			max_redemptions: p.max_redemptions,
			times_redeemed: p.times_redeemed,
			promotion: { type: "coupon", coupon: p.coupon },
			restrictions: { first_time_transaction: p.first_time_transaction },
		}) as unknown as Stripe.PromotionCode;
	}

	#pmObject(pm: PaymentMethodRec): Stripe.PaymentMethod {
		return clone({ id: pm.id, object: "payment_method", type: "card", customer: pm.customer, card: { brand: pm.card.brand, last4: pm.card.last4, fingerprint: pm.card.fingerprint } }) as unknown as Stripe.PaymentMethod;
	}

	#discountObject(d: DiscountRec, subId: string, expandCoupon: boolean): unknown {
		const coupon = this.#coupons.get(d.coupon) as CouponRec;
		return { id: d.id, object: "discount", source: { type: "coupon", coupon: expandCoupon ? this.#couponObject(coupon) : coupon.id }, promotion_code: d.promotionCode, subscription: subId, start: d.start, end: null };
	}

	#subObject(s: SubRec, expand: readonly string[]): Stripe.Subscription {
		const price = this.#prices.get(s.price) as PriceRec;
		const pm = s.paymentMethod ? this.#paymentMethods.get(s.paymentMethod) : undefined;
		const expandDiscounts = expand.includes("discounts") || expand.includes("discounts.source.coupon");
		return clone({
			id: s.id,
			object: "subscription",
			customer: s.customer,
			status: s.status,
			created: s.created,
			start_date: s.created,
			trial_start: s.trialStart,
			trial_end: s.trialEnd,
			cancel_at_period_end: s.cancelAtPeriodEnd,
			cancel_at: s.status === "canceled" ? null : s.cancelAt,
			canceled_at: s.canceledAt,
			ended_at: s.endedAt,
			metadata: s.metadata,
			default_payment_method: !s.showsDefaultPaymentMethod || !pm ? null : expand.includes("default_payment_method") ? this.#pmObject(pm) : pm.id,
			latest_invoice: expand.includes("latest_invoice") && s.latestInvoice ? this.#invoiceObject(this.#invoices.get(s.latestInvoice) as InvoiceRec) : s.latestInvoice,
			pending_update: null,
			discounts: s.discount ? [expandDiscounts ? this.#discountObject(s.discount, s.id, expand.includes("discounts.source.coupon")) : s.discount.id] : [],
			items: {
				object: "list",
				data: [{ id: s.itemId, object: "subscription_item", subscription: s.id, price: this.#priceObject(price), current_period_start: s.periodStart, current_period_end: s.periodEnd, discounts: [], quantity: 1 }],
			},
			livemode: false,
		}) as unknown as Stripe.Subscription;
	}

	#invoiceObject(inv: InvoiceRec): Stripe.Invoice {
		return clone({
			id: inv.id,
			object: "invoice",
			customer: inv.customer,
			customer_email: this.#customers.get(inv.customer)?.email ?? null,
			status: inv.status,
			billing_reason: inv.billing_reason,
			amount_due: inv.amount_due,
			amount_paid: inv.amount_paid,
			amount_remaining: inv.amount_due - inv.amount_paid,
			currency: inv.currency,
			created: inv.created,
			period_start: inv.period_start,
			period_end: inv.period_end,
			status_transitions: { paid_at: inv.paid_at, finalized_at: inv.created, voided_at: null, marked_uncollectible_at: null },
			parent: { type: "subscription_details", subscription_details: { subscription: inv.subscription, metadata: {} }, quote_details: null },
			hosted_invoice_url: `https://invoice.stripe.test/i/${inv.id}`,
			discounts: inv.discount ? [inv.discount.id] : [],
			livemode: false,
		}) as unknown as Stripe.Invoice;
	}

	#sessionObject(s: SessionRec): Stripe.Checkout.Session {
		return clone({
			id: s.id,
			object: "checkout.session",
			mode: s.params.mode,
			status: s.status,
			url: s.status === "open" ? `https://checkout.stripe.test/c/pay/${s.id}` : null,
			customer: s.customer,
			customer_details: s.status === "complete" ? { email: s.email } : null,
			client_reference_id: s.params.client_reference_id ?? null,
			subscription: s.subscription,
			metadata: s.params.metadata ?? {},
			consent: s.termsAccepted ? { terms_of_service: "accepted", promotions: null } : null,
			payment_status: s.status === "complete" ? "paid" : "unpaid",
			created: s.created,
			livemode: false,
		}) as unknown as Stripe.Checkout.Session;
	}
}

function list<T>(data: T[]): Stripe.ApiList<T> {
	return { object: "list", data, has_more: false, url: "/v1/standin" } as Stripe.ApiList<T>;
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

/** Calendar months in UTC; a day past the target month's end falls back to its last day (Stripe's rule). */
export function addMonthsUtc(date: Date, months: number): Date {
	const y = date.getUTCFullYear();
	const m = date.getUTCMonth() + months;
	const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
	return new Date(Date.UTC(y, m, Math.min(date.getUTCDate(), lastDay), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()));
}

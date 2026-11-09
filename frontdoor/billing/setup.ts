/**
 * Creates or updates the Stripe product, prices, coupons and promotion codes
 * (P4-01, PRD C2 plans, req 7 and 8). Safe to run again: a second run finds
 * everything in place and changes nothing.
 *
 * planSetup() only reads Stripe and lists what it would change; applySetup()
 * makes those changes. The command line (setup-cli.ts) prints the plan with
 * --dry-run. Never run by the tests against Stripe: they use the stand-in.
 *
 * Rules Stripe sets (checked 2026-11-08, see billing/README.md):
 *  - A price's amount and interval never change. A new price takes over the
 *    lookup key (transfer_lookup_key) and the old one is archived. Students
 *    already on the old price keep it until they change plans.
 *  - A coupon's percent, duration, limit and products never change. A
 *    coupon that differs is reported, never deleted.
 *  - Promotion codes are the customer-facing words. They come from
 *    environment variables, because the repo is public.
 */
import type Stripe from "stripe";
import { type CouponSpec, COUPONS, CURRENCY, type PriceSpec, priceSpecs, PRODUCT_NAME } from "./catalog.ts";
import { PRODUCT_ID } from "./config.ts";
import { idOf, isMissing, type StripeApi } from "./stripe-api.ts";

export type SetupAction =
	| { kind: "create-product"; id: string; name: string }
	| { kind: "rename-product"; id: string; from: string; to: string }
	| { kind: "create-price"; spec: PriceSpec }
	| { kind: "replace-price"; spec: PriceSpec; oldPriceId: string; why: string }
	| { kind: "create-coupon"; spec: CouponSpec }
	| { kind: "rename-coupon"; spec: CouponSpec; from: string }
	| { kind: "create-promotion-code"; couponId: string; code: string };

export interface SetupPlan {
	actions: SetupAction[];
	/** Things already right, one line each. */
	ok: string[];
	/** Things the script will not fix by itself. Any problem stops applySetup. */
	problems: string[];
	/** Coupons with no code given this run. */
	skipped: string[];
}

export interface SetupOptions {
	/** Customer-facing promotion codes by coupon id, from the environment. */
	codes: Readonly<Record<string, string | undefined>>;
	prices?: PriceSpec[];
	coupons?: readonly CouponSpec[];
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const every = (spec: { interval: string; intervalCount: number }) => (spec.intervalCount === 1 ? spec.interval : `${spec.intervalCount} ${spec.interval}s`);

function priceDiffers(price: Stripe.Price, spec: PriceSpec): string | null {
	if (idOf(price.product) !== PRODUCT_ID) return `it belongs to product ${idOf(price.product)}`;
	if (price.currency !== CURRENCY) return `its currency is ${price.currency}`;
	if (price.unit_amount !== spec.unitAmount) return `it charges ${money(price.unit_amount ?? 0)}, plans/index.ts says ${money(spec.unitAmount)}`;
	if (price.recurring?.interval !== spec.interval || (price.recurring?.interval_count ?? 1) !== spec.intervalCount) {
		return `it renews every ${price.recurring ? every({ interval: price.recurring.interval, intervalCount: price.recurring.interval_count }) : "never"}, plans/index.ts says every ${every(spec)}`;
	}
	return null;
}

function couponDiffers(coupon: Stripe.Coupon, spec: CouponSpec): string | null {
	if (coupon.percent_off !== spec.percentOff) return `it takes ${coupon.percent_off ?? 0}% off, not ${spec.percentOff}%`;
	if (coupon.duration !== "forever") return `its duration is ${coupon.duration}, not forever`;
	if ((coupon.max_redemptions ?? undefined) !== spec.maxRedemptions) return `its redemption limit is ${coupon.max_redemptions ?? "none"}, not ${spec.maxRedemptions ?? "none"}`;
	const products = coupon.applies_to?.products ?? [];
	if (products.length > 0 && !products.includes(PRODUCT_ID)) return `it applies to other products (${products.join(", ")})`;
	return null;
}

export async function planSetup(stripe: StripeApi, options: SetupOptions): Promise<SetupPlan> {
	const plan: SetupPlan = { actions: [], ok: [], problems: [], skipped: [] };
	const prices = options.prices ?? priceSpecs();
	const coupons = options.coupons ?? COUPONS;

	// The product.
	let product: Stripe.Product | null = null;
	try {
		product = await stripe.products.retrieve(PRODUCT_ID);
	} catch (error) {
		if (!isMissing(error)) throw error;
	}
	if (!product) plan.actions.push({ kind: "create-product", id: PRODUCT_ID, name: PRODUCT_NAME });
	else if (product.name !== PRODUCT_NAME) plan.actions.push({ kind: "rename-product", id: PRODUCT_ID, from: product.name, to: PRODUCT_NAME });
	else plan.ok.push(`product ${PRODUCT_ID}`);
	if (product && !product.active) plan.problems.push(`Product ${PRODUCT_ID} is archived in Stripe. Unarchive it in the Dashboard first.`);

	// The prices, found by lookup key.
	const found = product ? await stripe.prices.list({ lookup_keys: prices.map((p) => p.lookupKey), limit: 10 }) : { data: [] as Stripe.Price[] };
	for (const spec of prices) {
		const current = found.data.find((p) => p.lookup_key === spec.lookupKey);
		if (!current) plan.actions.push({ kind: "create-price", spec });
		else {
			const why = priceDiffers(current, spec) ?? (current.active ? null : "it is archived");
			if (why) plan.actions.push({ kind: "replace-price", spec, oldPriceId: current.id, why });
			else plan.ok.push(`price ${spec.lookupKey} (${money(spec.unitAmount)} every ${every(spec)})`);
		}
	}

	// The coupons, by their fixed ids, and their promotion codes.
	for (const spec of coupons) {
		let coupon: Stripe.Coupon | null = null;
		try {
			coupon = await stripe.coupons.retrieve(spec.id);
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
		if (!coupon) plan.actions.push({ kind: "create-coupon", spec });
		else {
			const why = couponDiffers(coupon, spec);
			if (why) plan.problems.push(`Coupon ${spec.id} exists but ${why}. Stripe cannot change that. Delete it in the Dashboard (Product catalog, Coupons) and run this again.`);
			else if (coupon.name !== spec.name) plan.actions.push({ kind: "rename-coupon", spec, from: coupon.name ?? "" });
			else plan.ok.push(`coupon ${spec.id}`);
		}

		const code = options.codes[spec.id]?.trim();
		if (!code) {
			plan.skipped.push(`${spec.id}: no promotion code given (set ${spec.codeEnv})`);
			continue;
		}
		if (!/^[A-Za-z0-9-]{3,200}$/.test(code)) {
			plan.problems.push(`${spec.codeEnv} may hold only letters, digits and dashes (3 or more).`);
			continue;
		}
		const existing = coupon ? (await stripe.promotionCodes.list({ code, limit: 10 })).data : [];
		const mine = existing.find((p) => idOf(p.promotion.coupon) === spec.id);
		if (mine?.active) plan.ok.push(`promotion code for ${spec.id}`);
		else if (mine) plan.problems.push(`The promotion code given in ${spec.codeEnv} exists for ${spec.id} but is archived. Pick a new code, or reactivate it in the Dashboard.`);
		else if (existing.some((p) => p.active)) plan.problems.push(`The promotion code given in ${spec.codeEnv} is already used by another coupon. Pick a new code.`);
		else plan.actions.push({ kind: "create-promotion-code", couponId: spec.id, code });
	}
	return plan;
}

/** One line per action. Never prints a promotion code. */
export function describeAction(action: SetupAction): string {
	switch (action.kind) {
		case "create-product":
			return `create product ${action.id} "${action.name}"`;
		case "rename-product":
			return `rename product ${action.id} from "${action.from}" to "${action.to}"`;
		case "create-price":
			return `create price ${action.spec.lookupKey}: ${money(action.spec.unitAmount)} every ${every(action.spec)}`;
		case "replace-price":
			return `replace price ${action.oldPriceId} (${action.why}) with ${action.spec.lookupKey}: ${money(action.spec.unitAmount)} every ${every(action.spec)}; the old price is archived, its students keep it`;
		case "create-coupon":
			return `create coupon ${action.spec.id}: ${action.spec.percentOff}% off forever${action.spec.maxRedemptions ? `, ${action.spec.maxRedemptions} redemptions` : ""}, ${PRODUCT_ID} only`;
		case "rename-coupon":
			return `rename coupon ${action.spec.id} to "${action.spec.name}"`;
		case "create-promotion-code":
			return `create a promotion code for ${action.couponId} (the code itself is not printed)`;
	}
}

/** Makes the planned changes, in order. Refuses a plan with problems. */
export async function applySetup(stripe: StripeApi, plan: SetupPlan, log: (line: string) => void = () => {}): Promise<void> {
	if (plan.problems.length > 0) throw new Error(`Fix these first:\n- ${plan.problems.join("\n- ")}`);
	for (const action of plan.actions) {
		switch (action.kind) {
			case "create-product":
				await stripe.products.create({ id: action.id, name: action.name, metadata: { app: "ground-tutor" } });
				break;
			case "rename-product":
				await stripe.products.update(action.id, { name: action.to });
				break;
			case "create-price":
			case "replace-price": {
				const { spec } = action;
				await stripe.prices.create({
					product: PRODUCT_ID,
					currency: CURRENCY,
					unit_amount: spec.unitAmount,
					recurring: { interval: spec.interval, interval_count: spec.intervalCount },
					lookup_key: spec.lookupKey,
					transfer_lookup_key: true,
					nickname: spec.nickname,
					metadata: { plan: spec.planId },
				});
				if (action.kind === "replace-price") await stripe.prices.update(action.oldPriceId, { active: false });
				break;
			}
			case "create-coupon": {
				const { spec } = action;
				await stripe.coupons.create({
					id: spec.id,
					name: spec.name,
					percent_off: spec.percentOff,
					duration: "forever",
					...(spec.maxRedemptions ? { max_redemptions: spec.maxRedemptions } : {}),
					applies_to: { products: [PRODUCT_ID] },
				});
				break;
			}
			case "rename-coupon":
				await stripe.coupons.update(action.spec.id, { name: action.spec.name });
				break;
			case "create-promotion-code":
				await stripe.promotionCodes.create({
					promotion: { type: "coupon", coupon: action.couponId },
					code: action.code,
					// C2 req 7: "first-time order only" stays off, or a student who had a trial could not use it.
					restrictions: { first_time_transaction: false },
				});
				break;
		}
		log(`done: ${describeAction(action)}`);
	}
}

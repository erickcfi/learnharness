/**
 * When a study session ends (W2-10, C6 req 3, PD1), and the report week
 * in school time (Salinas, California).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { endedSittings, groupSittings, mainChat, type Stretch, stretchWindowStart } from "../frontdoor/reports/sittings.ts";
import { displayDate, localDate, REPORT_TIME_ZONE, weekContaining, weekDueNow, zonedTime } from "../frontdoor/reports/time.ts";

const T0 = Date.parse("2026-11-08T17:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000);
const stretch = (chatId: string | null, fromMin: number, toMin: number, seconds = (toMin - fromMin) * 60): Stretch => ({ chatId, startedAt: at(fromMin), lastActiveAt: at(toMin), activeSeconds: seconds });

describe("study sittings", () => {
	it("joins stretches with gaps up to 30 minutes, across chats, and splits after a longer gap", () => {
		const sittings = groupSittings([stretch("a", 0, 20), stretch("b", 45, 60), stretch(null, 62, 64), stretch("a", 65, 70), stretch("a", 101, 110)]);
		assert.equal(sittings.length, 2);
		const [first, second] = sittings as [(typeof sittings)[number], (typeof sittings)[number]];
		assert.equal(first.startedAt.toISOString(), at(0).toISOString());
		assert.equal(first.endedAt.toISOString(), at(70).toISOString());
		assert.equal(first.activeSeconds, (20 + 15 + 2 + 5) * 60);
		assert.deepEqual(first.chats, [
			{ chatId: "a", activeSeconds: 25 * 60 },
			{ chatId: "b", activeSeconds: 15 * 60 },
		]);
		assert.equal(mainChat(first), "a");
		assert.equal(second.startedAt.toISOString(), at(101).toISOString());
	});

	it("sorts stretches first, so read order does not matter", () => {
		const a = groupSittings([stretch("a", 40, 50), stretch("a", 0, 30)]);
		assert.equal(a.length, 1);
		assert.equal(a[0]!.startedAt.toISOString(), at(0).toISOString());
	});

	it("reports a sitting only after 30 idle minutes, within 12 hours, at 5 minutes or more, and with a tutor session", () => {
		const s = [stretch("a", 0, 40)];
		assert.equal(endedSittings(s, at(69)).length, 0, "29 idle minutes: still going");
		assert.equal(endedSittings(s, at(70)).length, 1, "30 idle minutes: ended");
		assert.equal(endedSittings(s, at(40 + 12 * 60)).length, 1);
		assert.equal(endedSittings(s, at(41 + 12 * 60)).length, 0, "older than the lookback");
		assert.equal(endedSittings([stretch("a", 0, 4)], at(100)).length, 0, "under 5 minutes");
		assert.equal(endedSittings([stretch(null, 0, 40)], at(100)).length, 0, "no tutor session");
		assert.equal(endedSittings(s, at(55), { idleMinutes: 10 }).length, 1, "the idle time can be set");
	});

	it("reads far enough back to see a long sitting whole", () => {
		assert.equal(stretchWindowStart(at(0)).toISOString(), new Date(T0 - 36 * 3600_000).toISOString());
	});
});

describe("report weeks in school time (America/Los_Angeles)", () => {
	it("is the school's zone", () => {
		assert.equal(REPORT_TIME_ZONE, "America/Los_Angeles");
	});

	it("runs Monday 00:00 to Monday 00:00 local, across the end of daylight time", () => {
		// Sunday Nov 1, 2026 is when Pacific time falls back.
		const week = weekContaining(new Date("2026-11-04T20:00:00Z"), REPORT_TIME_ZONE);
		assert.equal(week.weekStart, "2026-11-02");
		assert.equal(week.weekEnd, "2026-11-08");
		assert.equal(week.startsAt.toISOString(), "2026-11-02T08:00:00.000Z");
		assert.equal(week.endsAt.toISOString(), "2026-11-09T08:00:00.000Z");
		assert.equal(week.dueAt.toISOString(), "2026-11-09T16:00:00.000Z");
		const dst = weekContaining(new Date("2026-10-28T20:00:00Z"), REPORT_TIME_ZONE);
		assert.equal(dst.weekStart, "2026-10-26");
		assert.equal(dst.startsAt.toISOString(), "2026-10-26T07:00:00.000Z");
		assert.equal(dst.endsAt.toISOString(), "2026-11-02T08:00:00.000Z", "a 169-hour week");
	});

	it("puts a late Sunday evening in the week that ends then, not the next one", () => {
		// 11:30 pm Sunday Nov 8 in Salinas is 07:30 Monday UTC.
		assert.equal(weekContaining(new Date("2026-11-09T07:30:00Z"), REPORT_TIME_ZONE).weekStart, "2026-11-02");
		assert.equal(localDate(new Date("2026-11-09T07:30:00Z"), REPORT_TIME_ZONE), "2026-11-08");
	});

	it("makes last week's report due Monday 08:00 local, for 48 hours", () => {
		assert.equal(weekDueNow(new Date("2026-11-09T15:59:00Z"), REPORT_TIME_ZONE), null, "7:59 am Monday");
		assert.equal(weekDueNow(new Date("2026-11-09T16:00:00Z"), REPORT_TIME_ZONE)?.weekStart, "2026-11-02");
		assert.equal(weekDueNow(new Date("2026-11-11T15:59:00Z"), REPORT_TIME_ZONE)?.weekStart, "2026-11-02");
		assert.equal(weekDueNow(new Date("2026-11-11T16:00:00Z"), REPORT_TIME_ZONE), null, "window closed");
		assert.equal(weekDueNow(new Date("2026-11-13T20:00:00Z"), REPORT_TIME_ZONE), null, "Friday");
	});

	it("turns wall-clock times into moments and formats dates", () => {
		assert.equal(zonedTime(2026, 7, 6, 8, 0, REPORT_TIME_ZONE).toISOString(), "2026-07-06T15:00:00.000Z");
		assert.equal(displayDate(new Date("2026-11-09T07:30:00Z"), REPORT_TIME_ZONE), "Nov 8, 2026");
	});
});

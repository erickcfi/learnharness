/**
 * The study record (C6 req 1 and 2): read a tenant's upstream server,
 * build the record, render print-ready HTML. Framework-free; the front
 * door's record screen (a later card) wires it in:
 *
 *   const source = await fetchRecordSource(tenantServerUrl);
 *   const record = buildStudyRecord(source, { studentName, printedAt: new Date(), timeZone, activeSecondsBySession });
 *   const html = renderStudyRecordHtml(record);
 */
export {
	UpstreamContractError,
	fetchRecordSource,
	parseChatList,
	parseChatRecord,
	parseGraph,
	type RecordSource,
	type UpstreamChatRecord,
	type UpstreamChatSummary,
	type UpstreamGraph,
	type UpstreamMessage,
	type UpstreamPlanTree,
	type UpstreamProposition,
} from "./upstream.ts";
export {
	RECORD_LABEL,
	buildStudyRecord,
	formatDuration,
	planProgress,
	type BuildOptions,
	type FactGroup,
	type PlanProgress,
	type RecordFact,
	type RecordSession,
	type StudyRecord,
	type TopicStatus,
} from "./build.ts";
export { renderStudyRecordHtml } from "./render.ts";

import type { accessMaterialDevice } from "./access";
import type { speakerSchema } from "../protocols/micloud/mico";
import type { materialCollectionConfigSchema } from "./config";
import type { createMaterialStorage } from "./storage";
import { sourceMetadata } from "../protocols/source-metadata";
import { success, type CollectorDiagnostic } from "./diagnostics";

/** Own one speaker's page traversal; the service owns scheduling and retry gates. */
export async function collectSpeakerConversations({
  access,
  speaker,
  config,
  save,
  diagnostic,
}: {
  access: ReturnType<typeof accessMaterialDevice>;
  speaker: ReturnType<typeof speakerSchema.parse>;
  config: Pick<
    ReturnType<typeof materialCollectionConfigSchema.parse>,
    "conversation_page_size" | "conversation_page_budget"
  >;
  save: ReturnType<typeof createMaterialStorage>;
  diagnostic: CollectorDiagnostic;
}) {
  const { device } = access;
  let timestamp = Date.now();
  const seen = new Set<string>();
  let count = 0;
  const limitations = [
    "same_millisecond_page_boundary_unverified",
    "speaker_sources_only",
  ];
  for (let page = 0; page < config.conversation_page_budget; page++) {
    access.scope.assertCurrent();
    const result = await access.session.client
      .mico()
      .conversations(
        speaker,
        timestamp,
        config.conversation_page_size,
        access.session.signal,
      );
    const receivedAt = new Date().toISOString();
    access.scope.assertCurrent();
    diagnostic.records_received += result.records.length;
    if (!result.records.length) break;
    let fresh = 0;
    for (const record of result.records) {
      if (seen.has(record.requestId)) continue;
      seen.add(record.requestId);
      fresh++;
      const source = sourceMetadata(
        "device_profile/v2/conversation",
        record,
        device.spec_type ?? null,
      );
      source.raw_time = record.time;
      source.time_unit = "milliseconds";
      source.source_time = new Date(record.time).toISOString();
      source.message_id = record.requestId;
      source.limitations = [
        ...source.limitations.filter(
          (item) => item !== "source_time_unit_unverified",
        ),
        ...limitations,
      ];
      const saved = await save(
        access.scope,
        {
          topic: "xiaoai_conversation",
          account_id: access.scope.identity.accountId,
          home_id: access.scope.identity.homeId,
          device_id: device.did,
          speaker_id: speaker.deviceID,
          hardware: speaker.hardware,
          room_id: device.room_id ?? null,
          model: device.model ?? null,
          source,
          request_id: record.requestId,
          query: record.query,
          answers: record.answers,
          illegal_content: record.illegalContent,
          bit_set: record.bitSet,
        },
        receivedAt,
      );
      if (saved.inserted) diagnostic.records_saved++;
      else diagnostic.records_repeated++;
      count++;
    }
    if (!fresh) {
      limitations.push("repeated_page");
      break;
    }
    if (result.nextEndTime === undefined || result.nextEndTime <= 0) break;
    if (result.nextEndTime >= timestamp) {
      limitations.push("pagination_no_progress");
      break;
    }
    timestamp = result.nextEndTime;
    if (page + 1 === config.conversation_page_budget)
      limitations.push("page_budget_reached");
  }
  success(diagnostic, count, limitations);
}

import { createHash } from "node:crypto";
import {
  MIOT_PROPERTY_BATCH_SIZE,
  MIOT_PROPERTY_TIMEOUT_MS,
} from "../protocols/micloud/properties";

/** Protocol review is evidence for encoding and semantics, not a device run. */
export const miotCloudCacheProfile = {
  contract_id: "miot-cloud-cache-read",
  contract_version: 1,
  supplier: "xiaomi",
  protocol: "micloud_rc4",
  applicability: {
    region: "cn",
    credentials: "mijia_qr_session",
    account_binding: "same_micloud_account_instance",
    device_scope: "selected_home_directory",
    model_and_spec: "current_device_model_with_readable_property",
    topology: "operator_selected_representative_devices",
    gateway_and_firmware: "unverified",
  },
  capability_mapping: {
    address: ["did", "siid", "piid"],
    specification_access: "readable",
    value_structure: "json_scalar",
  },
  read: {
    datasource: 1,
    datasource_policy: "cache_preferred_rpc_on_miss",
    max_batch_size: MIOT_PROPERTY_BATCH_SIZE,
    timeout_ms: MIOT_PROPERTY_TIMEOUT_MS,
    budget_basis: "application_policy",
    concurrency: 1,
    hidden_retries: 0,
    periodic_polling: false,
    read_semantics: "cloud_cache",
    delivery_kind: "baseline",
    observed_at: null,
    time_basis: "unknown",
    source_event_id: "not_provided",
    source_sequence: "not_provided",
    cache_age: "unknown",
    recovery: "explicit_read_only",
  },
  evidence: {
    protocol_review: {
      status: "verified",
      source: "homebridge-miot",
      revision: "8d27204423a569e11c468830e3df324d278954ee",
      files: ["lib/protocol/MiCloud.js", "lib/utils/CustomCryptRC4.js"],
    },
    datasource_review: {
      status: "verified",
      source: "Xiaomi MIoT plugin SDK",
      url: "https://github.com/MiEcosystem/miot-plugin-sdk/wiki/04-miot_spec",
    },
    result_code_review: {
      status: "verified",
      source: "MiLoCo",
      revision: "cad239dca9b7a2dd3bf0e6565a26cf9eef6581b8",
      files: ["backend/miloco/src/miloco/miot/result_codes.py"],
      official_reference:
        "https://github.com/MiEcosystem/miot-plugin-sdk/wiki/米家后台服务接口错误码对照表",
    },
    real_device_read: {
      status: "scoped_verified",
      // Successful value delivery only; no cache-age or other-device guarantee.
      models: [
        {
          model: "yeelink.light.bslamp2",
          properties: [
            [2, 1],
            [2, 2],
            [2, 3],
          ],
        },
        {
          model: "cgllc.airm.cgd1st",
          properties: [
            [3, 4],
            [3, 8],
            [3, 7],
            [3, 1],
          ],
        },
        {
          model: "miaomiaoce.sensor_ht.t9",
          properties: [
            [3, 1001],
            [3, 1002],
            [2, 1003],
          ],
        },
        {
          model: "xiaomi.sensor_occupy.p1",
          properties: [
            [2, 1],
            [2, 5],
            [2, 6],
          ],
        },
      ],
      gateway_and_firmware: "unverified",
    },
    property_push: "see_miot_cloud_push_profile",
    online_notifications: "see_miot_cloud_push_profile",
    independent_device_events: "not_integrated",
  },
} as const;

/** Stable across token renewal; no account identifier is exposed in the ID. */
export function miotSourceId(userId: string, region: "cn" = "cn") {
  const identity = JSON.stringify(["xiaomi", userId, region, "micloud_rc4"]);
  return `miot-${createHash("sha256").update(identity).digest("hex")}`;
}

export function miotPushSourceId(userId: string) {
  return `miot-mqtt-${createHash("sha256")
    .update(JSON.stringify(["xiaomi", userId, "cn", "miot_mqtt"]))
    .digest("hex")}`;
}

/** Subscription evidence and actual message evidence remain separate. */
export const miotCloudPushProfile = {
  contract_id: "miot-cloud-push",
  contract_version: 1,
  supplier: "xiaomi",
  protocol: "mqtt5_tls",
  applicability: {
    region: "cn",
    credentials: "unified_account_oauth",
    device_scope: "explicit_selected_home_devices",
    unsupported_identifiers: "slash_or_mqtt_wildcards",
    gateway_and_firmware: "unverified",
  },
  delivery: {
    normal: "live",
    retained: "baseline",
    observed_at: null,
    source_event_id: null,
    source_sequence: null,
    equal_values: "preserved",
  },
  connection: {
    library: "mqtt",
    version: "5.16.0",
    keepalive_seconds: 60,
    connect_timeout_ms: 15000,
    clean: true,
    automatic_reconnect: false,
  },
  subscriptions: {
    requested_qos: 2,
    accepted_qos: [0, 1, 2],
    concurrency: 16,
    timeout_ms: 10000,
    properties: "device/{did}/up/properties_changed/#",
    online: "device/{did}/state/#",
    require_notify_flag: false,
    early_messages: "deliver_without_confirming_subscription",
  },
  evidence: {
    subscription_models: [
      "yeelink.light.bslamp2",
      "cgllc.airm.cgd1st",
      "miaomiaoce.sensor_ht.t9",
      "xiaomi.sensor_occupy.p1",
    ],
    property_message_models: [
      "yeelink.light.bslamp2",
      "cgllc.airm.cgd1st",
      "xiaomi.sensor_occupy.p1",
    ],
    same_value_delivery: "verified",
    online_messages: {
      status: "scoped_verified",
      models: ["yeelink.light.bslamp2"],
    },
    offline_messages: {
      status: "scoped_verified",
      models: ["yeelink.light.bslamp2"],
    },
    independent_device_events: "not_integrated",
  },
} as const;

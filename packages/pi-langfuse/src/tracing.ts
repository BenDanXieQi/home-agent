import type {
  AgentEvent,
  ConversationId,
  SubmissionId,
} from "@earendil-works/pi-durable";

export interface ObservationAttributes {
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
  statusMessage?: string;
  completionStartTime?: Date;
  model?: string;
  modelParameters?: Record<string, string | number>;
  usageDetails?: Record<string, number>;
  costDetails?: Record<string, number>;
  version?: string;
  name?: string;
  sessionId?: string;
  userId?: string;
  tags?: string[];
}

export interface Observation {
  readonly traceId?: string | undefined;
  update(attributes: ObservationAttributes): Observation;
  updateTrace?(attributes: ObservationAttributes): Observation;
  end(endTime?: number): Observation;
}

export type ObservationType = "agent" | "generation" | "span" | "tool";

export type ObservationSource =
  | { kind: "conversation" }
  | { kind: "submission"; id: SubmissionId; requestId: string | undefined }
  | { kind: "run"; primary: SubmissionId }
  | { kind: "generation"; primary: SubmissionId }
  | {
      kind: "tool";
      primary: SubmissionId;
      call: Pick<
        Extract<AgentEvent, { type: "tool_execution_start" }>,
        | "taskId"
        | "toolCallId"
        | "toolName"
        | "parentTaskId"
        | "parentToolCallId"
      >;
    };

export interface TraceBackend {
  start(
    conversationId: ConversationId,
    source: ObservationSource,
    attributes: ObservationAttributes,
  ): Observation;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

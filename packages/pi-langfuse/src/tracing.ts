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

export interface TraceBackend {
  start(
    name: string,
    attributes: ObservationAttributes,
    options: {
      asType: ObservationType;
      parent?: Observation;
      startTime?: Date;
    },
  ): Observation;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

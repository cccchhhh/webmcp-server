import { z } from "zod";
const id = z.string().uuid();
export const tool = z
  .object({
    name: z.string().min(1).max(1024),
    description: z.string().max(8192),
    inputSchema: z.union([z.boolean(), z.record(z.string(), z.unknown())]),
    executable: z.boolean(),
    unavailableReason: z.string().max(8192).optional(),
  })
  .strict();
export const target = z
  .object({
    pageId: id,
    localPageId: id,
    documentId: z.string().min(1).max(256),
    catalogVersion: id,
  })
  .strict();
export const registration = z
  .object({
    localPageId: id,
    documentId: z.string().min(1).max(256),
    title: z.string().max(1024),
    url: z.string().url().max(8192),
    catalogVersion: id,
    tools: z.array(tool).max(200),
    authorizedToolNames: z.array(z.string().min(1).max(1024)).max(200),
    executionBlocked: z.boolean(),
  })
  .strict();
const resultCodes = z.enum([
  "RESULT_TOO_LARGE",
  "RESULT_UNSERIALIZABLE",
  "EXECUTION_UNKNOWN",
  "RESULT_RELEASED",
]);
const payload = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("AUTH"), ticket: z.string().min(1).max(256) })
    .strict(),
  z.object({ type: z.literal("REGISTER_PAGE"), page: registration }).strict(),
  z
    .object({
      type: z.literal("SYNC_CATALOG"),
      target,
      nextCatalogVersion: id,
      tools: z.array(tool).max(200),
      authorizedToolNames: z.array(z.string().min(1).max(1024)).max(200),
    })
    .strict(),
  z
    .object({
      type: z.literal("REMOVE_PAGE"),
      target,
      reason: z.string().max(1024),
    })
    .strict(),
  z
    .object({
      type: z.literal("REVOKE"),
      target,
      toolNames: z.array(z.string().max(1024)).max(200),
    })
    .strict(),
  z
    .object({
      type: z.literal("PAGE_STATE"),
      target,
      executionBlocked: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("CALL_ACK"),
      target,
      callId: id,
      accepted: z.boolean(),
      errorCode: z.string().max(128).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("CALL_RESULT"),
      target,
      callId: id,
      business: z.enum(["unclassified", "error"]),
      rawResult: z.unknown().optional(),
      errorCode: resultCodes.optional(),
      executionSettled: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("CANCEL_ACK"),
      target,
      callId: id,
      outcome: z.enum([
        "not_started",
        "unsupported",
        "requested",
        "already_settled",
      ]),
    })
    .strict(),
  z
    .object({ type: z.literal("PING"), timestamp: z.number().finite() })
    .strict(),
]);
export const ClientEnvelope = z
  .object({
    protocolVersion: z.literal(1),
    messageId: id,
    connectionEpoch: id.optional(),
    payload,
  })
  .strict();
export type Message = z.infer<typeof ClientEnvelope>;
export type Target = z.infer<typeof target>;
export type PageRegistration = z.infer<typeof registration>;
export type PageTool = z.infer<typeof tool>;

export const ServerEnvelope = z
  .object({
    protocolVersion: z.literal(1),
    messageId: id,
    connectionEpoch: id,
    payload: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("AUTH_OK"),
          deviceId: id,
          connectionEpoch: id,
        })
        .strict(),
      z.object({ type: z.literal("PAGE_REGISTERED"), target }).strict(),
      z.object({ type: z.literal("APPLIED"), replyTo: id }).strict(),
      z
        .object({
          type: z.literal("ERROR"),
          replyTo: id,
          code: z.string().max(128),
          message: z.string().max(8192),
        })
        .strict(),
      z
        .object({ type: z.literal("PONG"), timestamp: z.number().finite() })
        .strict(),
      z
        .object({
          type: z.literal("CALL"),
          target,
          callId: id,
          toolName: z.string().min(1).max(1024),
          arguments: z.record(z.string(), z.unknown()),
          deadlineAt: z.number().finite(),
        })
        .strict(),
      z
        .object({
          type: z.literal("CANCEL"),
          target,
          callId: id,
          reason: z.string().max(1024),
        })
        .strict(),
    ]),
  })
  .strict();
export type ServerMessage = z.infer<typeof ServerEnvelope>;
export type AgentCall = Extract<ServerMessage["payload"], { type: "CALL" }> & {
  epoch: string;
};
export const callInput = z
  .object({
    pageId: id,
    catalogVersion: id,
    toolName: z.string().min(1).max(1024),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();
export type CallInput = z.infer<typeof callInput>;
export const outcomeSchema = z.object({
  callId: id,
  pageId: id,
  catalogVersion: id,
  toolName: z.string(),
  delivery: z.enum(["not_sent", "sent", "acknowledged"]),
  execution: z.enum(["returned", "rejected", "unknown"]),
  business: z.enum(["unclassified", "error"]),
  rawResult: z.unknown().optional(),
  errorCode: z.string().optional(),
  message: z.string().optional(),
});
export type Outcome = z.infer<typeof outcomeSchema>;

export { ClientEnvelope as envelope };

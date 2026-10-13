export type ReplyCode = "INVALID_ARGS" | "COMMAND_FAILED";

export interface FrontReply {
  readonly message: string;
  readonly code: ReplyCode;
  readonly status: number;
}

export function notAvailable(reason: string): FrontReply {
  return {
    code: "COMMAND_FAILED",
    message: `agent-device is not available on this simlock: ${reason}`,
    status: 503,
  };
}

export function refusal(message: string, status = 400): FrontReply {
  return { code: "INVALID_ARGS", message, status };
}

export function failure(message: string, status = 502): FrontReply {
  return { code: "COMMAND_FAILED", message, status };
}

export function frontReply(reply: FrontReply, rpc: { readonly id: unknown } | undefined): Response {
  if (rpc === undefined) {
    return Response.json(
      { code: reply.code, error: reply.message, ok: false },
      { status: reply.status },
    );
  }
  return Response.json(
    {
      error: {
        code: -32000,
        data: { code: reply.code, message: reply.message },
        message: reply.message,
      },
      id: rpc.id,
      jsonrpc: "2.0",
    },
    { status: reply.status },
  );
}

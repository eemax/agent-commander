export type RuntimeControlStatus = "stopped" | "starting" | "running" | "stopping" | "failed";

export type RuntimeControlState = {
  instanceId: string | null;
  status: RuntimeControlStatus;
  pid: number | null;
  agentIds: string[];
  startedAt: string | null;
  updatedAt: string;
  stoppedAt: string | null;
  logPath: string;
  lastError: string | null;
};

export type CliCommand =
  | { name: "help" }
  | { name: "version" }
  | { name: "status" }
  | { name: "start"; rebuild: boolean }
  | { name: "stop" }
  | { name: "restart"; rebuild: boolean }
  | { name: "doctor" }
  | { name: "__runtime"; instanceId: string | null };

export type CliParseResult =
  | {
      ok: true;
      command: CliCommand;
    }
  | {
      ok: false;
      error: string;
    };

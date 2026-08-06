/* tslint:disable */
/* eslint-disable */
/**
 * 
 * @export
 * @interface AgentApprovalCapability
 */
export interface AgentApprovalCapability {
    /**
     * 
     * @type {AgentKind}
     * @memberof AgentApprovalCapability
     */
    agent: AgentKind;
    /**
     * Approval modes this CLI honours, in no particular order
     * @type {Array<ChatApprovalMode>}
     * @memberof AgentApprovalCapability
     */
    modes: Array<ChatApprovalMode>;
}


/**
 * 
 * @export
 * @interface AgentCount
 */
export interface AgentCount {
    /**
     * 
     * @type {AgentKind}
     * @memberof AgentCount
     */
    kind: AgentKind;
    /**
     * 
     * @type {number}
     * @memberof AgentCount
     */
    count: number;
}


/**
 * 
 * @export
 * @interface AgentEffortDto
 */
export interface AgentEffortDto {
    /**
     * Passed verbatim to the CLI as `--effort <id>`
     * @type {string}
     * @memberof AgentEffortDto
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof AgentEffortDto
     */
    label: string;
}

/**
 * 
 * @export
 */
export const AgentKind = {
    Claude: 'claude',
    CursorAgent: 'cursor-agent'
} as const;
export type AgentKind = typeof AgentKind[keyof typeof AgentKind];

/**
 * 
 * @export
 * @interface AgentMcpListingDto
 */
export interface AgentMcpListingDto {
    /**
     * 
     * @type {Array<AgentMcpServer>}
     * @memberof AgentMcpListingDto
     */
    servers: Array<AgentMcpServer>;
    /**
     * 
     * @type {string}
     * @memberof AgentMcpListingDto
     */
    unavailableReason: string | null;
}
/**
 * 
 * @export
 * @interface AgentMcpServer
 */
export interface AgentMcpServer {
    /**
     * 
     * @type {string}
     * @memberof AgentMcpServer
     */
    name: string;
    /**
     * 
     * @type {string}
     * @memberof AgentMcpServer
     */
    target: string | null;
    /**
     * 
     * @type {string}
     * @memberof AgentMcpServer
     */
    transport: AgentMcpServerTransportEnum | null;
    /**
     * Health as the CLI reported it; `pending` is a configured but unapproved server, `disabled` one switched off in the CLI’s own config, `needs_auth` an OAuth server nobody has signed in to yet
     * @type {string}
     * @memberof AgentMcpServer
     */
    status: AgentMcpServerStatusEnum;
    /**
     * 
     * @type {string}
     * @memberof AgentMcpServer
     */
    detail: string | null;
    /**
     * Where the server is defined; only `project` has any verified disable mechanism
     * @type {string}
     * @memberof AgentMcpServer
     */
    scope: AgentMcpServerScopeEnum;
    /**
     * Whether the next turn will leave this server out, whoever switched it off
     * @type {boolean}
     * @memberof AgentMcpServer
     */
    disabled: boolean;
    /**
     * 
     * @type {string}
     * @memberof AgentMcpServer
     */
    toggleUnavailableReason: string | null;
    /**
     * 
     * @type {string}
     * @memberof AgentMcpServer
     */
    signInUnavailableReason: string | null;
}


/**
 * @export
 */
export const AgentMcpServerTransportEnum = {
    Stdio: 'stdio',
    Http: 'http',
    Sse: 'sse'
} as const;
export type AgentMcpServerTransportEnum = typeof AgentMcpServerTransportEnum[keyof typeof AgentMcpServerTransportEnum];

/**
 * @export
 */
export const AgentMcpServerStatusEnum = {
    Connected: 'connected',
    Failed: 'failed',
    Pending: 'pending',
    Disabled: 'disabled',
    NeedsAuth: 'needs_auth',
    Unknown: 'unknown'
} as const;
export type AgentMcpServerStatusEnum = typeof AgentMcpServerStatusEnum[keyof typeof AgentMcpServerStatusEnum];

/**
 * @export
 */
export const AgentMcpServerScopeEnum = {
    Project: 'project',
    Other: 'other',
    Unknown: 'unknown'
} as const;
export type AgentMcpServerScopeEnum = typeof AgentMcpServerScopeEnum[keyof typeof AgentMcpServerScopeEnum];

/**
 * 
 * @export
 * @interface AgentModelDto
 */
export interface AgentModelDto {
    /**
     * Passed verbatim to the CLI as `--model <id>`
     * @type {string}
     * @memberof AgentModelDto
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof AgentModelDto
     */
    label: string;
    /**
     * Reported by the CLI, or our documented fallback set
     * @type {string}
     * @memberof AgentModelDto
     */
    source: AgentModelDtoSourceEnum;
}


/**
 * @export
 */
export const AgentModelDtoSourceEnum = {
    Cli: 'cli',
    Builtin: 'builtin'
} as const;
export type AgentModelDtoSourceEnum = typeof AgentModelDtoSourceEnum[keyof typeof AgentModelDtoSourceEnum];

/**
 * 
 * @export
 * @interface AgentPluginCapability
 */
export interface AgentPluginCapability {
    /**
     * 
     * @type {AgentKind}
     * @memberof AgentPluginCapability
     */
    agent: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof AgentPluginCapability
     */
    unavailableReason: string | null;
}


/**
 * 
 * @export
 * @interface AgentSkillDto
 */
export interface AgentSkillDto {
    /**
     * 
     * @type {string}
     * @memberof AgentSkillDto
     */
    name: string;
    /**
     * 
     * @type {string}
     * @memberof AgentSkillDto
     */
    description: string | null;
    /**
     * A skill directory (SKILL.md) vs a plain command file
     * @type {string}
     * @memberof AgentSkillDto
     */
    kind: AgentSkillDtoKindEnum;
    /**
     * Where it was discovered — disk scan, or the CLI session itself
     * @type {string}
     * @memberof AgentSkillDto
     */
    source: AgentSkillDtoSourceEnum;
}


/**
 * @export
 */
export const AgentSkillDtoKindEnum = {
    Skill: 'skill',
    Command: 'command'
} as const;
export type AgentSkillDtoKindEnum = typeof AgentSkillDtoKindEnum[keyof typeof AgentSkillDtoKindEnum];

/**
 * @export
 */
export const AgentSkillDtoSourceEnum = {
    Project: 'project',
    User: 'user',
    Cli: 'cli'
} as const;
export type AgentSkillDtoSourceEnum = typeof AgentSkillDtoSourceEnum[keyof typeof AgentSkillDtoSourceEnum];

/**
 * 
 * @export
 * @interface AgentTerminalCapability
 */
export interface AgentTerminalCapability {
    /**
     * 
     * @type {AgentKind}
     * @memberof AgentTerminalCapability
     */
    agent: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof AgentTerminalCapability
     */
    unavailableReason: string | null;
}



/**
 * 
 * @export
 */
export const ApprovalMode = {
    Auto: 'auto',
    Ask: 'ask',
    AcceptEdits: 'acceptEdits'
} as const;
export type ApprovalMode = typeof ApprovalMode[keyof typeof ApprovalMode];

/**
 * 
 * @export
 * @interface AttachmentDataDto
 */
export interface AttachmentDataDto {
    /**
     * 
     * @type {string}
     * @memberof AttachmentDataDto
     */
    id: string;
    /**
     * 
     * @type {AttachmentMediaType}
     * @memberof AttachmentDataDto
     */
    mediaType: AttachmentMediaType;
    /**
     * base64-encoded image bytes
     * @type {string}
     * @memberof AttachmentDataDto
     */
    data: string;
}



/**
 * 
 * @export
 */
export const AttachmentMediaType = {
    ImagePng: 'image/png',
    ImageJpeg: 'image/jpeg',
    ImageGif: 'image/gif',
    ImageWebp: 'image/webp'
} as const;
export type AttachmentMediaType = typeof AttachmentMediaType[keyof typeof AttachmentMediaType];

/**
 * 
 * @export
 * @interface CancelledDto
 */
export interface CancelledDto {
    /**
     * True when a live turn was signalled to stop
     * @type {boolean}
     * @memberof CancelledDto
     */
    cancelled: boolean;
}
/**
 * 
 * @export
 * @interface CapabilitiesDto
 */
export interface CapabilitiesDto {
    /**
     * Claude permission-mode probe verdict (acceptEdits / plan support)
     * @type {ClaudeModesCapability}
     * @memberof CapabilitiesDto
     */
    claudeModes: ClaudeModesCapability;
    /**
     * Per-CLI plugin-directory support, one entry per known agent
     * @type {Array<AgentPluginCapability>}
     * @memberof CapabilitiesDto
     */
    plugins: Array<AgentPluginCapability>;
    /**
     * Per-CLI interactive terminal-mirror support, one entry per known agent
     * @type {Array<AgentTerminalCapability>}
     * @memberof CapabilitiesDto
     */
    interactiveTerminals: Array<AgentTerminalCapability>;
    /**
     * Per-CLI tool-approval modes, one entry per known agent
     * @type {Array<AgentApprovalCapability>}
     * @memberof CapabilitiesDto
     */
    approvals: Array<AgentApprovalCapability>;
}

/**
 * 
 * @export
 */
export const ChatApprovalMode = {
    Auto: 'auto',
    Ask: 'ask',
    AcceptEdits: 'acceptEdits',
    Plan: 'plan'
} as const;
export type ChatApprovalMode = typeof ChatApprovalMode[keyof typeof ChatApprovalMode];

/**
 * 
 * @export
 * @interface ClaudeModesCapability
 */
export interface ClaudeModesCapability {
    /**
     * 
     * @type {ProbeStatus}
     * @memberof ClaudeModesCapability
     */
    acceptEdits: ProbeStatus;
    /**
     * 
     * @type {ProbeStatus}
     * @memberof ClaudeModesCapability
     */
    plan: ProbeStatus;
    /**
     * 
     * @type {string}
     * @memberof ClaudeModesCapability
     */
    version: string | null;
    /**
     * 
     * @type {number}
     * @memberof ClaudeModesCapability
     */
    probedAt: number | null;
    /**
     * 
     * @type {string}
     * @memberof ClaudeModesCapability
     */
    reason: string | null;
}


/**
 * 
 * @export
 * @interface CreateChatDto
 */
export interface CreateChatDto {
    /**
     * 
     * @type {AgentKind}
     * @memberof CreateChatDto
     */
    agentKind: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof CreateChatDto
     */
    cwd: string;
    /**
     * 
     * @type {string}
     * @memberof CreateChatDto
     */
    model?: string;
    /**
     * 
     * @type {string}
     * @memberof CreateChatDto
     */
    title?: string;
    /**
     * 
     * @type {ChatApprovalMode}
     * @memberof CreateChatDto
     */
    approval?: ChatApprovalMode;
    /**
     * 
     * @type {string}
     * @memberof CreateChatDto
     */
    effort?: string;
}


/**
 * 
 * @export
 * @interface CreateWorkflowDto
 */
export interface CreateWorkflowDto {
    /**
     * 
     * @type {string}
     * @memberof CreateWorkflowDto
     */
    slug?: string;
    /**
     * 
     * @type {Workflow}
     * @memberof CreateWorkflowDto
     */
    workflow: Workflow;
}
/**
 * 
 * @export
 * @interface DeletedDto
 */
export interface DeletedDto {
    /**
     * 
     * @type {boolean}
     * @memberof DeletedDto
     */
    deleted: boolean;
}

/**
 * 
 * @export
 */
export const EdgeKind = {
    Data: 'data',
    Call: 'call'
} as const;
export type EdgeKind = typeof EdgeKind[keyof typeof EdgeKind];

/**
 * 
 * @export
 * @interface ExportWorkflowDto
 */
export interface ExportWorkflowDto {
    /**
     * 
     * @type {string}
     * @memberof ExportWorkflowDto
     */
    path: string;
}
/**
 * 
 * @export
 * @interface ExportedDto
 */
export interface ExportedDto {
    /**
     * 
     * @type {boolean}
     * @memberof ExportedDto
     */
    exported: boolean;
}
/**
 * 
 * @export
 * @interface HandoffTargetDto
 */
export interface HandoffTargetDto {
    /**
     * Which delivery applies; anything else is unavailable
     * @type {string}
     * @memberof HandoffTargetDto
     */
    kind: HandoffTargetDtoKindEnum;
    /**
     * 
     * @type {string}
     * @memberof HandoffTargetDto
     */
    command: string | null;
    /**
     * Arguments; empty unless kind=command
     * @type {Array<string>}
     * @memberof HandoffTargetDto
     */
    args: Array<string>;
    /**
     * 
     * @type {string}
     * @memberof HandoffTargetDto
     */
    cwd: string | null;
    /**
     * 
     * @type {string}
     * @memberof HandoffTargetDto
     */
    display: string | null;
    /**
     * 
     * @type {string}
     * @memberof HandoffTargetDto
     */
    unavailableReason: string | null;
}


/**
 * @export
 */
export const HandoffTargetDtoKindEnum = {
    Command: 'command',
    Unavailable: 'unavailable'
} as const;
export type HandoffTargetDtoKindEnum = typeof HandoffTargetDtoKindEnum[keyof typeof HandoffTargetDtoKindEnum];

/**
 * 
 * @export
 * @interface ImportWorkflowDto
 */
export interface ImportWorkflowDto {
    /**
     * 
     * @type {string}
     * @memberof ImportWorkflowDto
     */
    path: string;
}
/**
 * 
 * @export
 * @interface ItemDto
 */
export interface ItemDto {
    /**
     * 
     * @type {string}
     * @memberof ItemDto
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof ItemDto
     */
    runId: string;
    /**
     * 
     * @type {string}
     * @memberof ItemDto
     */
    nodeId: string | null;
    /**
     * Monotonic per-run sequence — the replay cursor
     * @type {number}
     * @memberof ItemDto
     */
    seq: number;
    /**
     * 
     * @type {ItemKind}
     * @memberof ItemDto
     */
    kind: ItemKind;
    /**
     * 
     * @type {string}
     * @memberof ItemDto
     */
    role: string | null;
    /**
     * 
     * @type {any}
     * @memberof ItemDto
     */
    payload: any | null;
    /**
     * 
     * @type {string}
     * @memberof ItemDto
     */
    createdAt: string;
}



/**
 * 
 * @export
 */
export const ItemKind = {
    Message: 'message',
    Reasoning: 'reasoning',
    ToolCall: 'tool_call',
    ToolResult: 'tool_result',
    TurnComplete: 'turn_complete',
    TurnCancelled: 'turn_cancelled',
    Usage: 'usage',
    System: 'system',
    Error: 'error',
    Attachment: 'attachment',
    Status: 'status',
    ApprovalRequest: 'approval_request',
    ApprovalVerdict: 'approval_verdict',
    Unanswerable: 'unanswerable',
    CallStarted: 'call_started',
    CallResult: 'call_result',
    AwaitCollected: 'await_collected',
    CallQuestion: 'call_question',
    CallAnswer: 'call_answer'
} as const;
export type ItemKind = typeof ItemKind[keyof typeof ItemKind];

/**
 * 
 * @export
 * @interface NodePosition
 */
export interface NodePosition {
    /**
     * 
     * @type {number}
     * @memberof NodePosition
     */
    x: number;
    /**
     * 
     * @type {number}
     * @memberof NodePosition
     */
    y: number;
}
/**
 * 
 * @export
 * @interface NodeStateDto
 */
export interface NodeStateDto {
    /**
     * 
     * @type {string}
     * @memberof NodeStateDto
     */
    runId: string;
    /**
     * 
     * @type {string}
     * @memberof NodeStateDto
     */
    nodeId: string;
    /**
     * 
     * @type {NodeStatus}
     * @memberof NodeStateDto
     */
    status: NodeStatus;
    /**
     * 
     * @type {number}
     * @memberof NodeStateDto
     */
    startedAt: number | null;
    /**
     * 
     * @type {number}
     * @memberof NodeStateDto
     */
    endedAt: number | null;
    /**
     * 
     * @type {string}
     * @memberof NodeStateDto
     */
    error: string | null;
}



/**
 * 
 * @export
 */
export const NodeStatus = {
    Pending: 'pending',
    Running: 'running',
    Completed: 'completed',
    Failed: 'failed',
    Cancelled: 'cancelled',
    Skipped: 'skipped'
} as const;
export type NodeStatus = typeof NodeStatus[keyof typeof NodeStatus];


/**
 * 
 * @export
 */
export const ProbeStatus = {
    Pass: 'pass',
    Fail: 'fail',
    Unknown: 'unknown'
} as const;
export type ProbeStatus = typeof ProbeStatus[keyof typeof ProbeStatus];

/**
 * 
 * @export
 * @interface RenameRunDto
 */
export interface RenameRunDto {
    /**
     * 
     * @type {string}
     * @memberof RenameRunDto
     */
    title: string;
}
/**
 * 
 * @export
 * @interface RunDto
 */
export interface RunDto {
    /**
     * 
     * @type {string}
     * @memberof RunDto
     */
    id: string;
    /**
     * 
     * @type {RunStatus}
     * @memberof RunDto
     */
    status: RunStatus;
    /**
     * 
     * @type {string}
     * @memberof RunDto
     */
    title: string | null;
    /**
     * 
     * @type {AgentKind}
     * @memberof RunDto
     */
    agentKind: AgentKind | null;
    /**
     * 
     * @type {string}
     * @memberof RunDto
     */
    workflowId: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunDto
     */
    cwd: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunDto
     */
    model: string | null;
    /**
     * 
     * @type {ChatApprovalMode}
     * @memberof RunDto
     */
    approval: ChatApprovalMode | null;
    /**
     * 
     * @type {string}
     * @memberof RunDto
     */
    effort: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunDto
     */
    createdAt: string;
    /**
     * The run's last-activity time
     * @type {string}
     * @memberof RunDto
     */
    updatedAt: string;
    /**
     * 
     * @type {string}
     * @memberof RunDto
     */
    lastMessage: string | null;
}



/**
 * 
 * @export
 */
export const RunStatus = {
    Pending: 'pending',
    Running: 'running',
    Completed: 'completed',
    Failed: 'failed',
    Cancelled: 'cancelled'
} as const;
export type RunStatus = typeof RunStatus[keyof typeof RunStatus];

/**
 * 
 * @export
 * @interface RunWorkflowDto
 */
export interface RunWorkflowDto {
    /**
     * 
     * @type {string}
     * @memberof RunWorkflowDto
     */
    cwd: string;
    /**
     * 
     * @type {string}
     * @memberof RunWorkflowDto
     */
    prompt: string;
}
/**
 * 
 * @export
 * @interface SaveWorkflowDto
 */
export interface SaveWorkflowDto {
    /**
     * 
     * @type {Workflow}
     * @memberof SaveWorkflowDto
     */
    workflow: Workflow;
}
/**
 * 
 * @export
 * @interface SendMessageDto
 */
export interface SendMessageDto {
    /**
     * 
     * @type {string}
     * @memberof SendMessageDto
     */
    text: string;
    /**
     * 
     * @type {Array<SendMessageDtoImagesInner>}
     * @memberof SendMessageDto
     */
    images?: Array<SendMessageDtoImagesInner>;
}
/**
 * 
 * @export
 * @interface SendMessageDtoImagesInner
 */
export interface SendMessageDtoImagesInner {
    /**
     * 
     * @type {AttachmentMediaType}
     * @memberof SendMessageDtoImagesInner
     */
    mediaType: AttachmentMediaType;
    /**
     * base64-encoded image bytes
     * @type {string}
     * @memberof SendMessageDtoImagesInner
     */
    data: string;
}


/**
 * 
 * @export
 * @interface SetMcpServerEnabledDto
 */
export interface SetMcpServerEnabledDto {
    /**
     * 
     * @type {AgentKind}
     * @memberof SetMcpServerEnabledDto
     */
    agent: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof SetMcpServerEnabledDto
     */
    cwd: string;
    /**
     * 
     * @type {string}
     * @memberof SetMcpServerEnabledDto
     */
    server: string;
    /**
     * 
     * @type {boolean}
     * @memberof SetMcpServerEnabledDto
     */
    enabled: boolean;
}



/**
 * 
 * @export
 */
export const TriggerKind = {
    Manual: 'manual'
} as const;
export type TriggerKind = typeof TriggerKind[keyof typeof TriggerKind];

/**
 * 
 * @export
 * @interface UpdateChatSettingsDto
 */
export interface UpdateChatSettingsDto {
    /**
     * 
     * @type {ChatApprovalMode}
     * @memberof UpdateChatSettingsDto
     */
    approval?: ChatApprovalMode;
    /**
     * 
     * @type {string}
     * @memberof UpdateChatSettingsDto
     */
    model?: string | null;
    /**
     * 
     * @type {string}
     * @memberof UpdateChatSettingsDto
     */
    effort?: string | null;
}


/**
 * 
 * @export
 * @interface Workflow
 */
export interface Workflow {
    /**
     * Human-readable workflow name
     * @type {string}
     * @memberof Workflow
     */
    name: string;
    /**
     * 
     * @type {string}
     * @memberof Workflow
     */
    description?: string;
    /**
     * 
     * @type {Array<WorkflowNode>}
     * @memberof Workflow
     */
    nodes: Array<WorkflowNode>;
    /**
     * 
     * @type {Array<WorkflowEdge>}
     * @memberof Workflow
     */
    edges: Array<WorkflowEdge>;
    /**
     * 
     * @type {{ [key: string]: NodePosition; }}
     * @memberof Workflow
     */
    layout?: { [key: string]: NodePosition; };
}
/**
 * 
 * @export
 * @interface WorkflowAgentNode
 */
export interface WorkflowAgentNode {
    /**
     * Unique node id within the workflow
     * @type {string}
     * @memberof WorkflowAgentNode
     */
    id: string;
    /**
     * Display name (defaults to id)
     * @type {string}
     * @memberof WorkflowAgentNode
     */
    name?: string;
    /**
     * 
     * @type {string}
     * @memberof WorkflowAgentNode
     */
    kind: WorkflowAgentNodeKindEnum;
    /**
     * CLI agent that runs this node
     * @type {AgentKind}
     * @memberof WorkflowAgentNode
     */
    agent: AgentKind;
    /**
     * Model alias; omitted = CLI default
     * @type {string}
     * @memberof WorkflowAgentNode
     */
    model?: string;
    /**
     * What this agent does — shown to agents wired to call it
     * @type {string}
     * @memberof WorkflowAgentNode
     */
    description?: string;
    /**
     * Role/system prompt prepended to the node turn
     * @type {string}
     * @memberof WorkflowAgentNode
     */
    role?: string;
    /**
     * Tool-approval mode for this node
     * @type {ApprovalMode}
     * @memberof WorkflowAgentNode
     */
    approval: ApprovalMode;
    /**
     * Absolute path to a plugin directory loaded for this node
     * @type {string}
     * @memberof WorkflowAgentNode
     */
    pluginDir?: string;
}


/**
 * @export
 */
export const WorkflowAgentNodeKindEnum = {
    Agent: 'agent'
} as const;
export type WorkflowAgentNodeKindEnum = typeof WorkflowAgentNodeKindEnum[keyof typeof WorkflowAgentNodeKindEnum];

/**
 * 
 * @export
 * @interface WorkflowEdge
 */
export interface WorkflowEdge {
    /**
     * Source node id
     * @type {string}
     * @memberof WorkflowEdge
     */
    from: string;
    /**
     * Target node id
     * @type {string}
     * @memberof WorkflowEdge
     */
    to: string;
    /**
     * Edge kind — 'data' feeds output text; 'call' grants the call_agent tool
     * @type {EdgeKind}
     * @memberof WorkflowEdge
     */
    kind: EdgeKind;
    /**
     * Optional edge label
     * @type {string}
     * @memberof WorkflowEdge
     */
    label?: string;
}


/**
 * 
 * @export
 * @interface WorkflowFileDto
 */
export interface WorkflowFileDto {
    /**
     * 
     * @type {string}
     * @memberof WorkflowFileDto
     */
    slug: string;
    /**
     * 
     * @type {Workflow}
     * @memberof WorkflowFileDto
     */
    workflow: Workflow;
}
/**
 * @type WorkflowNode
 * 
 * @export
 */
export type WorkflowNode = WorkflowAgentNode | WorkflowTriggerNode;
/**
 * 
 * @export
 * @interface WorkflowSummaryDto
 */
export interface WorkflowSummaryDto {
    /**
     * Library file name without the .geniro.yaml suffix
     * @type {string}
     * @memberof WorkflowSummaryDto
     */
    slug: string;
    /**
     * 
     * @type {string}
     * @memberof WorkflowSummaryDto
     */
    name: string;
    /**
     * 
     * @type {string}
     * @memberof WorkflowSummaryDto
     */
    description: string | null;
    /**
     * 
     * @type {number}
     * @memberof WorkflowSummaryDto
     */
    nodeCount: number;
    /**
     * 
     * @type {number}
     * @memberof WorkflowSummaryDto
     */
    edgeCount: number;
    /**
     * Per-agent-kind node counts, only kinds present, stable order
     * @type {Array<AgentCount>}
     * @memberof WorkflowSummaryDto
     */
    agentCounts: Array<AgentCount>;
    /**
     * 
     * @type {string}
     * @memberof WorkflowSummaryDto
     */
    updatedAt: string;
}
/**
 * 
 * @export
 * @interface WorkflowTriggerNode
 */
export interface WorkflowTriggerNode {
    /**
     * Unique node id within the workflow
     * @type {string}
     * @memberof WorkflowTriggerNode
     */
    id: string;
    /**
     * Display name (defaults to id)
     * @type {string}
     * @memberof WorkflowTriggerNode
     */
    name?: string;
    /**
     * 
     * @type {string}
     * @memberof WorkflowTriggerNode
     */
    kind: WorkflowTriggerNodeKindEnum;
    /**
     * How this trigger fires
     * @type {TriggerKind}
     * @memberof WorkflowTriggerNode
     */
    trigger: TriggerKind;
}


/**
 * @export
 */
export const WorkflowTriggerNodeKindEnum = {
    Trigger: 'trigger'
} as const;
export type WorkflowTriggerNodeKindEnum = typeof WorkflowTriggerNodeKindEnum[keyof typeof WorkflowTriggerNodeKindEnum];


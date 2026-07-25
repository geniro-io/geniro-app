/* tslint:disable */
/* eslint-disable */
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
 */
export const AgentKind = {
    Claude: 'claude',
    CursorAgent: 'cursor-agent'
} as const;
export type AgentKind = typeof AgentKind[keyof typeof AgentKind];

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
     * 
     * @type {CursorCallsCapability}
     * @memberof CapabilitiesDto
     */
    cursorCalls: CursorCallsCapability;
    /**
     * Claude permission-mode probe verdict (acceptEdits / plan support)
     * @type {ClaudeModesCapability}
     * @memberof CapabilitiesDto
     */
    claudeModes: ClaudeModesCapability;
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
}


/**
 * 
 * @export
 * @interface CreateTerminalDto
 */
export interface CreateTerminalDto {
    /**
     * 
     * @type {string}
     * @memberof CreateTerminalDto
     */
    runId: string;
    /**
     * 
     * @type {string}
     * @memberof CreateTerminalDto
     */
    nodeId?: string;
    /**
     * 
     * @type {string}
     * @memberof CreateTerminalDto
     */
    sessionId?: string;
    /**
     * 
     * @type {number}
     * @memberof CreateTerminalDto
     */
    cols?: number;
    /**
     * 
     * @type {number}
     * @memberof CreateTerminalDto
     */
    rows?: number;
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
 * @interface CursorCallsCapability
 */
export interface CursorCallsCapability {
    /**
     * 
     * @type {ProbeStatus}
     * @memberof CursorCallsCapability
     */
    status: ProbeStatus;
    /**
     * 
     * @type {string}
     * @memberof CursorCallsCapability
     */
    version: string | null;
    /**
     * 
     * @type {number}
     * @memberof CursorCallsCapability
     */
    probedAt: number | null;
    /**
     * 
     * @type {string}
     * @memberof CursorCallsCapability
     */
    reason: string | null;
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
 * @interface DisposedDto
 */
export interface DisposedDto {
    /**
     * 
     * @type {boolean}
     * @memberof DisposedDto
     */
    disposed: boolean;
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
}
/**
 * 
 * @export
 * @interface TerminalSessionDto
 */
export interface TerminalSessionDto {
    /**
     * 
     * @type {string}
     * @memberof TerminalSessionDto
     */
    id: string;
    /**
     * The chat/workflow run this terminal mirrors
     * @type {string}
     * @memberof TerminalSessionDto
     */
    runId: string;
    /**
     * 
     * @type {string}
     * @memberof TerminalSessionDto
     */
    nodeId: string | null;
    /**
     * 
     * @type {string}
     * @memberof TerminalSessionDto
     */
    resumeSessionId: string | null;
    /**
     * 
     * @type {string}
     * @memberof TerminalSessionDto
     */
    cwd: string;
    /**
     * 
     * @type {TerminalStatus}
     * @memberof TerminalSessionDto
     */
    status: TerminalStatus;
    /**
     * 
     * @type {number}
     * @memberof TerminalSessionDto
     */
    exitCode: number | null;
    /**
     * 
     * @type {number}
     * @memberof TerminalSessionDto
     */
    createdAt: number;
}



/**
 * 
 * @export
 */
export const TerminalStatus = {
    Running: 'running',
    Closing: 'closing',
    Exited: 'exited'
} as const;
export type TerminalStatus = typeof TerminalStatus[keyof typeof TerminalStatus];


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
    approval: ChatApprovalMode;
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


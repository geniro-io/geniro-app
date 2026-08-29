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
 * @interface AgentCacheResetDto
 */
export interface AgentCacheResetDto {
    /**
     * How many cached CLI answers were dropped.
     * @type {number}
     * @memberof AgentCacheResetDto
     */
    cleared: number;
}
/**
 * 
 * @export
 * @interface AgentConfigDirCapability
 */
export interface AgentConfigDirCapability {
    /**
     * 
     * @type {AgentKind}
     * @memberof AgentConfigDirCapability
     */
    agent: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof AgentConfigDirCapability
     */
    unavailableReason: string | null;
}


/**
 * 
 * @export
 * @interface AgentContextWindow
 */
export interface AgentContextWindow {
    /**
     * Passed verbatim to the CLI as that model's window setting
     * @type {string}
     * @memberof AgentContextWindow
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof AgentContextWindow
     */
    label: string;
}
/**
 * 
 * @export
 * @interface AgentContextWindowListingDto
 */
export interface AgentContextWindowListingDto {
    /**
     * 
     * @type {Array<AgentContextWindow>}
     * @memberof AgentContextWindowListingDto
     */
    windows: Array<AgentContextWindow>;
    /**
     * 
     * @type {string}
     * @memberof AgentContextWindowListingDto
     */
    unavailableReason: string | null;
    /**
     * 
     * @type {AgentContextWindowUnavailableKind}
     * @memberof AgentContextWindowListingDto
     */
    unavailableKind: AgentContextWindowUnavailableKind | null;
}



/**
 * 
 * @export
 */
export const AgentContextWindowUnavailableKind = {
    NoModel: 'no-model',
    NoAxis: 'no-axis',
    FixedWindow: 'fixed-window',
    Unreadable: 'unreadable'
} as const;
export type AgentContextWindowUnavailableKind = typeof AgentContextWindowUnavailableKind[keyof typeof AgentContextWindowUnavailableKind];

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
 * @interface AgentEffort
 */
export interface AgentEffort {
    /**
     * Passed verbatim to the CLI as `--effort <id>`
     * @type {string}
     * @memberof AgentEffort
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof AgentEffort
     */
    label: string;
}
/**
 * 
 * @export
 * @interface AgentEffortListingDto
 */
export interface AgentEffortListingDto {
    /**
     * 
     * @type {Array<AgentEffort>}
     * @memberof AgentEffortListingDto
     */
    efforts: Array<AgentEffort>;
    /**
     * 
     * @type {string}
     * @memberof AgentEffortListingDto
     */
    unavailableReason: string | null;
}
/**
 * 
 * @export
 * @interface AgentFollowUpCapability
 */
export interface AgentFollowUpCapability {
    /**
     * 
     * @type {AgentKind}
     * @memberof AgentFollowUpCapability
     */
    agent: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof AgentFollowUpCapability
     */
    unavailableReason: string | null;
    /**
     * Whether a mid-turn message stops what the agent is doing
     * @type {boolean}
     * @memberof AgentFollowUpCapability
     */
    interrupts: boolean;
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
    /**
     * A cold read is running; these rows are not the answer yet. Ask again.
     * @type {boolean}
     * @memberof AgentMcpListingDto
     */
    pending: boolean;
    /**
     * 
     * @type {string}
     * @memberof AgentMcpListingDto
     */
    interactiveOnlyNote: string | null;
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
     * Health as the CLI reported it; `pending` is a configured but unapproved server, `loading` one the CLI was still dialling when it answered, `disabled` one switched off in the CLI’s own config, `needs_auth` an OAuth server nobody has signed in to yet
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
     * Which of the CLI’s configuration scopes defined this server; `unknown` when the CLI’s files could not place it
     * @type {string}
     * @memberof AgentMcpServer
     */
    scope: AgentMcpServerScopeEnum;
    /**
     * True when this WORKSPACE definition overrides a same-named user one, so the user’s own server is not what this folder loads under that name
     * @type {boolean}
     * @memberof AgentMcpServer
     */
    shadowsUser: boolean;
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
    /**
     * 
     * @type {string}
     * @memberof AgentMcpServer
     */
    approveUnavailableReason: string | null;
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
    Loading: 'loading',
    Disabled: 'disabled',
    NeedsAuth: 'needs_auth',
    Unknown: 'unknown'
} as const;
export type AgentMcpServerStatusEnum = typeof AgentMcpServerStatusEnum[keyof typeof AgentMcpServerStatusEnum];

/**
 * @export
 */
export const AgentMcpServerScopeEnum = {
    User: 'user',
    Workspace: 'workspace',
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
 * @interface AgentModelEffortCapability
 */
export interface AgentModelEffortCapability {
    /**
     * 
     * @type {AgentKind}
     * @memberof AgentModelEffortCapability
     */
    agent: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof AgentModelEffortCapability
     */
    unavailableReason: string | null;
}


/**
 * 
 * @export
 * @interface AgentModelParameter
 */
export interface AgentModelParameter {
    /**
     * The CLI’s own parameter id, sent back verbatim
     * @type {string}
     * @memberof AgentModelParameter
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof AgentModelParameter
     */
    label: string;
    /**
     * 
     * @type {Array<AgentModelParameterValue>}
     * @memberof AgentModelParameter
     */
    values: Array<AgentModelParameterValue>;
    /**
     * 
     * @type {string}
     * @memberof AgentModelParameter
     */
    current: string | null;
}
/**
 * 
 * @export
 * @interface AgentModelParameterListingDto
 */
export interface AgentModelParameterListingDto {
    /**
     * 
     * @type {Array<AgentModelParameter>}
     * @memberof AgentModelParameterListingDto
     */
    parameters: Array<AgentModelParameter>;
    /**
     * 
     * @type {string}
     * @memberof AgentModelParameterListingDto
     */
    unavailableReason: string | null;
}
/**
 * 
 * @export
 * @interface AgentModelParameterValue
 */
export interface AgentModelParameterValue {
    /**
     * Passed verbatim to the CLI as this parameter’s value
     * @type {string}
     * @memberof AgentModelParameterValue
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof AgentModelParameterValue
     */
    label: string;
}
/**
 * 
 * @export
 * @interface AgentSession
 */
export interface AgentSession {
    /**
     * The id the CLI resumes by
     * @type {string}
     * @memberof AgentSession
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof AgentSession
     */
    cwd: string | null;
    /**
     * 
     * @type {string}
     * @memberof AgentSession
     */
    title: string | null;
    /**
     * 
     * @type {number}
     * @memberof AgentSession
     */
    updatedAt: number | null;
    /**
     * 
     * @type {string}
     * @memberof AgentSession
     */
    snippet: string | null;
}
/**
 * 
 * @export
 * @interface AgentSessionListingDto
 */
export interface AgentSessionListingDto {
    /**
     * 
     * @type {Array<AgentSession>}
     * @memberof AgentSessionListingDto
     */
    sessions: Array<AgentSession>;
    /**
     * 
     * @type {string}
     * @memberof AgentSessionListingDto
     */
    unavailableReason: string | null;
    /**
     * 
     * @type {string}
     * @memberof AgentSessionListingDto
     */
    partialReason: string | null;
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
     * Where it came from — this app itself, a disk scan, or the CLI session
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
    Geniro: 'geniro',
    Project: 'project',
    User: 'user',
    Cli: 'cli'
} as const;
export type AgentSkillDtoSourceEnum = typeof AgentSkillDtoSourceEnum[keyof typeof AgentSkillDtoSourceEnum];

/**
 * 
 * @export
 * @interface AgentSubagentCapability
 */
export interface AgentSubagentCapability {
    /**
     * 
     * @type {AgentKind}
     * @memberof AgentSubagentCapability
     */
    agent: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof AgentSubagentCapability
     */
    unavailableReason: string | null;
}


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
 * @interface AgentUsageCapability
 */
export interface AgentUsageCapability {
    /**
     * 
     * @type {AgentKind}
     * @memberof AgentUsageCapability
     */
    agent: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof AgentUsageCapability
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
     * Per-CLI config-directory (profile / account) support, one entry per known agent
     * @type {Array<AgentConfigDirCapability>}
     * @memberof CapabilitiesDto
     */
    configDirs: Array<AgentConfigDirCapability>;
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
    /**
     * Per-CLI mid-turn follow-up support, one entry per known agent
     * @type {Array<AgentFollowUpCapability>}
     * @memberof CapabilitiesDto
     */
    followUps: Array<AgentFollowUpCapability>;
    /**
     * Per-CLI background sub-agent reporting, one entry per known agent
     * @type {Array<AgentSubagentCapability>}
     * @memberof CapabilitiesDto
     */
    subagents: Array<AgentSubagentCapability>;
    /**
     * Per-CLI token/cost usage reporting, one entry per known agent
     * @type {Array<AgentUsageCapability>}
     * @memberof CapabilitiesDto
     */
    usage: Array<AgentUsageCapability>;
    /**
     * Per-CLI reasoning-effort picker support, one entry per known agent
     * @type {Array<AgentModelEffortCapability>}
     * @memberof CapabilitiesDto
     */
    modelEfforts: Array<AgentModelEffortCapability>;
    /**
     * The instruction block geniro prepends to every user-facing turn, before the user’s own custom instructions
     * @type {string}
     * @memberof CapabilitiesDto
     */
    hostPreamble: string;
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
 * @interface ChatExportDto
 */
export interface ChatExportDto {
    /**
     * Shape of this document — see CHAT_EXPORT_FORMAT_VERSION
     * @type {number}
     * @memberof ChatExportDto
     */
    formatVersion: number;
    /**
     * 
     * @type {string}
     * @memberof ChatExportDto
     */
    exportedAt: string;
    /**
     * The daemon build that wrote this file, for a bug report
     * @type {string}
     * @memberof ChatExportDto
     */
    daemonVersion: string;
    /**
     * 
     * @type {ChatExportRun}
     * @memberof ChatExportDto
     */
    run: ChatExportRun;
    /**
     * 
     * @type {ChatTotals}
     * @memberof ChatExportDto
     */
    totals: ChatTotals;
    /**
     * 
     * @type {Array<ChatExportNode>}
     * @memberof ChatExportDto
     */
    nodes: Array<ChatExportNode>;
    /**
     * The COMPLETE transcript in seq order — payloads parsed back from their stored JSON, so a tool_call and its tool_result survive verbatim
     * @type {Array<ChatExportDtoItemsInner>}
     * @memberof ChatExportDto
     */
    items: Array<ChatExportDtoItemsInner>;
}
/**
 * 
 * @export
 * @interface ChatExportDtoItemsInner
 */
export interface ChatExportDtoItemsInner {
    /**
     * 
     * @type {string}
     * @memberof ChatExportDtoItemsInner
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof ChatExportDtoItemsInner
     */
    runId: string;
    /**
     * 
     * @type {string}
     * @memberof ChatExportDtoItemsInner
     */
    nodeId: string | null;
    /**
     * Monotonic per-run sequence — the replay cursor
     * @type {number}
     * @memberof ChatExportDtoItemsInner
     */
    seq: number;
    /**
     * 
     * @type {ItemKind}
     * @memberof ChatExportDtoItemsInner
     */
    kind: ItemKind;
    /**
     * 
     * @type {string}
     * @memberof ChatExportDtoItemsInner
     */
    role: string | null;
    /**
     * 
     * @type {any}
     * @memberof ChatExportDtoItemsInner
     */
    payload: any | null;
    /**
     * 
     * @type {string}
     * @memberof ChatExportDtoItemsInner
     */
    createdAt: string;
}


/**
 * 
 * @export
 * @interface ChatExportNode
 */
export interface ChatExportNode {
    /**
     * 
     * @type {string}
     * @memberof ChatExportNode
     */
    nodeId: string;
    /**
     * 
     * @type {string}
     * @memberof ChatExportNode
     */
    status: string;
    /**
     * 
     * @type {AgentKind}
     * @memberof ChatExportNode
     */
    agentKind: AgentKind | null;
    /**
     * 
     * @type {string}
     * @memberof ChatExportNode
     */
    model: string | null;
    /**
     * 
     * @type {string}
     * @memberof ChatExportNode
     */
    agentSessionId: string | null;
    /**
     * 
     * @type {number}
     * @memberof ChatExportNode
     */
    startedAt: number | null;
    /**
     * 
     * @type {number}
     * @memberof ChatExportNode
     */
    endedAt: number | null;
    /**
     * 
     * @type {string}
     * @memberof ChatExportNode
     */
    error: string | null;
}


/**
 * 
 * @export
 * @interface ChatExportRun
 */
export interface ChatExportRun {
    /**
     * 
     * @type {string}
     * @memberof ChatExportRun
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof ChatExportRun
     */
    workflowId: string | null;
    /**
     * 
     * @type {RunStatus}
     * @memberof ChatExportRun
     */
    status: RunStatus;
    /**
     * 
     * @type {string}
     * @memberof ChatExportRun
     */
    title: string | null;
    /**
     * 
     * @type {AgentKind}
     * @memberof ChatExportRun
     */
    agentKind: AgentKind | null;
    /**
     * 
     * @type {string}
     * @memberof ChatExportRun
     */
    cwd: string | null;
    /**
     * 
     * @type {string}
     * @memberof ChatExportRun
     */
    model: string | null;
    /**
     * 
     * @type {ChatApprovalMode}
     * @memberof ChatExportRun
     */
    approval: ChatApprovalMode | null;
    /**
     * 
     * @type {string}
     * @memberof ChatExportRun
     */
    effort: string | null;
    /**
     * 
     * @type {string}
     * @memberof ChatExportRun
     */
    contextWindow: string | null;
    /**
     * 
     * @type {{ [key: string]: string; }}
     * @memberof ChatExportRun
     */
    modelParameters: { [key: string]: string; };
    /**
     * 
     * @type {number}
     * @memberof ChatExportRun
     */
    contextTokens: number | null;
    /**
     * 
     * @type {number}
     * @memberof ChatExportRun
     */
    contextWindowTokens: number | null;
    /**
     * 
     * @type {string}
     * @memberof ChatExportRun
     */
    configDir: string | null;
    /**
     * 
     * @type {string}
     * @memberof ChatExportRun
     */
    groupId: string | null;
    /**
     * 
     * @type {string}
     * @memberof ChatExportRun
     */
    customInstructions: string | null;
    /**
     * 
     * @type {boolean}
     * @memberof ChatExportRun
     */
    cursorMaxMode: boolean | null;
    /**
     * 
     * @type {any}
     * @memberof ChatExportRun
     */
    lastMetricsReading: any | null;
    /**
     * 
     * @type {string}
     * @memberof ChatExportRun
     */
    pendingContext: string | null;
    /**
     * 
     * @type {string}
     * @memberof ChatExportRun
     */
    createdAt: string;
    /**
     * 
     * @type {string}
     * @memberof ChatExportRun
     */
    updatedAt: string;
}


/**
 * 
 * @export
 * @interface ChatMetricsDto
 */
export interface ChatMetricsDto {
    /**
     * 
     * @type {ContextBreakdown}
     * @memberof ChatMetricsDto
     */
    context: ContextBreakdown | null;
    /**
     * 
     * @type {string}
     * @memberof ChatMetricsDto
     */
    breakdownReason: string | null;
    /**
     * 
     * @type {PlanLimits}
     * @memberof ChatMetricsDto
     */
    plan: PlanLimits | null;
    /**
     * 
     * @type {string}
     * @memberof ChatMetricsDto
     */
    planReason: string | null;
    /**
     * 
     * @type {string}
     * @memberof ChatMetricsDto
     */
    takenAt: string | null;
    /**
     * 
     * @type {ChatTotals}
     * @memberof ChatMetricsDto
     */
    totals: ChatTotals;
}
/**
 * 
 * @export
 * @interface ChatTotals
 */
export interface ChatTotals {
    /**
     * turns that reported usage
     * @type {number}
     * @memberof ChatTotals
     */
    turns: number;
    /**
     * of those, how many reported a COST — the denominator for an average spend, since a turn on a CLI that reports no cost would otherwise dilute it
     * @type {number}
     * @memberof ChatTotals
     */
    costedTurns: number;
    /**
     * 
     * @type {number}
     * @memberof ChatTotals
     */
    costUsd: number | null;
    /**
     * 
     * @type {number}
     * @memberof ChatTotals
     */
    inputTokens: number | null;
    /**
     * 
     * @type {number}
     * @memberof ChatTotals
     */
    outputTokens: number | null;
    /**
     * 
     * @type {number}
     * @memberof ChatTotals
     */
    cacheReadTokens: number | null;
    /**
     * 
     * @type {number}
     * @memberof ChatTotals
     */
    cacheCreationTokens: number | null;
    /**
     * 
     * @type {number}
     * @memberof ChatTotals
     */
    thinkingTokens: number | null;
    /**
     * 
     * @type {number}
     * @memberof ChatTotals
     */
    workedMs: number | null;
}
/**
 * 
 * @export
 * @interface ChatTotalsDto
 */
export interface ChatTotalsDto {
    /**
     * 
     * @type {ChatTotals}
     * @memberof ChatTotalsDto
     */
    totals: ChatTotals;
}
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
 * @interface ConfigDirPin
 */
export interface ConfigDirPin {
    /**
     * The config directory the CLI will actually use
     * @type {string}
     * @memberof ConfigDirPin
     */
    effective: string;
    /**
     * The settings file that pinned it — a path the user can open
     * @type {string}
     * @memberof ConfigDirPin
     */
    source: string;
}
/**
 * 
 * @export
 * @interface ContextBreakdown
 */
export interface ContextBreakdown {
    /**
     * 
     * @type {Array<ContextCategory>}
     * @memberof ContextBreakdown
     */
    categories: Array<ContextCategory>;
    /**
     * 
     * @type {number}
     * @memberof ContextBreakdown
     */
    totalTokens: number | null;
    /**
     * 
     * @type {number}
     * @memberof ContextBreakdown
     */
    maxTokens: number | null;
    /**
     * 
     * @type {string}
     * @memberof ContextBreakdown
     */
    model: string | null;
    /**
     * 
     * @type {number}
     * @memberof ContextBreakdown
     */
    autoCompactAtTokens: number | null;
    /**
     * 
     * @type {boolean}
     * @memberof ContextBreakdown
     */
    autoCompactEnabled: boolean | null;
    /**
     * 
     * @type {Array<ContextMemoryFile>}
     * @memberof ContextBreakdown
     */
    memoryFiles: Array<ContextMemoryFile>;
    /**
     * 
     * @type {Array<ContextServer>}
     * @memberof ContextBreakdown
     */
    servers: Array<ContextServer>;
}
/**
 * 
 * @export
 * @interface ContextCategory
 */
export interface ContextCategory {
    /**
     * the CLI's own name for this part of the window
     * @type {string}
     * @memberof ContextCategory
     */
    name: string;
    /**
     * 
     * @type {number}
     * @memberof ContextCategory
     */
    tokens: number;
    /**
     * available but not loaded, and so NOT counted in totalTokens — rendering it in the same bar reports a window several times fuller than it is
     * @type {boolean}
     * @memberof ContextCategory
     */
    deferred: boolean;
}
/**
 * 
 * @export
 * @interface ContextMemoryFile
 */
export interface ContextMemoryFile {
    /**
     * 
     * @type {string}
     * @memberof ContextMemoryFile
     */
    path: string;
    /**
     * 
     * @type {string}
     * @memberof ContextMemoryFile
     */
    kind: string | null;
    /**
     * 
     * @type {number}
     * @memberof ContextMemoryFile
     */
    tokens: number;
}
/**
 * 
 * @export
 * @interface ContextServer
 */
export interface ContextServer {
    /**
     * 
     * @type {string}
     * @memberof ContextServer
     */
    name: string;
    /**
     * this server's whole tool surface, summed
     * @type {number}
     * @memberof ContextServer
     */
    tokens: number;
    /**
     * 
     * @type {number}
     * @memberof ContextServer
     */
    toolCount: number;
    /**
     * how many of them are actually in the window right now
     * @type {number}
     * @memberof ContextServer
     */
    loadedToolCount: number;
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
    /**
     * 
     * @type {string}
     * @memberof CreateChatDto
     */
    contextWindow?: string;
    /**
     * 
     * @type {{ [key: string]: string; }}
     * @memberof CreateChatDto
     */
    modelParameters?: { [key: string]: string; };
    /**
     * 
     * @type {string}
     * @memberof CreateChatDto
     */
    configDir?: string;
    /**
     * 
     * @type {string}
     * @memberof CreateChatDto
     */
    customInstructions?: string;
    /**
     * 
     * @type {boolean}
     * @memberof CreateChatDto
     */
    cursorMaxMode?: boolean;
    /**
     * 
     * @type {string}
     * @memberof CreateChatDto
     */
    resumeSessionId?: string;
}


/**
 * 
 * @export
 * @interface CreateRunGroupDto
 */
export interface CreateRunGroupDto {
    /**
     * 
     * @type {string}
     * @memberof CreateRunGroupDto
     */
    name: string;
    /**
     * 
     * @type {RunGroupColor}
     * @memberof CreateRunGroupDto
     */
    color?: RunGroupColor;
    /**
     * 
     * @type {string}
     * @memberof CreateRunGroupDto
     */
    autoCwd?: string;
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
 */
export const DebugChannel = {
    Daemon: 'daemon',
    Transcript: 'transcript',
    AgentStdio: 'agent-stdio',
    Ui: 'ui'
} as const;
export type DebugChannel = typeof DebugChannel[keyof typeof DebugChannel];

/**
 * 
 * @export
 * @interface DebugChannelsDto
 */
export interface DebugChannelsDto {
    /**
     * 
     * @type {Array<DebugChannel>}
     * @memberof DebugChannelsDto
     */
    channels: Array<DebugChannel>;
}

/**
 * 
 * @export
 */
export const DebugLevel = {
    Trace: 'trace',
    Debug: 'debug',
    Info: 'info',
    Warn: 'warn',
    Error: 'error'
} as const;
export type DebugLevel = typeof DebugLevel[keyof typeof DebugLevel];

/**
 * 
 * @export
 * @interface DebugLogPageDto
 */
export interface DebugLogPageDto {
    /**
     * 
     * @type {Array<DebugLogPageDtoEntriesInner>}
     * @memberof DebugLogPageDto
     */
    entries: Array<DebugLogPageDtoEntriesInner>;
    /**
     * 
     * @type {number}
     * @memberof DebugLogPageDto
     */
    lastSeq: number;
    /**
     * 
     * @type {number}
     * @memberof DebugLogPageDto
     */
    dropped: number;
    /**
     * 
     * @type {Array<DebugChannel>}
     * @memberof DebugLogPageDto
     */
    channels: Array<DebugChannel>;
    /**
     * 
     * @type {string}
     * @memberof DebugLogPageDto
     */
    filePath: string | null;
}
/**
 * 
 * @export
 * @interface DebugLogPageDtoEntriesInner
 */
export interface DebugLogPageDtoEntriesInner {
    /**
     * Monotonic within one daemon launch
     * @type {number}
     * @memberof DebugLogPageDtoEntriesInner
     */
    seq: number;
    /**
     * ISO timestamp
     * @type {string}
     * @memberof DebugLogPageDtoEntriesInner
     */
    at: string;
    /**
     * 
     * @type {DebugChannel}
     * @memberof DebugLogPageDtoEntriesInner
     */
    channel: DebugChannel;
    /**
     * 
     * @type {DebugLevel}
     * @memberof DebugLogPageDtoEntriesInner
     */
    level: DebugLevel;
    /**
     * 
     * @type {string}
     * @memberof DebugLogPageDtoEntriesInner
     */
    message: string;
    /**
     * 
     * @type {{ [key: string]: string; }}
     * @memberof DebugLogPageDtoEntriesInner
     */
    context: { [key: string]: string; } | null;
}


/**
 * 
 * @export
 * @interface DebugSettingsDto
 */
export interface DebugSettingsDto {
    /**
     * 
     * @type {Array<DebugChannel>}
     * @memberof DebugSettingsDto
     */
    channels: Array<DebugChannel>;
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
 * @interface DiagnosticsReportDto
 */
export interface DiagnosticsReportDto {
    /**
     * 
     * @type {string}
     * @memberof DiagnosticsReportDto
     */
    generatedAt: string;
    /**
     * 
     * @type {DiagnosticsReportDtoDaemon}
     * @memberof DiagnosticsReportDto
     */
    daemon: DiagnosticsReportDtoDaemon;
    /**
     * 
     * @type {Array<DiagnosticsReportDtoAgentsInner>}
     * @memberof DiagnosticsReportDto
     */
    agents: Array<DiagnosticsReportDtoAgentsInner>;
    /**
     * 
     * @type {DiagnosticsReportDtoRuns}
     * @memberof DiagnosticsReportDto
     */
    runs: DiagnosticsReportDtoRuns;
    /**
     * 
     * @type {Array<DebugLogPageDtoEntriesInner>}
     * @memberof DiagnosticsReportDto
     */
    recentEntries: Array<DebugLogPageDtoEntriesInner>;
}
/**
 * 
 * @export
 * @interface DiagnosticsReportDtoAgentsInner
 */
export interface DiagnosticsReportDtoAgentsInner {
    /**
     * 
     * @type {string}
     * @memberof DiagnosticsReportDtoAgentsInner
     */
    kind: string;
    /**
     * 
     * @type {string}
     * @memberof DiagnosticsReportDtoAgentsInner
     */
    binary: string;
    /**
     * 
     * @type {string}
     * @memberof DiagnosticsReportDtoAgentsInner
     */
    version: string | null;
    /**
     * 
     * @type {string}
     * @memberof DiagnosticsReportDtoAgentsInner
     */
    unavailableReason: string | null;
}
/**
 * 
 * @export
 * @interface DiagnosticsReportDtoDaemon
 */
export interface DiagnosticsReportDtoDaemon {
    /**
     * 
     * @type {string}
     * @memberof DiagnosticsReportDtoDaemon
     */
    version: string;
    /**
     * 
     * @type {number}
     * @memberof DiagnosticsReportDtoDaemon
     */
    pid: number;
    /**
     * 
     * @type {string}
     * @memberof DiagnosticsReportDtoDaemon
     */
    host: string;
    /**
     * 
     * @type {number}
     * @memberof DiagnosticsReportDtoDaemon
     */
    port: number | null;
    /**
     * 
     * @type {string}
     * @memberof DiagnosticsReportDtoDaemon
     */
    startedAt: string;
    /**
     * 
     * @type {number}
     * @memberof DiagnosticsReportDtoDaemon
     */
    uptimeSeconds: number;
    /**
     * 
     * @type {string}
     * @memberof DiagnosticsReportDtoDaemon
     */
    nodeVersion: string;
    /**
     * 
     * @type {string}
     * @memberof DiagnosticsReportDtoDaemon
     */
    platform: string;
    /**
     * 
     * @type {string}
     * @memberof DiagnosticsReportDtoDaemon
     */
    arch: string;
    /**
     * 
     * @type {string}
     * @memberof DiagnosticsReportDtoDaemon
     */
    userDataDir: string;
    /**
     * 
     * @type {string}
     * @memberof DiagnosticsReportDtoDaemon
     */
    logFilePath: string | null;
}
/**
 * 
 * @export
 * @interface DiagnosticsReportDtoRuns
 */
export interface DiagnosticsReportDtoRuns {
    /**
     * 
     * @type {number}
     * @memberof DiagnosticsReportDtoRuns
     */
    total: number;
    /**
     * 
     * @type {number}
     * @memberof DiagnosticsReportDtoRuns
     */
    running: number;
    /**
     * 
     * @type {number}
     * @memberof DiagnosticsReportDtoRuns
     */
    liveTurns: number;
    /**
     * 
     * @type {number}
     * @memberof DiagnosticsReportDtoRuns
     */
    liveSessions: number;
}

/**
 * 
 * @export
 */
export const EdgeKind = {
    Data: 'data',
    Call: 'call',
    Instruction: 'instruction'
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
 * @interface ForgottenInstructionsDto
 */
export interface ForgottenInstructionsDto {
    /**
     * Runs whose snapshotted custom instructions were cleared
     * @type {number}
     * @memberof ForgottenInstructionsDto
     */
    cleared: number;
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
     * Environment the invocation needs; empty unless kind=command. Carries the run’s config directory, which has no argv form
     * @type {{ [key: string]: string; }}
     * @memberof HandoffTargetDto
     */
    env: { [key: string]: string; };
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
    CallAnswer: 'call_answer',
    SubagentInfo: 'subagent_info',
    TaskList: 'task_list',
    ShellInfo: 'shell_info',
    ReportFindings: 'report_findings',
    ShowChart: 'show_chart',
    ShowMetrics: 'show_metrics',
    ShowComparison: 'show_comparison'
} as const;
export type ItemKind = typeof ItemKind[keyof typeof ItemKind];

/**
 * 
 * @export
 * @interface LocalImageDto
 */
export interface LocalImageDto {
    /**
     * the reference exactly as the agent wrote it — the renderer’s cache key
     * @type {string}
     * @memberof LocalImageDto
     */
    path: string;
    /**
     * 
     * @type {AttachmentMediaType}
     * @memberof LocalImageDto
     */
    mediaType: AttachmentMediaType;
    /**
     * base64-encoded image bytes
     * @type {string}
     * @memberof LocalImageDto
     */
    data: string;
}


/**
 * 
 * @export
 * @interface LoginCodeBodyDto
 */
export interface LoginCodeBodyDto {
    /**
     * 
     * @type {string}
     * @memberof LoginCodeBodyDto
     */
    code: string;
}
/**
 * 
 * @export
 * @interface LoginSession
 */
export interface LoginSession {
    /**
     * 
     * @type {string}
     * @memberof LoginSession
     */
    id: string;
    /**
     * 
     * @type {AgentKind}
     * @memberof LoginSession
     */
    agent: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof LoginSession
     */
    status: LoginSessionStatusEnum;
    /**
     * 
     * @type {string}
     * @memberof LoginSession
     */
    url: string | null;
    /**
     * 
     * @type {string}
     * @memberof LoginSession
     */
    message: string | null;
}


/**
 * @export
 */
export const LoginSessionStatusEnum = {
    Waiting: 'waiting',
    NeedsCode: 'needs_code',
    Succeeded: 'succeeded',
    Failed: 'failed',
    Cancelled: 'cancelled'
} as const;
export type LoginSessionStatusEnum = typeof LoginSessionStatusEnum[keyof typeof LoginSessionStatusEnum];

/**
 * 
 * @export
 * @interface LogoutResult
 */
export interface LogoutResult {
    /**
     * 
     * @type {AgentKind}
     * @memberof LogoutResult
     */
    agent: AgentKind;
    /**
     * 
     * @type {boolean}
     * @memberof LogoutResult
     */
    ok: boolean;
    /**
     * 
     * @type {string}
     * @memberof LogoutResult
     */
    unavailableReason: string | null;
}


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
 * @interface PlanLimits
 */
export interface PlanLimits {
    /**
     * 
     * @type {string}
     * @memberof PlanLimits
     */
    plan: string | null;
    /**
     * 
     * @type {Array<PlanWindow>}
     * @memberof PlanLimits
     */
    windows: Array<PlanWindow>;
}
/**
 * 
 * @export
 * @interface PlanWindow
 */
export interface PlanWindow {
    /**
     * the CLI's own key for the window — opaque, for keying rows
     * @type {string}
     * @memberof PlanWindow
     */
    key: string;
    /**
     * what to call it on screen
     * @type {string}
     * @memberof PlanWindow
     */
    label: string;
    /**
     * how much of the window is used, 0-100
     * @type {number}
     * @memberof PlanWindow
     */
    percent: number;
    /**
     * 
     * @type {string}
     * @memberof PlanWindow
     */
    resetsAt: string | null;
}

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
 * @interface RecheckMcpServerDto
 */
export interface RecheckMcpServerDto {
    /**
     * 
     * @type {AgentKind}
     * @memberof RecheckMcpServerDto
     */
    agent: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof RecheckMcpServerDto
     */
    cwd: string;
    /**
     * 
     * @type {string}
     * @memberof RecheckMcpServerDto
     */
    configDir?: string;
    /**
     * 
     * @type {string}
     * @memberof RecheckMcpServerDto
     */
    server: string;
}


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
 * @interface ReorderRunGroupsDto
 */
export interface ReorderRunGroupsDto {
    /**
     * 
     * @type {Array<string>}
     * @memberof ReorderRunGroupsDto
     */
    ids: Array<string>;
}

/**
 * 
 * @export
 */
export const RunAwaiting = {
    Question: 'question',
    Approval: 'approval'
} as const;
export type RunAwaiting = typeof RunAwaiting[keyof typeof RunAwaiting];

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
     * @type {RunAwaiting}
     * @memberof RunDto
     */
    awaiting: RunAwaiting | null;
    /**
     * Units of background work this run is being held for; 0 when the agent itself is working
     * @type {number}
     * @memberof RunDto
     */
    holdingFor: number;
    /**
     * Detached commands this run still has running; 0 when none are out
     * @type {number}
     * @memberof RunDto
     */
    shellsOpen: number;
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
    contextWindow: string | null;
    /**
     * Every OTHER model setting this run's next turn asks for, keyed by the CLI's own parameter id; {} when none are set. Sent back verbatim — geniro holds no vocabulary for these
     * @type {{ [key: string]: string; }}
     * @memberof RunDto
     */
    modelParameters: { [key: string]: string; };
    /**
     * 
     * @type {number}
     * @memberof RunDto
     */
    contextTokens: number | null;
    /**
     * 
     * @type {number}
     * @memberof RunDto
     */
    contextWindowTokens: number | null;
    /**
     * 
     * @type {string}
     * @memberof RunDto
     */
    configDir: string | null;
    /**
     * 
     * @type {ConfigDirPin}
     * @memberof RunDto
     */
    configDirPin: ConfigDirPin | null;
    /**
     * 
     * @type {string}
     * @memberof RunDto
     */
    groupId: string | null;
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
export const RunGroupColor = {
    Blue: 'blue',
    Purple: 'purple',
    Green: 'green',
    Orange: 'orange',
    Pink: 'pink',
    Indigo: 'indigo',
    Teal: 'teal',
    Red: 'red'
} as const;
export type RunGroupColor = typeof RunGroupColor[keyof typeof RunGroupColor];

/**
 * 
 * @export
 * @interface RunGroupDeletedDto
 */
export interface RunGroupDeletedDto {
    /**
     * True when the group row was removed
     * @type {boolean}
     * @memberof RunGroupDeletedDto
     */
    deleted: boolean;
    /**
     * How many runs moved out of the group — they are kept, never deleted with it
     * @type {number}
     * @memberof RunGroupDeletedDto
     */
    released: number;
}
/**
 * 
 * @export
 * @interface RunGroupDto
 */
export interface RunGroupDto {
    /**
     * 
     * @type {string}
     * @memberof RunGroupDto
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof RunGroupDto
     */
    name: string;
    /**
     * 
     * @type {RunGroupColor}
     * @memberof RunGroupDto
     */
    color: RunGroupColor;
    /**
     * Sidebar order, ascending and contiguous from 0
     * @type {number}
     * @memberof RunGroupDto
     */
    position: number;
    /**
     * 
     * @type {boolean}
     * @memberof RunGroupDto
     */
    collapsed: boolean;
    /**
     * 
     * @type {string}
     * @memberof RunGroupDto
     */
    autoCwd: string | null;
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
    /**
     * 
     * @type {string}
     * @memberof RunWorkflowDto
     */
    customInstructions?: string;
    /**
     * 
     * @type {boolean}
     * @memberof RunWorkflowDto
     */
    cursorMaxMode?: boolean;
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
 * @interface SetRunGroupDto
 */
export interface SetRunGroupDto {
    /**
     * 
     * @type {string}
     * @memberof SetRunGroupDto
     */
    groupId: string | null;
}
/**
 * 
 * @export
 * @interface ShellOutputDto
 */
export interface ShellOutputDto {
    /**
     * the tail of the output file, decoded as UTF-8
     * @type {string}
     * @memberof ShellOutputDto
     */
    text: string;
    /**
     * earlier output was dropped — this is the tail of a longer file
     * @type {boolean}
     * @memberof ShellOutputDto
     */
    truncated: boolean;
    /**
     * 
     * @type {string}
     * @memberof ShellOutputDto
     */
    unavailableReason: string | null;
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
 * @interface UiLogDto
 */
export interface UiLogDto {
    /**
     * 
     * @type {DebugLevel}
     * @memberof UiLogDto
     */
    level: DebugLevel;
    /**
     * 
     * @type {string}
     * @memberof UiLogDto
     */
    message: string;
    /**
     * 
     * @type {{ [key: string]: string; }}
     * @memberof UiLogDto
     */
    context?: { [key: string]: string; } | null;
}


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
    /**
     * 
     * @type {string}
     * @memberof UpdateChatSettingsDto
     */
    contextWindow?: string | null;
    /**
     * 
     * @type {{ [key: string]: string; }}
     * @memberof UpdateChatSettingsDto
     */
    modelParameters?: { [key: string]: string; } | null;
    /**
     * 
     * @type {string}
     * @memberof UpdateChatSettingsDto
     */
    configDir?: string | null;
}


/**
 * 
 * @export
 * @interface UpdateRunGroupDto
 */
export interface UpdateRunGroupDto {
    /**
     * 
     * @type {string}
     * @memberof UpdateRunGroupDto
     */
    name?: string;
    /**
     * 
     * @type {RunGroupColor}
     * @memberof UpdateRunGroupDto
     */
    color?: RunGroupColor;
    /**
     * 
     * @type {boolean}
     * @memberof UpdateRunGroupDto
     */
    collapsed?: boolean;
    /**
     * 
     * @type {string}
     * @memberof UpdateRunGroupDto
     */
    autoCwd?: string | null;
}


/**
 * 
 * @export
 * @interface UsageBucket
 */
export interface UsageBucket {
    /**
     * calendar day, YYYY-MM-DD, in local time
     * @type {string}
     * @memberof UsageBucket
     */
    date: string;
    /**
     * 
     * @type {ChatTotals}
     * @memberof UsageBucket
     */
    totals: ChatTotals;
}
/**
 * 
 * @export
 * @interface UsageGroup
 */
export interface UsageGroup {
    /**
     * 
     * @type {string}
     * @memberof UsageGroup
     */
    key: string | null;
    /**
     * 
     * @type {ChatTotals}
     * @memberof UsageGroup
     */
    totals: ChatTotals;
}
/**
 * 
 * @export
 * @interface UsageStatsDto
 */
export interface UsageStatsDto {
    /**
     * ISO-8601, inclusive
     * @type {string}
     * @memberof UsageStatsDto
     */
    from: string;
    /**
     * ISO-8601, exclusive
     * @type {string}
     * @memberof UsageStatsDto
     */
    to: string;
    /**
     * 
     * @type {ChatTotals}
     * @memberof UsageStatsDto
     */
    totals: ChatTotals;
    /**
     * every day in the range, including days with no activity
     * @type {Array<UsageBucket>}
     * @memberof UsageStatsDto
     */
    days: Array<UsageBucket>;
    /**
     * 
     * @type {Array<UsageGroup>}
     * @memberof UsageStatsDto
     */
    byAgent: Array<UsageGroup>;
    /**
     * 
     * @type {Array<UsageGroup>}
     * @memberof UsageStatsDto
     */
    byModel: Array<UsageGroup>;
    /**
     * 
     * @type {Array<UsageGroup>}
     * @memberof UsageStatsDto
     */
    byProject: Array<UsageGroup>;
    /**
     * per workflow; the null key is single-agent chats
     * @type {Array<UsageGroup>}
     * @memberof UsageStatsDto
     */
    byWorkflow: Array<UsageGroup>;
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
     * Reasoning-effort level; omitted = CLI default
     * @type {string}
     * @memberof WorkflowAgentNode
     */
    effort?: string;
    /**
     * Context-window size; omitted = the model's own default
     * @type {string}
     * @memberof WorkflowAgentNode
     */
    contextWindow?: string;
    /**
     * Other model settings, keyed by the CLI's own parameter id; omitted = the model's own defaults
     * @type {{ [key: string]: string; }}
     * @memberof WorkflowAgentNode
     */
    modelParameters?: { [key: string]: string; };
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
     * Absolute path to the agent config directory this node runs under
     * @type {string}
     * @memberof WorkflowAgentNode
     */
    configDir?: string;
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
     * Edge kind — 'data' feeds output text; 'call' grants the call_agent tool; 'instruction' appends instruction text
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
 * 
 * @export
 * @interface WorkflowInstructionNode
 */
export interface WorkflowInstructionNode {
    /**
     * Unique node id within the workflow
     * @type {string}
     * @memberof WorkflowInstructionNode
     */
    id: string;
    /**
     * Display name (defaults to id)
     * @type {string}
     * @memberof WorkflowInstructionNode
     */
    name?: string;
    /**
     * 
     * @type {string}
     * @memberof WorkflowInstructionNode
     */
    kind: WorkflowInstructionNodeKindEnum;
    /**
     * Instruction text appended to every wired agent’s turn
     * @type {string}
     * @memberof WorkflowInstructionNode
     */
    instructions: string;
}


/**
 * @export
 */
export const WorkflowInstructionNodeKindEnum = {
    Instruction: 'instruction'
} as const;
export type WorkflowInstructionNodeKindEnum = typeof WorkflowInstructionNodeKindEnum[keyof typeof WorkflowInstructionNodeKindEnum];

/**
 * @type WorkflowNode
 * 
 * @export
 */
export type WorkflowNode = WorkflowAgentNode | WorkflowInstructionNode | WorkflowTriggerNode;
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


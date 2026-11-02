export type Mode = 'bilibili';
export interface Fish { id: string; uid: string; name: string; note: string; platform: Mode; enabled: boolean; createdAt: number; anchorCount?: number; taskCount?: number; }
export interface Anchor { id: string; fishId: string; oid: string; rpid: string; root: string; type: number; message: string; url: string; source: string; createdAt: number; }
export type TaskStatus = 'queued' | 'posting' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface Task { id: string; sessionId: string; fishId: string; anchorId: string; mode: Mode; status: TaskStatus; prompt: string; payload: string; result: string; error: string; queryRpid: string; replyRpid: string; oid: string; root: string; accountUid: string; cleanupStatus: 'none' | 'pending' | 'deleting' | 'deleted' | 'failed'; cleanupError: string; cleanupAt: number; createdAt: number; updatedAt: number; sentAt: number; deadlineAt: number; nextPollAt: number; requestKey: string | null; requestHash: string; fishName?: string; uid?: string; }
export interface Session { id: string; fishId: string; title: string; createdAt: number; updatedAt: number; fishName?: string; platform?: Mode; }
export interface Message { id: string; sessionId: string; taskId: string; role: 'user' | 'assistant'; content: string; createdAt: number; }
export interface Settings { mode: Mode; pollSeconds: number; timeoutSeconds: number; cooldownSeconds: number; dailyLimit: number; autoCleanup: boolean; cleanupDelaySeconds: number; liveEnabled: boolean; }
export interface PublicSettings extends Settings { cookieConfigured: boolean; apiKeyHint: string; accountUid: string; accountName: string; }
export interface Overview { fish: Fish[]; sessions: Session[]; tasks: Task[]; settings: PublicSettings; counts: { total: number; enabled: number; completed: number; waiting: number; cleaned: number; failed: number }; }
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }

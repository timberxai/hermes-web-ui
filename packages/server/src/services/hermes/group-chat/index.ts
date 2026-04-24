import { Server, Socket, Namespace } from 'socket.io'
import type { Server as HttpServer } from 'http'
import { getToken } from '../../../services/auth'
import { getDb, ensureTable } from '../../../db'
import { AgentClients } from './agent-clients'
import { deleteSession as hermesDeleteSession } from '../hermes-cli'
import { ContextEngine } from '../context-engine/compressor'

// ─── Types ────────────────────────────────────────────────────

interface ChatMessage {
    id: string
    roomId: string
    senderId: string
    senderName: string
    content: string
    timestamp: number
}

interface RoomAgent {
    id: string
    roomId: string
    agentId: string
    profile: string
    name: string
    description: string
    invited: number
}

interface Member {
    id: string
    userId: string
    name: string
    description: string
    joinedAt: number
    online: boolean
    socketId: string
}

// ─── SQLite Storage (global DB) ──────────────────────────────

const GC_ROOMS_SCHEMA: Record<string, string> = {
    id: 'TEXT PRIMARY KEY',
    name: 'TEXT NOT NULL',
    inviteCode: 'TEXT UNIQUE',
    triggerTokens: 'INTEGER NOT NULL DEFAULT 100000',
    maxHistoryTokens: 'INTEGER NOT NULL DEFAULT 32000',
    tailMessageCount: 'INTEGER NOT NULL DEFAULT 20',
    totalTokens: 'INTEGER NOT NULL DEFAULT 0',
}

const GC_MESSAGES_SCHEMA: Record<string, string> = {
    id: 'TEXT PRIMARY KEY',
    roomId: 'TEXT NOT NULL',
    senderId: 'TEXT NOT NULL',
    senderName: 'TEXT NOT NULL',
    content: 'TEXT NOT NULL',
    timestamp: 'INTEGER NOT NULL',
}

const GC_ROOM_AGENTS_SCHEMA: Record<string, string> = {
    id: 'TEXT PRIMARY KEY',
    roomId: 'TEXT NOT NULL',
    agentId: 'TEXT NOT NULL',
    profile: 'TEXT NOT NULL',
    name: 'TEXT NOT NULL',
    description: "TEXT NOT NULL DEFAULT ''",
    invited: 'INTEGER NOT NULL DEFAULT 0',
}

const GC_CONTEXT_SNAPSHOTS_SCHEMA: Record<string, string> = {
    roomId: 'TEXT PRIMARY KEY',
    summary: 'TEXT NOT NULL DEFAULT \'\'',
    lastMessageId: 'TEXT NOT NULL',
    lastMessageTimestamp: 'INTEGER NOT NULL',
    updatedAt: 'INTEGER NOT NULL',
}

const GC_ROOM_MEMBERS_SCHEMA: Record<string, string> = {
    id: 'TEXT PRIMARY KEY',
    roomId: 'TEXT NOT NULL',
    userId: 'TEXT NOT NULL',
    userName: 'TEXT NOT NULL',
    description: "TEXT NOT NULL DEFAULT ''",
    joinedAt: 'INTEGER NOT NULL',
    updatedAt: 'INTEGER NOT NULL',
}

let _tablesEnsured = false

class ChatStorage {
    private db() { return getDb() }

    init(): void {
        if (_tablesEnsured) return
        const db = this.db()
        if (!db) return
        ensureTable('gc_rooms', GC_ROOMS_SCHEMA)
        ensureTable('gc_messages', GC_MESSAGES_SCHEMA)
        ensureTable('gc_room_agents', GC_ROOM_AGENTS_SCHEMA)
        ensureTable('gc_context_snapshots', GC_CONTEXT_SNAPSHOTS_SCHEMA)
        ensureTable('gc_room_members', GC_ROOM_MEMBERS_SCHEMA)
        // Indexes (safe to run multiple times — CREATE INDEX IF NOT EXISTS)
        try { db.exec('CREATE INDEX IF NOT EXISTS idx_gc_messages_room ON gc_messages(roomId, timestamp)') } catch { /* ignore */ }
        try { db.exec('CREATE INDEX IF NOT EXISTS idx_gc_room_agents_room ON gc_room_agents(roomId)') } catch { /* ignore */ }
        try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_gc_room_members_unique ON gc_room_members(roomId, userId)') } catch { /* ignore */ }
        _tablesEnsured = true
    }

    // ─── Rooms ────────────────────────────────────────────────

    getRoom(roomId: string): { id: string; name: string; inviteCode: string | null; triggerTokens: number; maxHistoryTokens: number; tailMessageCount: number; totalTokens: number } | undefined {
        return this.db()?.prepare('SELECT id, name, inviteCode, triggerTokens, maxHistoryTokens, tailMessageCount, totalTokens FROM gc_rooms WHERE id = ?').get(roomId) as any
    }

    getRoomByInviteCode(code: string): { id: string; name: string; inviteCode: string | null; triggerTokens: number; maxHistoryTokens: number; tailMessageCount: number; totalTokens: number } | undefined {
        return this.db()?.prepare('SELECT id, name, inviteCode, triggerTokens, maxHistoryTokens, tailMessageCount, totalTokens FROM gc_rooms WHERE inviteCode = ?').get(code) as any
    }

    getAllRooms(): { id: string; name: string; inviteCode: string | null; triggerTokens: number; maxHistoryTokens: number; tailMessageCount: number; totalTokens: number }[] {
        return (this.db()?.prepare('SELECT id, name, inviteCode, triggerTokens, maxHistoryTokens, tailMessageCount, totalTokens FROM gc_rooms ORDER BY id').all() || []) as any[]
    }

    saveRoom(id: string, name: string, inviteCode?: string, config?: { triggerTokens?: number; maxHistoryTokens?: number; tailMessageCount?: number }): void {
        this.db()?.prepare(
            'INSERT OR IGNORE INTO gc_rooms (id, name, inviteCode, triggerTokens, maxHistoryTokens, tailMessageCount) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(id, name, inviteCode || null, config?.triggerTokens ?? 100000, config?.maxHistoryTokens ?? 32000, config?.tailMessageCount ?? 20)
    }

    updateRoomConfig(roomId: string, config: { triggerTokens?: number; maxHistoryTokens?: number; tailMessageCount?: number }): void {
        const sets: string[] = []
        const vals: any[] = []
        if (config.triggerTokens !== undefined) { sets.push('triggerTokens = ?'); vals.push(config.triggerTokens) }
        if (config.maxHistoryTokens !== undefined) { sets.push('maxHistoryTokens = ?'); vals.push(config.maxHistoryTokens) }
        if (config.tailMessageCount !== undefined) { sets.push('tailMessageCount = ?'); vals.push(config.tailMessageCount) }
        if (sets.length === 0) return
        vals.push(roomId)
        this.db()?.prepare(`UPDATE gc_rooms SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
    }

    updateRoomInviteCode(roomId: string, inviteCode: string): void {
        this.db()?.prepare('UPDATE gc_rooms SET inviteCode = ? WHERE id = ?').run(inviteCode, roomId)
    }

    updateRoomTotalTokens(roomId: string, tokens: number): void {
        this.db()?.prepare('UPDATE gc_rooms SET totalTokens = ? WHERE id = ?').run(tokens, roomId)
    }

    estimateTokens(text: string): number {
        const cjk = (text.match(/[\u2e80-\u9fff\uac00-\ud7af\u3000-\u303f\uff00-\uffef]/g) || []).length
        const other = text.length - cjk
        return Math.ceil(cjk * 1.5 + other / 4)
    }

    // ─── Messages ─────────────────────────────────────────────

    getMessages(roomId: string, limit = 500): ChatMessage[] {
        const rows = (this.db()?.prepare(
            'SELECT id, roomId, senderId, senderName, content, timestamp FROM gc_messages WHERE roomId = ? ORDER BY timestamp DESC LIMIT ?'
        ).all(roomId, limit) || []) as any[]
        return rows.reverse()
    }

    addMessage(msg: ChatMessage): void {
        this.db()?.prepare(
            'INSERT INTO gc_messages (id, roomId, senderId, senderName, content, timestamp) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(msg.id, msg.roomId, msg.senderId, msg.senderName, msg.content, msg.timestamp)
    }

    pruneMessages(roomId: string, keep = 500): void {
        const db = this.db()
        if (!db) return
        const count = (db.prepare('SELECT COUNT(*) as c FROM gc_messages WHERE roomId = ?').get(roomId) as any)?.c
        if (count > keep) {
            const cutoff = db.prepare(
                'SELECT timestamp FROM gc_messages WHERE roomId = ? ORDER BY timestamp DESC LIMIT 1 OFFSET ?'
            ).get(roomId, keep - 1) as any
            if (cutoff) {
                const result = db.prepare('DELETE FROM gc_messages WHERE roomId = ? AND timestamp < ?').run(roomId, cutoff.timestamp)
                console.log(`[GroupChat] pruned ${result.changes} messages from room ${roomId} (had ${count}, keeping ${keep})`)
            }
        }
    }

    // ─── Room Agents ──────────────────────────────────────────

    getRoomAgents(roomId: string): RoomAgent[] {
        return (this.db()?.prepare(
            'SELECT id, roomId, agentId, profile, name, description, invited FROM gc_room_agents WHERE roomId = ?'
        ).all(roomId) || []) as unknown as RoomAgent[]
    }

    addRoomAgent(roomId: string, agentId: string, profile: string, name: string, description: string, invited: number): RoomAgent {
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
        this.db()?.prepare(
            'INSERT INTO gc_room_agents (id, roomId, agentId, profile, name, description, invited) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(id, roomId, agentId, profile, name, description, invited)
        return { id, roomId, agentId, profile, name, description, invited }
    }

    removeRoomAgent(agentId: string): void {
        this.db()?.prepare('DELETE FROM gc_room_agents WHERE id = ?').run(agentId)
    }

    // ─── Context Snapshots ──────────────────────────────────

    getContextSnapshot(roomId: string): { roomId: string; summary: string; lastMessageId: string; lastMessageTimestamp: number; updatedAt: number } | null {
        return (this.db()?.prepare(
            'SELECT roomId, summary, lastMessageId, lastMessageTimestamp, updatedAt FROM gc_context_snapshots WHERE roomId = ?'
        ).get(roomId) as any) ?? null
    }

    saveContextSnapshot(roomId: string, summary: string, lastMessageId: string, lastMessageTimestamp: number): void {
        this.db()?.prepare(
            'INSERT INTO gc_context_snapshots (roomId, summary, lastMessageId, lastMessageTimestamp, updatedAt) VALUES (?, ?, ?, ?, ?) ON CONFLICT(roomId) DO UPDATE SET summary = excluded.summary, lastMessageId = excluded.lastMessageId, lastMessageTimestamp = excluded.lastMessageTimestamp, updatedAt = excluded.updatedAt'
        ).run(roomId, summary, lastMessageId, lastMessageTimestamp, Date.now())
    }

    deleteContextSnapshot(roomId: string): void {
        this.db()?.prepare('DELETE FROM gc_context_snapshots WHERE roomId = ?').run(roomId)
    }

    deleteRoom(roomId: string): void {
        const db = this.db()
        if (!db) return
        db.prepare('DELETE FROM gc_messages WHERE roomId = ?').run(roomId)
        db.prepare('DELETE FROM gc_room_agents WHERE roomId = ?').run(roomId)
        db.prepare('DELETE FROM gc_room_members WHERE roomId = ?').run(roomId)
        db.prepare('DELETE FROM gc_context_snapshots WHERE roomId = ?').run(roomId)
        db.prepare('DELETE FROM gc_rooms WHERE id = ?').run(roomId)
    }

    // ─── Room Members ──────────────────────────────────────

    getRoomMembers(roomId: string): { id: string; userId: string; name: string; description: string; joinedAt: number }[] {
        return (this.db()?.prepare(
            'SELECT id, userId, userName as name, description, joinedAt FROM gc_room_members WHERE roomId = ? ORDER BY joinedAt'
        ).all(roomId) || []) as unknown as { id: string; userId: string; name: string; description: string; joinedAt: number }[]
    }

    addRoomMember(roomId: string, userId: string, userName: string, description: string): void {
        const existing = this.getMemberByUserId(roomId, userId)
        if (existing) {
            // Update name/description on rejoin, refresh updatedAt
            this.db()?.prepare(
                'UPDATE gc_room_members SET userName = ?, description = ?, updatedAt = ? WHERE roomId = ? AND userId = ?'
            ).run(userName, description, Date.now(), roomId, userId)
            return
        }
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
        const now = Date.now()
        this.db()?.prepare(
            'INSERT INTO gc_room_members (id, roomId, userId, userName, description, joinedAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(id, roomId, userId, userName, description, now, now)
    }

    getMemberByUserId(roomId: string, userId: string): Member | null {
        return (this.db()?.prepare(
            'SELECT id, userId, userName as name, description, joinedAt FROM gc_room_members WHERE roomId = ? AND userId = ?'
        ).get(roomId, userId) as any) ?? null
    }

    updateMemberActivity(roomId: string, userId: string): void {
        this.db()?.prepare(
            'UPDATE gc_room_members SET updatedAt = ? WHERE roomId = ? AND userId = ?'
        ).run(Date.now(), roomId, userId)
    }
}

// ─── ChatRoom (in-memory, for online members) ─────────────────

class ChatRoom {
    readonly id: string
    name: string
    readonly members = new Map<string, Member>()

    constructor(id: string, name?: string) {
        this.id = id
        this.name = name || id
    }

    addOrUpdateMember(socketId: string, userId: string, name: string, description: string): Member {
        const existing = this.members.get(userId)
        if (existing) {
            existing.name = name
            existing.description = description
            existing.online = true
            existing.socketId = socketId
            return existing
        }
        const member: Member = { id: socketId, userId, name, description, joinedAt: Date.now(), online: true, socketId }
        this.members.set(userId, member)
        return member
    }

    removeMember(socketId: string): void {
        for (const member of this.members.values()) {
            if (member.socketId === socketId) {
                member.online = false
                break
            }
        }
    }

    getMembersList(): Member[] {
        return Array.from(this.members.values())
    }

    getOnlineMemberBySocketId(socketId: string): Member | undefined {
        for (const member of this.members.values()) {
            if (member.socketId === socketId && member.online) return member
        }
        return undefined
    }

    hasOnlineMember(socketId: string): boolean {
        return this.getOnlineMemberBySocketId(socketId) !== undefined
    }
}

// ─── GroupChat Server ────────────────────────────────────────

export class GroupChatServer {
    private io: Server
    private nsp: Namespace
    private storage: ChatStorage
    private rooms = new Map<string, ChatRoom>()
    /** Map: socket.id → persistent userId */
    private socketUserMap = new Map<string, string>()
    /** Map: userId → { name, description } (from auth) */
    private userInfoMap = new Map<string, { name: string; description: string }>()
    readonly agentClients = new AgentClients()
    private gatewayManager: any = null
    private _contextEngine: ContextEngine | null = null
    private _restoreScheduled = false

    setGatewayManager(manager: any): void {
        this.gatewayManager = manager
        this.agentClients.setGatewayManager(manager)
        if (this._contextEngine && manager) {
            this._contextEngine.setUpstream(manager.getUpstream(''), manager.getApiKey(''))
        }
    }

    constructor(httpServer: HttpServer) {
        this.storage = new ChatStorage()
        this.storage.init()

        this.io = new Server(httpServer, {
            cors: { origin: '*' }
        })
        this.nsp = this.io.of('/group-chat')
        this.nsp.use(this.authMiddleware.bind(this))
        this.nsp.on('connection', this.onConnection.bind(this))

        // Restore persisted rooms into memory
        this.storage.getAllRooms().forEach((row) => {
            this.rooms.set(row.id, new ChatRoom(row.id, row.name))
        })

        console.log('[GroupChat] Socket.IO ready at /group-chat')

        // Initialize context engine for group chat compression
        const contextEngine = new ContextEngine({
            messageFetcher: this.storage,
            sessionCleaner: async (sessionId: string) => {
                try {
                    await hermesDeleteSession(sessionId)
                } catch (err: any) {
                    console.warn(`[GroupChat] failed to delete compression session ${sessionId}: ${err.message}`)
                }
            },
        })
        this.agentClients.setContextEngine(contextEngine)
        this.agentClients.setStorage(this.storage)
        this.agentClients.setNamespace(this.nsp)
        this._contextEngine = contextEngine

        // Restore agent connections — call restoreAgents() after server is listening
        this._restoreScheduled = false
    }

    getIO(): Server {
        return this.io
    }

    getStorage(): ChatStorage {
        return this.storage
    }

    getContextEngine(): ContextEngine | null {
        return this._contextEngine || null
    }

    getRoomIds(): string[] {
        return Array.from(this.rooms.keys())
    }

    // ─── Restore Agents ─────────────────────────────────────────

    /**
     * Restore persisted agent connections. Safe to call multiple times;
     * will only execute once.
     */
    async restoreWhenReady(): Promise<void> {
        if (this._restoreScheduled) return
        this._restoreScheduled = true
        await this.restoreAgents()
    }

    private async restoreAgents(): Promise<void> {
        const rooms = this.storage.getAllRooms()
        let total = 0

        for (const room of rooms) {
            const agents = this.storage.getRoomAgents(room.id)
            for (const agent of agents) {
                try {
                    const client = await this.agentClients.createAgent({
                        profile: agent.profile,
                        name: agent.name,
                        description: agent.description,
                        invited: agent.invited,
                    })
                    await this.agentClients.addAgentToRoom(room.id, client)
                    total++
                } catch (err: any) {
                    console.error(`[GroupChat] Failed to restore agent ${agent.name} in room ${room.id}: ${err.message}`)
                }
            }
        }

        if (total > 0) {
            console.log(`[GroupChat] Restored ${total} agent(s) across ${rooms.length} room(s)`)
        }
    }

    // ─── Auth ───────────────────────────────────────────────────

    private async authMiddleware(socket: Socket, next: (err?: Error) => void): Promise<void> {
        const authToken = await getToken()
        const token = socket.handshake.auth.token || socket.handshake.query.token || ''
        console.log(`[GroupChat] auth check: received="${token}", expected="${authToken}"`)
        if (authToken) {
            if (token !== authToken) {
                return next(new Error('Unauthorized'))
            }
        }
        next()
    }

    // ─── Connection ─────────────────────────────────────────────

    private onConnection(socket: Socket): void {
        const auth = socket.handshake.auth as { userId?: string; name?: string; description?: string }
        const userId = auth.userId || socket.id
        const userName = auth.name || `User-${userId.slice(0, 6)}`
        const description = auth.description || ''

        this.socketUserMap.set(socket.id, userId)
        this.userInfoMap.set(userId, { name: userName, description })

        console.log(`[GroupChat] Connected: ${userName} (socket=${socket.id}, user=${userId})`)

        socket.on('join', (data: { roomId?: string; name?: string }, ack?: (response?: unknown) => void) => this.handleJoin(socket, data, ack))
        socket.on('message', (data: { roomId?: string; content: string }, ack?: (response?: unknown) => void) => this.handleMessage(socket, data, ack))
        socket.on('typing', (data: { roomId?: string }) => this.handleTyping(socket, data))
        socket.on('stop_typing', (data: { roomId?: string }) => this.handleStopTyping(socket, data))
        socket.on('disconnect', () => this.handleDisconnect(socket))
    }

    // ─── Handlers ───────────────────────────────────────────────

    private handleJoin(socket: Socket, data: { roomId?: string; name?: string; description?: string }, ack?: (res: any) => void): void {
        const socketId = socket.id
        const userId = this.socketUserMap.get(socketId) || socketId
        const userInfo = this.userInfoMap.get(userId) || { name: `User-${userId.slice(0, 6)}`, description: '' }
        const userName = data.name || userInfo.name
        const description = data.description || userInfo.description

        // Update stored user info
        this.userInfoMap.set(userId, { name: userName, description })

        const roomId = data.roomId || 'general'
        let room = this.rooms.get(roomId)
        if (!room) {
            room = new ChatRoom(roomId)
            this.rooms.set(roomId, room)
            this.storage.saveRoom(roomId, roomId)
        }

        // Persist member to SQLite
        this.storage.addRoomMember(roomId, userId, userName, description)

        // Add to in-memory online members (keyed by userId)
        room.addOrUpdateMember(socketId, userId, userName, description)
        socket.join(roomId)

        socket.to(roomId).emit('member_joined', {
            roomId,
            memberId: userId,
            memberName: userName,
            members: room.getMembersList(),
        })

        // Load history from SQLite
        const messages = this.storage.getMessages(roomId)
        const agents = this.storage.getRoomAgents(roomId)

        ack?.({
            roomId,
            roomName: room.name,
            members: room.getMembersList(),
            messages,
            agents,
            rooms: this.getRoomIds(),
        })

        console.log(`[GroupChat] ${userName} (user=${userId}) joined room: ${roomId}`)
    }

    private handleMessage(socket: Socket, data: { roomId?: string; content: string }, ack?: (res: any) => void): void {
        const socketId = socket.id
        const roomId = data.roomId || 'general'
        const room = this.rooms.get(roomId)

        if (!room || !room.hasOnlineMember(socketId)) {
            ack?.({ error: 'Not in room' })
            return
        }

        const member = room.getOnlineMemberBySocketId(socketId)
        const userId = member?.userId || socketId
        const userName = member?.name || `User-${socketId.slice(0, 6)}`

        const msg: ChatMessage = {
            id: this.generateId(),
            roomId,
            senderId: userId,
            senderName: userName,
            content: data.content,
            timestamp: Date.now(),
        }

        this.storage.addMessage(msg)
        this.storage.pruneMessages(roomId)

        // Recalculate total tokens for the room
        const messages = this.storage.getMessages(roomId)
        const totalTokens = this.storage.estimateTokens(messages.map(m => m.content + m.senderName).join(''))
        this.storage.updateRoomTotalTokens(roomId, totalTokens)

        this.nsp.to(roomId).emit('message', msg)
        this.nsp.to(roomId).emit('room_updated', { roomId, totalTokens })
        ack?.({ id: msg.id })

        // Server-side @mention routing — parse mentions and invoke agents directly
        this.agentClients.processMentions(roomId, {
            content: msg.content,
            senderName: msg.senderName,
            senderId: msg.senderId,
            timestamp: msg.timestamp,
        }).catch((err) => {
            console.error(`[GroupChat] processMentions error: ${err.message}`)
        })
    }

    private handleTyping(socket: Socket, data: { roomId?: string }): void {
        const roomId = data.roomId || 'general'
        const userId = this.socketUserMap.get(socket.id) || socket.id
        const userName = this.userInfoMap.get(userId)?.name || `User-${socket.id.slice(0, 6)}`
        socket.to(roomId).emit('typing', {
            roomId,
            userId,
            userName,
        })
    }

    private handleStopTyping(socket: Socket, data: { roomId?: string }): void {
        const roomId = data.roomId || 'general'
        const userId = this.socketUserMap.get(socket.id) || socket.id
        socket.to(roomId).emit('stop_typing', {
            roomId,
            userId,
        })
    }

    private handleDisconnect(socket: Socket): void {
        const socketId = socket.id
        const userId = this.socketUserMap.get(socketId)
        const userName = userId ? this.userInfoMap.get(userId)?.name : undefined

        console.log(`[GroupChat] Disconnected: ${userName || socketId} (socket=${socketId}, user=${userId || socketId})`)

        this.leaveAllRooms(socket, socketId)
        this.socketUserMap.delete(socketId)
        // Don't delete userInfoMap — it persists across reconnects
    }

    // ─── Helpers ────────────────────────────────────────────────

    private leaveAllRooms(socket: Socket, socketId: string): void {
        this.rooms.forEach((room, rid) => {
            if (room.hasOnlineMember(socketId)) {
                const member = room.getOnlineMemberBySocketId(socketId)
                room.removeMember(socketId)
                socket.leave(rid)
                this.nsp.to(rid).emit('member_left', {
                    roomId: rid,
                    memberId: member?.userId || socketId,
                    memberName: member?.name || `User-${socketId.slice(0, 6)}`,
                    members: room.getMembersList(),
                })
            }
        })
    }

    private generateId(): string {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    }
}

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Otimizações do Socket.IO
const io = socketIo(server, {
    cors: {
        origin: process.env.NODE_ENV === 'production' 
            ? ['https://islumin-island-production.up.railway.app', 'https://*.railway.app']
            : "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 1e6, // 1MB max message size
    transports: ['websocket', 'polling'], // Prefer websocket
    allowEIO3: true
});

// Middleware
app.use(cors({
    origin: process.env.NODE_ENV === 'production' 
        ? ['https://islumin-island-production.up.railway.app', 'https://*.railway.app']
        : "*",
    credentials: true
}));
app.use(express.json({ limit: '1mb' })); // Limite de tamanho
app.use(express.static('public'));

// Estrutura de dados para salas
const rooms = new Map();
const players = new Map();

// Rate limiting por socket (evita spam)
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 1000; // 1 segundo
const MAX_UPDATES_PER_WINDOW = 20; // Máximo de atualizações por segundo

function checkRateLimit(socketId) {
    const now = Date.now();
    const limit = rateLimits.get(socketId) || { count: 0, resetTime: now + RATE_LIMIT_WINDOW };
    
    if (now > limit.resetTime) {
        limit.count = 0;
        limit.resetTime = now + RATE_LIMIT_WINDOW;
    }
    
    if (limit.count >= MAX_UPDATES_PER_WINDOW) {
        return false; // Rate limit exceeded
    }
    
    limit.count++;
    rateLimits.set(socketId, limit);
    return true;
}

// Limpeza periódica de rate limits
setInterval(() => {
    const now = Date.now();
    for (const [socketId, limit] of rateLimits.entries()) {
        if (now > limit.resetTime + 60000) { // Limpar após 1 minuto de inatividade
            rateLimits.delete(socketId);
        }
    }
}, 60000);

// Classe para gerenciar salas (otimizada)
class GameRoom {
    constructor(id, name, maxPlayers = 4) {
        this.id = id;
        this.name = name;
        this.maxPlayers = maxPlayers;
        this.players = new Map();
        this.gameState = {
            version: '1.0',
            timestamp: Date.now(),
            isMultiplayer: true,
            roomCode: id,
            players: {},
            worldState: {
                items: [],
                enemies: [],
                structures: []
            }
        };
        this.createdAt = Date.now();
        this.lastUpdate = Date.now();
        
        // Cache para reduzir processamento
        this.cachedRoomInfo = null;
        this.cacheExpiry = 0;
    }

    addPlayer(playerId, playerData) {
        if (this.players.size >= this.maxPlayers) {
            return false;
        }
        
        this.players.set(playerId, {
            id: playerId,
            name: playerData.name || `Player${this.players.size + 1}`,
            position: { x: 100, y: 100 },
            health: 100,
            hunger: 100,
            thirst: 100,
            inventory: [],
            lastSeen: Date.now(),
            lastStateUpdate: Date.now()
        });
        
        this.gameState.players[playerId] = this.players.get(playerId);
        this.invalidateCache();
        return true;
    }

    removePlayer(playerId) {
        this.players.delete(playerId);
        delete this.gameState.players[playerId];
        this.invalidateCache();
    }

    updatePlayerState(playerId, playerState) {
        if (!this.players.has(playerId)) return false;
        
        const player = this.players.get(playerId);
        const now = Date.now();
        
        // Throttling: só atualiza se passou tempo suficiente (reduz carga)
        const minUpdateInterval = 33; // ~30 updates/segundo max
        if (now - player.lastStateUpdate < minUpdateInterval) {
            return false; // Ignora atualização muito frequente
        }
        
        // Atualiza apenas campos que mudaram (delta update)
        const changedFields = {};
        for (const [key, value] of Object.entries(playerState)) {
            if (JSON.stringify(player[key]) !== JSON.stringify(value)) {
                changedFields[key] = value;
                player[key] = value;
            }
        }
        
        if (Object.keys(changedFields).length === 0) {
            return false; // Nada mudou, não precisa broadcast
        }
        
        player.lastSeen = now;
        player.lastStateUpdate = now;
        this.gameState.players[playerId] = player;
        this.lastUpdate = now;
        
        return changedFields; // Retorna apenas o que mudou
    }

    updateWorldState(worldState) {
        // Merge apenas campos que mudaram
        const oldState = this.gameState.worldState;
        this.gameState.worldState = {
            ...oldState,
            ...worldState
        };
        this.lastUpdate = Date.now();
    }

    invalidateCache() {
        this.cachedRoomInfo = null;
        this.cacheExpiry = 0;
    }

    getRoomInfo() {
        // Cache por 1 segundo para reduzir processamento
        const now = Date.now();
        if (this.cachedRoomInfo && now < this.cacheExpiry) {
            return this.cachedRoomInfo;
        }
        
        this.cachedRoomInfo = {
            id: this.id,
            name: this.name,
            maxPlayers: this.maxPlayers,
            currentPlayers: this.players.size,
            players: Array.from(this.players.values()).map(p => ({
                id: p.id,
                name: p.name
            })),
            createdAt: this.createdAt
        };
        
        this.cacheExpiry = now + 1000; // Cache por 1 segundo
        return this.cachedRoomInfo;
    }
}

// Função para gerar código de sala único (melhorado)
const usedRoomCodes = new Set();
function generateRoomCode() {
    let code;
    let attempts = 0;
    do {
        // Usa timestamp + random para garantir unicidade
        code = Date.now().toString(36).substr(-4).toUpperCase() + 
               Math.random().toString(36).substr(2, 2).toUpperCase();
        attempts++;
        if (attempts > 100) {
            // Fallback se houver muitos códigos
            code = 'ROOM' + Date.now().toString(36).toUpperCase();
            break;
        }
    } while (usedRoomCodes.has(code));
    
    usedRoomCodes.add(code);
    
    // Limpar códigos antigos periodicamente
    if (usedRoomCodes.size > 10000) {
        usedRoomCodes.clear();
    }
    
    return code;
}

// Rotas da API
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/rooms', (req, res) => {
    const roomList = Array.from(rooms.values())
        .map(room => room.getRoomInfo())
        .filter(room => room.currentPlayers > 0); // Só mostra salas com jogadores
    res.json(roomList);
});

app.post('/api/rooms', (req, res) => {
    const { name, maxPlayers = 4 } = req.body;
    
    // Validação
    if (maxPlayers < 2 || maxPlayers > 8) {
        return res.status(400).json({ error: 'maxPlayers deve estar entre 2 e 8' });
    }
    
    if (name && name.length > 50) {
        return res.status(400).json({ error: 'Nome da sala muito longo' });
    }
    
    const roomId = generateRoomCode();
    const room = new GameRoom(roomId, name || `Sala ${roomId}`, maxPlayers);
    rooms.set(roomId, room);
    
    // Broadcast new room to all connected clients (throttled)
    io.emit('room-created', room.getRoomInfo());
    
    res.json({
        success: true,
        room: room.getRoomInfo()
    });
});

// Heartbeat para detectar conexões mortas
const heartbeats = new Map();
const HEARTBEAT_TIMEOUT = 30000; // 30 segundos

setInterval(() => {
    const now = Date.now();
    for (const [socketId, lastHeartbeat] of heartbeats.entries()) {
        if (now - lastHeartbeat > HEARTBEAT_TIMEOUT) {
            // Conexão morta, remover
            const player = players.get(socketId);
            if (player) {
                const room = rooms.get(player.roomId);
                if (room) {
                    room.removePlayer(socketId);
                    io.to(player.roomId).emit('player-left', {
                        playerId: socketId,
                        playerName: player.playerName
                    });
                }
                players.delete(socketId);
            }
            heartbeats.delete(socketId);
            rateLimits.delete(socketId);
        }
    }
}, 10000); // Verifica a cada 10 segundos

// WebSocket connections
io.on('connection', (socket) => {
    console.log(`[+] Cliente conectado: ${socket.id}`);
    heartbeats.set(socket.id, Date.now());
    
    socket.on('heartbeat', () => {
        heartbeats.set(socket.id, Date.now());
    });
    
    socket.on('join-room', (data) => {
        // Validação de entrada
        if (!data || !data.roomId || !data.playerName) {
            socket.emit('error', { message: 'Dados inválidos' });
            return;
        }
        
        if (data.playerName.length > 20) {
            socket.emit('error', { message: 'Nome muito longo (máx 20 caracteres)' });
            return;
        }
        
        const { roomId, playerName } = data;
        const room = rooms.get(roomId);
        
        if (!room) {
            socket.emit('error', { message: 'Sala não encontrada' });
            return;
        }
        
        if (!room.addPlayer(socket.id, { name: playerName })) {
            socket.emit('error', { message: 'Sala cheia' });
            return;
        }
        
        socket.join(roomId);
        players.set(socket.id, { roomId, playerName });
        heartbeats.set(socket.id, Date.now());
        
        socket.emit('room-joined', {
            room: room.getRoomInfo(),
            gameState: room.gameState,
            worldState: room.gameState.worldState,
            existingPlayers: Array.from(room.players.entries())
                .filter(([id]) => id !== socket.id) // Não incluir a si mesmo
                .map(([id, player]) => ({
                    id: id,
                    name: player.name,
                    position: player.position,
                    health: player.health,
                    hunger: player.hunger,
                    thirst: player.thirst
                }))
        });
        
        socket.to(roomId).emit('player-joined', {
            player: { id: socket.id, name: playerName }
        });
        
        console.log(`[+] ${playerName} entrou na sala ${roomId}`);
    });
    
    socket.on('update-player-state', (data) => {
        // Rate limiting
        if (!checkRateLimit(socket.id)) {
            return; // Ignora se excedeu o limite
        }
        
        // Validação básica
        if (!data || typeof data !== 'object') {
            return;
        }
        
        const player = players.get(socket.id);
        if (!player) return;
        
        const room = rooms.get(player.roomId);
        if (!room) return;
        
        // Atualiza e retorna apenas o que mudou
        const changedFields = room.updatePlayerState(socket.id, data);
        
        if (changedFields) {
            // Broadcast apenas campos que mudaram (delta update)
            socket.to(player.roomId).emit('player-state-updated', {
                playerId: socket.id,
                state: changedFields // Envia apenas mudanças
            });
        }
        
        heartbeats.set(socket.id, Date.now());
    });

    socket.on('update-world-state', (data) => {
        // Rate limiting mais restritivo para world state
        if (!checkRateLimit(socket.id)) {
            return;
        }
        
        const player = players.get(socket.id);
        if (!player) return;
        
        const room = rooms.get(player.roomId);
        if (!room) return;
        
        room.updateWorldState(data);
        
        // Broadcast world state to all players in room
        io.to(player.roomId).emit('world-state-updated', data);
        
        heartbeats.set(socket.id, Date.now());
    });
    
    socket.on('chat-message', (data) => {
        // Validação de mensagem
        if (!data || !data.message || typeof data.message !== 'string') {
            return;
        }
        
        if (data.message.length > 200) {
            socket.emit('error', { message: 'Mensagem muito longa' });
            return;
        }
        
        const player = players.get(socket.id);
        if (!player) return;
        
        const room = rooms.get(player.roomId);
        if (!room) return;
        
        const message = {
            id: Date.now(),
            playerId: socket.id,
            playerName: player.playerName,
            message: data.message.substring(0, 200), // Garante limite
            timestamp: Date.now()
        };
        
        io.to(player.roomId).emit('chat-message', message);
        heartbeats.set(socket.id, Date.now());
    });
    
    socket.on('disconnect', () => {
        const player = players.get(socket.id);
        if (player) {
            const room = rooms.get(player.roomId);
            if (room) {
                room.removePlayer(socket.id);
                socket.to(player.roomId).emit('player-left', {
                    playerId: socket.id,
                    playerName: player.playerName
                });
                
                // Se a sala ficar vazia, remover após 2 minutos (reduzido de 5)
                if (room.players.size === 0) {
                    setTimeout(() => {
                        if (room.players.size === 0) {
                            rooms.delete(player.roomId);
                            usedRoomCodes.delete(player.roomId);
                            console.log(`[-] Sala ${player.roomId} removida (vazia)`);
                        }
                    }, 2 * 60 * 1000);
                }
            }
            players.delete(socket.id);
        }
        
        heartbeats.delete(socket.id);
        rateLimits.delete(socket.id);
        console.log(`[-] Cliente desconectado: ${socket.id}`);
    });
});

// Limpeza periódica de salas vazias (otimizada)
setInterval(() => {
    const now = Date.now();
    const roomsToDelete = [];
    
    for (const [roomId, room] of rooms.entries()) {
        if (room.players.size === 0 && now - room.createdAt > 5 * 60 * 1000) {
            roomsToDelete.push(roomId);
        }
    }
    
    roomsToDelete.forEach(roomId => {
        rooms.delete(roomId);
        usedRoomCodes.delete(roomId);
        console.log(`[-] Sala ${roomId} removida (timeout)`);
    });
}, 60000); // A cada minuto

// Estatísticas do servidor (opcional, para monitoramento)
let serverStats = {
    totalConnections: 0,
    currentConnections: 0,
    roomsCreated: 0,
    messagesSent: 0
};

io.on('connection', () => {
    serverStats.totalConnections++;
    serverStats.currentConnections = io.engine.clientsCount;
});

io.on('disconnect', () => {
    serverStats.currentConnections = io.engine.clientsCount;
});

app.get('/api/stats', (req, res) => {
    res.json({
        ...serverStats,
        currentConnections: io.engine.clientsCount,
        activeRooms: rooms.size,
        totalPlayers: players.size
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`[*] Servidor rodando na porta ${PORT}`);
    console.log(`[*] Modo: ${process.env.NODE_ENV || 'development'}`);
    console.log(`[*] Otimizações: Rate limiting, Delta updates, Caching, Heartbeat`);
});

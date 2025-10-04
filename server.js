const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Estrutura de dados para salas
const rooms = new Map();
const players = new Map();

// Classe para gerenciar salas
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
                structures: [],
                entities: [], // Server-authoritative entities
                generatedMap: {}, // Server-authoritative map
                gameTick: 0,
                currentGameTime: 0,
                temperature: 20,
                weather: 'clear',
                weatherTimer: 0
            }
        };
        this.createdAt = Date.now();
        this.lastWorldUpdate = Date.now();
        this.worldUpdateInterval = 100; // 10 FPS for world updates
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
            lastSeen: Date.now()
        });
        
        this.gameState.players[playerId] = this.players.get(playerId);
        return true;
    }

    removePlayer(playerId) {
        this.players.delete(playerId);
        delete this.gameState.players[playerId];
    }

    updatePlayerState(playerId, playerState) {
        if (this.players.has(playerId)) {
            const player = this.players.get(playerId);
            Object.assign(player, playerState);
            player.lastSeen = Date.now();
            this.gameState.players[playerId] = player;
        }
    }

    updateWorldState(worldState) {
        // Update shared world state (weather, time, etc.)
        this.gameState.worldState = {
            ...this.gameState.worldState,
            ...worldState
        };
    }

    // Server-authoritative world updates
    updateWorld() {
        const now = Date.now();
        if (now - this.lastWorldUpdate >= this.worldUpdateInterval) {
            // Increment game tick
            this.gameState.worldState.gameTick++;
            
            // Update time cycle
            this.gameState.worldState.currentGameTime = (this.gameState.worldState.currentGameTime + 1) % 1440; // 24 minutes = 1 day
            
            // Spawn entities occasionally
            if (this.gameState.worldState.gameTick % 200 === 0) {
                this.spawnRandomEntity();
            }
            
            // Update entities
            this.updateEntities();
            
            // Broadcast world state to all players
            this.broadcastWorldState();
            
            this.lastWorldUpdate = now;
        }
    }

    spawnRandomEntity() {
        // Simple entity spawning for now
        const entityTypes = ['wolf', 'boar', 'deer'];
        const entityType = entityTypes[Math.floor(Math.random() * entityTypes.length)];
        
        const entity = {
            id: `entity_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            type: entityType,
            worldX: Math.random() * 5000 - 2500,
            worldY: Math.random() * 5000 - 2500,
            health: 100,
            maxHealth: 100,
            isAggressive: entityType === 'wolf' || entityType === 'boar',
            state: 'idle',
            animationFrame: 0,
            animationTimer: 0
        };
        
        this.gameState.worldState.entities.push(entity);
        console.log(`[ROOM ${this.id}] Spawned ${entityType} at (${entity.worldX}, ${entity.worldY})`);
    }

    updateEntities() {
        // Simple entity AI and movement
        this.gameState.worldState.entities.forEach(entity => {
            if (entity.health <= 0) return;
            
            // Simple random movement
            if (Math.random() < 0.1) { // 10% chance to move
                entity.worldX += (Math.random() - 0.5) * 10;
                entity.worldY += (Math.random() - 0.5) * 10;
                
                // Keep entities within reasonable bounds
                entity.worldX = Math.max(-2500, Math.min(2500, entity.worldX));
                entity.worldY = Math.max(-2500, Math.min(2500, entity.worldY));
            }
            
            // Update animation
            entity.animationTimer++;
            if (entity.animationTimer > 30) {
                entity.animationFrame = (entity.animationFrame + 1) % 4;
                entity.animationTimer = 0;
            }
        });
        
        // Remove dead entities after some time
        this.gameState.worldState.entities = this.gameState.worldState.entities.filter(entity => {
            if (entity.health <= 0) {
                entity.deathTimer = (entity.deathTimer || 0) + 1;
                return entity.deathTimer < 300; // Remove after 30 seconds
            }
            return true;
        });
    }

    broadcastWorldState() {
        if (this.players.size > 0) {
            io.to(this.id).emit('world-state-updated', {
                gameTick: this.gameState.worldState.gameTick,
                currentGameTime: this.gameState.worldState.currentGameTime,
                temperature: this.gameState.worldState.temperature,
                weather: this.gameState.worldState.weather,
                weatherTimer: this.gameState.worldState.weatherTimer,
                entities: this.gameState.worldState.entities,
                generatedMap: this.gameState.worldState.generatedMap,
                timestamp: Date.now()
            });
        }
    }

    getRoomInfo() {
        return {
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
    }
}

// Função para gerar código de sala único
function generateRoomCode() {
    return Math.random().toString(36).substr(2, 6).toUpperCase();
}

// Rotas da API
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/rooms', (req, res) => {
    const roomList = Array.from(rooms.values()).map(room => room.getRoomInfo());
    res.json(roomList);
});

app.post('/api/rooms', (req, res) => {
    const { name, maxPlayers = 4 } = req.body;
    const roomId = generateRoomCode();
    const room = new GameRoom(roomId, name || `Sala ${roomId}`, maxPlayers);
    rooms.set(roomId, room);
    
    // Broadcast new room to all connected clients
    io.emit('room-created', room.getRoomInfo());
    
    res.json({
        success: true,
        room: room.getRoomInfo()
    });
});

// WebSocket connections
io.on('connection', (socket) => {
    console.log(`[+] Cliente conectado: ${socket.id}`);
    
    socket.on('join-room', (data) => {
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
        
        socket.emit('room-joined', {
            room: room.getRoomInfo(),
            gameState: room.gameState,
            worldState: room.gameState.worldState,
            existingPlayers: Array.from(room.players.entries()).map(([id, player]) => ({
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
        const player = players.get(socket.id);
        if (!player) return;
        
        const room = rooms.get(player.roomId);
        if (!room) return;
        
        room.updatePlayerState(socket.id, data);
        
        // Broadcast para outros jogadores na sala
        socket.to(player.roomId).emit('player-state-updated', {
            playerId: socket.id,
            state: data
        });
    });

    socket.on('update-world-state', (data) => {
        const player = players.get(socket.id);
        if (!player) return;
        
        const room = rooms.get(player.roomId);
        if (!room) return;
        
        room.updateWorldState(data);
        
        // Broadcast world state to all players in room
        io.to(player.roomId).emit('world-state-updated', data);
    });
    
    socket.on('chat-message', (data) => {
        const player = players.get(socket.id);
        if (!player) return;
        
        const room = rooms.get(player.roomId);
        if (!room) return;
        
        const message = {
            id: Date.now(),
            playerId: socket.id,
            playerName: player.playerName,
            message: data.message,
            timestamp: Date.now()
        };
        
        io.to(player.roomId).emit('chat-message', message);
    });
    
    // Combat event handlers with server validation
    socket.on('damage-request', (data) => {
        const player = players.get(socket.id);
        if (!player) return;
        
        const room = rooms.get(player.roomId);
        if (!room) return;
        
        // Find entity in room's world state
        const entity = room.gameState.worldState.entities.find(e => e.id === data.entityId);
        if (!entity || entity.health <= 0) return;
        
        // Validate damage request
        const damage = Math.max(1, Math.min(100, data.damage || 10)); // Limit damage between 1-100
        const attackerName = player.playerName;
        
        // Apply damage to entity
        entity.health = Math.max(0, entity.health - damage);
        entity.isHit = true;
        entity.hitTimer = 50; // 50 frames of hit feedback
        
        // Check if entity died
        if (entity.health <= 0) {
            entity.state = 'dead';
            entity.deathTimer = 0;
            
            // Broadcast entity death
            io.to(player.roomId).emit('entity-died', {
                entityId: data.entityId,
                entityType: entity.type,
                worldX: entity.worldX,
                worldY: entity.worldY,
                drop: entity.drop,
                killerId: socket.id,
                killerName: attackerName
            });
            
            console.log(`[COMBAT] ${attackerName} eliminou ${entity.type} (ID: ${data.entityId})`);
        } else {
            // Broadcast damage applied
            io.to(player.roomId).emit('damage-applied', {
                entityId: data.entityId,
                damage: damage,
                attackerId: socket.id,
                attackerName: attackerName,
                timestamp: Date.now()
            });
            
            console.log(`[COMBAT] ${attackerName} causou ${damage} de dano à entidade ${data.entityId}`);
        }
    });
    
    socket.on('entity-died', (data) => {
        const player = players.get(socket.id);
        if (!player) return;
        
        const room = rooms.get(player.roomId);
        if (!room) return;
        
        // Broadcast entity death to all players in room
        io.to(player.roomId).emit('entity-died', {
            ...data,
            killerId: socket.id,
            killerName: player.playerName
        });
        
        console.log(`[COMBAT] ${player.playerName} matou entidade ${data.entityType} (ID: ${data.entityId})`);
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
                
                // Se a sala ficar vazia, remover após 5 minutos
                if (room.players.size === 0) {
                    setTimeout(() => {
                        if (room.players.size === 0) {
                            rooms.delete(player.roomId);
                            console.log(`[-] Sala ${player.roomId} removida (vazia)`);
                        }
                    }, 5 * 60 * 1000);
                }
            }
            players.delete(socket.id);
        }
        
        console.log(`[-] Cliente desconectado: ${socket.id}`);
    });
});

// Limpeza periódica de salas vazias
setInterval(() => {
    const now = Date.now();
    for (const [roomId, room] of rooms.entries()) {
        if (room.players.size === 0 && now - room.createdAt > 10 * 60 * 1000) {
            rooms.delete(roomId);
            console.log(`[-] Sala ${roomId} removida (timeout)`);
        }
    }
}, 60000); // A cada minuto

// Server-side world update loop
setInterval(() => {
    rooms.forEach(room => {
        if (room.players.size > 0) {
            room.updateWorld();
        }
    });
}, 100); // 10 FPS world updates

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`[*] Servidor rodando na porta ${PORT}`);
    console.log(`[*] Modo: ${process.env.NODE_ENV || 'development'}`);
});

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
        
        // Initialize map if this is the first player
        if (this.players.size === 0) {
            this.initializeMap();
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

    // Initialize room with generated map
    initializeMap() {
        console.log(`[ROOM ${this.id}] Initializing map...`);
        
        // Generate terrain tiles
        this.generateTerrain();
        
        // Generate resources (trees, stones, bushes)
        this.generateResources();
        
        // Spawn initial entities
        this.spawnInitialEntities();
        
        // Generate special structures
        this.generateStructures();
        
        console.log(`[ROOM ${this.id}] Map initialized with ${this.gameState.worldState.entities.length} entities`);
    }

    generateTerrain() {
        // Generate base terrain using simple noise
        const mapSize = 100; // 100x100 tiles
        const tileSize = 64; // 64px per tile
        
        for (let x = -mapSize/2; x < mapSize/2; x++) {
            for (let y = -mapSize/2; y < mapSize/2; y++) {
                const worldX = x * tileSize;
                const worldY = y * tileSize;
                
                // Simple noise for terrain type
                const noise = this.simpleNoise(x, y);
                let terrainType = 'grass';
                
                if (noise < 0.3) {
                    terrainType = 'water';
                } else if (noise > 0.7) {
                    terrainType = 'dirt';
                } else if (noise > 0.8) {
                    terrainType = 'sand';
                }
                
                const tileKey = `${x},${y}`;
                this.gameState.worldState.generatedMap[tileKey] = {
                    terrainType: terrainType,
                    worldX: worldX,
                    worldY: worldY,
                    hasTree: false,
                    hasStone: false,
                    hasBush: false,
                    treeType: null,
                    treeGrowth: 0
                };
            }
        }
    }

    generateResources() {
        const mapSize = 100;
        const tileSize = 64;
        
        // Generate trees
        for (let x = -mapSize/2; x < mapSize/2; x++) {
            for (let y = -mapSize/2; y < mapSize/2; y++) {
                const tileKey = `${x},${y}`;
                const tile = this.gameState.worldState.generatedMap[tileKey];
                
                if (!tile || tile.terrainType === 'water') continue;
                
                // Tree generation chance
                if (Math.random() < 0.15) { // 15% chance
                    const treeTypes = ['oak', 'pine', 'apple'];
                    const treeType = treeTypes[Math.floor(Math.random() * treeTypes.length)];
                    
                    tile.hasTree = true;
                    tile.treeType = treeType;
                    tile.treeGrowth = Math.random() > 0.5 ? 100 : Math.random() * 100; // Some trees fully grown
                }
                
                // Stone generation
                if (Math.random() < 0.05) { // 5% chance
                    tile.hasStone = true;
                }
                
                // Bush generation
                if (Math.random() < 0.08 && !tile.hasTree) { // 8% chance, no overlap with trees
                    tile.hasBush = true;
                }
            }
        }
    }

    spawnInitialEntities() {
        const entityTypes = [
            { type: 'wolf', count: 8, health: 80, damage: 15 },
            { type: 'boar', count: 12, health: 100, damage: 10 },
            { type: 'deer', count: 15, health: 60, damage: 5 },
            { type: 'rabbit', count: 20, health: 30, damage: 2 }
        ];
        
        entityTypes.forEach(entityConfig => {
            for (let i = 0; i < entityConfig.count; i++) {
                this.spawnEntity(entityConfig.type, entityConfig.health, entityConfig.damage);
            }
        });
    }

    spawnEntity(type, health, damage) {
        const tileSize = 64;
        const mapSize = 100;
        
        // Find valid spawn position (not in water)
        let attempts = 0;
        let validPosition = null;
        
        while (attempts < 50 && !validPosition) {
            const x = Math.floor(Math.random() * mapSize) - mapSize/2;
            const y = Math.floor(Math.random() * mapSize) - mapSize/2;
            const tileKey = `${x},${y}`;
            const tile = this.gameState.worldState.generatedMap[tileKey];
            
            if (tile && tile.terrainType !== 'water') {
                validPosition = {
                    worldX: tile.worldX + Math.random() * tileSize - tileSize/2,
                    worldY: tile.worldY + Math.random() * tileSize - tileSize/2
                };
            }
            attempts++;
        }
        
        if (validPosition) {
            const entity = {
                id: `entity_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                type: type,
                worldX: validPosition.worldX,
                worldY: validPosition.worldY,
                health: health,
                maxHealth: health,
                damage: damage,
                isAggressive: type === 'wolf' || type === 'boar',
                state: 'idle',
                animationFrame: 0,
                animationTimer: 0,
                attackRange: 80,
                attackCooldown: 60,
                attackCooldownTimer: 0,
                drop: this.getEntityDrop(type)
            };
            
            this.gameState.worldState.entities.push(entity);
        }
    }

    getEntityDrop(type) {
        const drops = {
            'wolf': 'wolf_pelt',
            'boar': 'meat',
            'deer': 'deer_meat',
            'rabbit': 'rabbit_fur'
        };
        return drops[type] || null;
    }

    generateStructures() {
        // Generate some special structures
        const structures = [
            { type: 'abandoned_house', count: 3 },
            { type: 'cave_entrance', count: 2 },
            { type: 'treasure_chest', count: 5 }
        ];
        
        structures.forEach(structConfig => {
            for (let i = 0; i < structConfig.count; i++) {
                const x = Math.floor(Math.random() * 80) - 40;
                const y = Math.floor(Math.random() * 80) - 40;
                const tileKey = `${x},${y}`;
                const tile = this.gameState.worldState.generatedMap[tileKey];
                
                if (tile && tile.terrainType !== 'water') {
                    tile.structure = structConfig.type;
                }
            }
        });
    }

    simpleNoise(x, y) {
        // Simple pseudo-random noise function
        const a = Math.sin(x * 0.1) * 10000;
        const b = Math.sin(y * 0.1) * 10000;
        return ((a + b) % 10000) / 10000;
    }

    spawnRandomEntity() {
        // Spawn new entities occasionally
        const entityTypes = ['wolf', 'boar', 'deer', 'rabbit'];
        const entityType = entityTypes[Math.floor(Math.random() * entityTypes.length)];
        
        const configs = {
            'wolf': { health: 80, damage: 15 },
            'boar': { health: 100, damage: 10 },
            'deer': { health: 60, damage: 5 },
            'rabbit': { health: 30, damage: 2 }
        };
        
        const config = configs[entityType];
        this.spawnEntity(entityType, config.health, config.damage);
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

    // Handle resource harvesting
    handleResourceHarvest(playerId, tileX, tileY, resourceType) {
        const tileKey = `${tileX},${tileY}`;
        const tile = this.gameState.worldState.generatedMap[tileKey];
        
        if (!tile) return false;
        
        let harvested = false;
        let itemDropped = null;
        let amount = 1;
        
        switch (resourceType) {
            case 'tree':
                if (tile.hasTree && tile.treeGrowth >= 100) {
                    tile.hasTree = false;
                    tile.treeType = null;
                    tile.treeGrowth = 0;
                    
                    // Drop wood based on tree type
                    const woodTypes = {
                        'oak': 'oak_wood',
                        'pine': 'pine_wood', 
                        'apple': 'apple_wood'
                    };
                    itemDropped = woodTypes[tile.treeType] || 'wood';
                    amount = 2 + Math.floor(Math.random() * 3); // 2-4 wood
                    harvested = true;
                }
                break;
                
            case 'stone':
                if (tile.hasStone) {
                    tile.hasStone = false;
                    itemDropped = 'stone';
                    amount = 1 + Math.floor(Math.random() * 2); // 1-2 stone
                    harvested = true;
                }
                break;
                
            case 'bush':
                if (tile.hasBush) {
                    tile.hasBush = false;
                    itemDropped = 'fiber';
                    amount = 1;
                    harvested = true;
                }
                break;
        }
        
        if (harvested) {
            // Broadcast resource harvest to all players
            io.to(this.id).emit('resource-harvested', {
                tileX: tileX,
                tileY: tileY,
                resourceType: resourceType,
                itemDropped: itemDropped,
                amount: amount,
                harvesterId: playerId
            });
            
            console.log(`[ROOM ${this.id}] Player ${playerId} harvested ${resourceType} at (${tileX}, ${tileY})`);
            return true;
        }
        
        return false;
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
        
        // Only update player-specific data, not world state
        room.updatePlayerState(socket.id, data.playerState || {});
    });

    // Handle resource harvesting requests
    socket.on('harvest-resource', (data) => {
        const player = players.get(socket.id);
        if (!player) return;
        
        const room = rooms.get(player.roomId);
        if (!room) return;
        
        room.handleResourceHarvest(socket.id, data.tileX, data.tileY, data.resourceType);
    });

    // Send initial world sync to new players
    socket.on('request-world-sync', () => {
        const player = players.get(socket.id);
        if (!player) return;
        
        const room = rooms.get(player.roomId);
        if (!room) return;
        
        // Send complete world state to this player
        socket.emit('world-state-updated', {
            gameTick: room.gameState.worldState.gameTick,
            currentGameTime: room.gameState.worldState.currentGameTime,
            temperature: room.gameState.worldState.temperature,
            weather: room.gameState.worldState.weather,
            weatherTimer: room.gameState.worldState.weatherTimer,
            entities: room.gameState.worldState.entities,
            generatedMap: room.gameState.worldState.generatedMap,
            timestamp: Date.now(),
            isInitialSync: true
        });
        
        console.log(`[ROOM ${room.id}] Sent initial world sync to player ${player.playerName}`);
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

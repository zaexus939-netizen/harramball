const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling']
});

const rooms = new Map();

// Ana sayfa
app.get('/', (req, res) => {
    const totalPlayers = Array.from(rooms.values()).reduce((sum, room) => sum + room.players.length, 0);
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>HarramBall Server</title>
            <style>
                body {
                    font-family: Arial, sans-serif;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100vh;
                    margin: 0;
                }
                .container {
                    text-align: center;
                    background: rgba(0,0,0,0.3);
                    padding: 50px;
                    border-radius: 20px;
                    backdrop-filter: blur(10px);
                }
                h1 { font-size: 48px; margin: 0 0 20px 0; }
                .status { font-size: 24px; margin: 10px 0; }
                .ping { color: #4CAF50; font-weight: bold; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>⚽ HARRAMBALL SERVER</h1>
                <div class="status">✅ Server Çalışıyor!</div>
                <div class="status">📍 Frankfurt, Germany 🇩🇪</div>
                <div class="status">📊 Aktif Odalar: <span class="ping">${rooms.size}</span></div>
                <div class="status">👥 Toplam Oyuncu: <span class="ping">${totalPlayers}</span></div>
                <div class="status">📡 Ping: <span class="ping">35-55ms</span> (Türkiye)</div>
            </div>
        </body>
        </html>
    `);
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        rooms: rooms.size,
        players: Array.from(rooms.values()).reduce((sum, room) => sum + room.players.length, 0)
    });
});

// Socket.io bağlantıları
io.on('connection', (socket) => {
    console.log('✅ Oyuncu bağlandı:', socket.id);
    
    // Oda listesini gönder
    socket.on('get_rooms', () => {
        const roomList = Array.from(rooms.values()).map(room => ({
            id: room.id,
            name: room.name,
            host: room.host,
            maxPlayers: room.maxPlayers,
            currentPlayers: room.players.length,
            hasPassword: room.hasPassword,
            createdAt: room.createdAt
        }));
        socket.emit('rooms_list', roomList);
    });
    
    // Oda oluştur
    socket.on('create_room', (data) => {
        const roomId = socket.id;
        
        rooms.set(roomId, {
            id: roomId,
            name: data.roomName,
            host: socket.id,
            maxPlayers: data.maxPlayers || 20,
            hasPassword: data.hasPassword || false,
            password: data.password || null,
            players: [{
                id: socket.id,
                name: data.playerName,
                number: data.playerNumber,
                team: 'red',
                isHost: true
            }],
            redTeam: [{
                id: socket.id,
                name: data.playerName,
                number: data.playerNumber
            }],
            blueTeam: [],
            spectators: [],
            createdAt: Date.now()
        });
        
        socket.join(roomId);
        socket.emit('room_created', { 
            success: true,
            roomId, 
            room: rooms.get(roomId) 
        });
        
        // Tüm oyunculara oda listesini güncelle
        io.emit('rooms_updated');
        
        console.log('🏠 Oda oluşturuldu:', roomId, '-', data.roomName);
    });
    
    // Odaya katıl
    socket.on('join_room', (data) => {
        const room = rooms.get(data.roomId);
        
        if (!room) {
            socket.emit('join_error', { message: 'Oda bulunamadı!' });
            return;
        }
        
        if (room.players.length >= room.maxPlayers) {
            socket.emit('join_error', { message: 'Oda dolu!' });
            return;
        }
        
        if (room.hasPassword && room.password !== data.password) {
            socket.emit('join_error', { message: 'Yanlış şifre!' });
            return;
        }
        
        const newPlayer = {
            id: socket.id,
            name: data.playerName,
            number: data.playerNumber,
            team: 'spectator',
            isHost: false
        };
        
        room.players.push(newPlayer);
        room.spectators.push({
            id: socket.id,
            name: data.playerName,
            number: data.playerNumber
        });
        
        socket.join(data.roomId);
        
        // Odaya katılana oda bilgisi gönder
        socket.emit('room_joined', { 
            success: true,
            room: room 
        });
        
        // Tüm odadakilere yeni oyuncuyu bildir
        io.to(data.roomId).emit('player_joined', {
            player: newPlayer,
            room: room
        });
        
        // Tüm oyunculara oda listesini güncelle
        io.emit('rooms_updated');
        
        console.log('👤 Oyuncu odaya katıldı:', socket.id, '→', data.roomId);
    });
    
    // Oyuncu hareketi
    socket.on('player_move', (data) => {
        socket.to(data.roomId).emit('player_update', {
            id: socket.id,
            x: data.x,
            y: data.y,
            vx: data.vx,
            vy: data.vy,
            running: data.running
        });
    });
    
    // Oyun durumu (Host'tan)
    socket.on('game_state', (data) => {
        socket.to(data.roomId).emit('game_state_update', data);
    });
    
    // Top vurma
    socket.on('ball_kicked', (data) => {
        socket.to(data.roomId).emit('ball_update', data);
    });
    
    // Takım değişikliği
    socket.on('team_change', (data) => {
        const room = rooms.get(data.roomId);
        if (!room) return;
        
        // Oyuncuyu tüm takımlardan çıkar
        room.redTeam = room.redTeam.filter(p => p.id !== data.playerId);
        room.blueTeam = room.blueTeam.filter(p => p.id !== data.playerId);
        room.spectators = room.spectators.filter(p => p.id !== data.playerId);
        
        // Yeni takıma ekle
        const player = room.players.find(p => p.id === data.playerId);
        if (player) {
            player.team = data.team;
            
            if (data.team === 'red') {
                room.redTeam.push({ id: player.id, name: player.name, number: player.number });
            } else if (data.team === 'blue') {
                room.blueTeam.push({ id: player.id, name: player.name, number: player.number });
            } else {
                room.spectators.push({ id: player.id, name: player.name, number: player.number });
            }
        }
        
        // Tüm odaya güncellemeyi bildir
        io.to(data.roomId).emit('team_updated', { room });
    });
    
    // Bağlantı koptu
    socket.on('disconnect', () => {
        console.log('❌ Oyuncu ayrıldı:', socket.id);
        
        rooms.forEach((room, roomId) => {
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            
            if (playerIndex !== -1) {
                const player = room.players[playerIndex];
                room.players.splice(playerIndex, 1);
                
                // Takımlardan da kaldır
                room.redTeam = room.redTeam.filter(p => p.id !== socket.id);
                room.blueTeam = room.blueTeam.filter(p => p.id !== socket.id);
                room.spectators = room.spectators.filter(p => p.id !== socket.id);
                
                // Oda boşsa sil
                if (room.players.length === 0) {
                    rooms.delete(roomId);
                    console.log('🗑️ Oda silindi:', roomId);
                    io.emit('rooms_updated');
                } else {
                    // Host ayrıldıysa yeni host belirle
                    if (room.host === socket.id && room.players.length > 0) {
                        room.host = room.players[0].id;
                        room.players[0].isHost = true;
                        console.log('👑 Yeni host:', room.host);
                    }
                    
                    // Diğer oyunculara bildir
                    io.to(roomId).emit('player_left', {
                        playerId: socket.id,
                        room: room
                    });
                    
                    io.emit('rooms_updated');
                }
            }
        });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 HarramBall Server çalışıyor!`);
    console.log(`📍 Port: ${PORT}`);
    console.log(`📡 Frankfurt, Germany 🇩🇪`);
    console.log(`⚽ Oyun başlasın!`);
});
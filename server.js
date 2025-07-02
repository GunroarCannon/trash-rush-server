const express = require('express');
const http = require('http');
const socketio = require('socket.io');

class GameServer {
  constructor() {
    this.games = {};
    this.players = {};
    this.publicGames = new Map();
    this.privateGames = new Map();
    this.gameReadyStates = {};
    this.lastActivity = Date.now();
    this.ACTIVITY_TIMEOUT = 300000; // 5 minutes
    this.powerupManager = new PowerupManager();
  }

  initialize() {
    const app = express();
    app.use(express.json());

    // Enhanced CORS middleware for all routes
    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (req.method === 'OPTIONS') {
            return res.status(200).end();
        }
        next();
    });

    // Wake endpoint
    app.post('/wake', (req, res) => {
      console.log('Received wake call from client');
      this.lastActivity = Date.now();
      res.json({
        status: 'awake',
        ping: Date.now() - parseInt(req.body.timestamp),
        message: 'Server is active and responding'
      });
    });

    // Health check
    app.get('/health', (req, res) => {
      res.status(200).send('OK');
    });

    const server = http.createServer(app);
    const io = socketio(server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
      },
      transports: ['websocket', 'polling'], // Important for Render
      allowUpgrades: true,
      pingTimeout: 60000,
      pingInterval: 25000
    });

    // Add explicit WebSocket upgrade handler
    /*server.on('upgrade', (req, socket, head) => {
      console.log('WebSocket upgrade requested');
      io.engine.handleUpgrade(req, socket, head, (ws) => {
        io.engine.onWebSocket(req, ws);
      });
    });*/

    // Keep-alive using Render's environment
    setInterval(() => {
        if (Date.now() - this.lastActivity > this.ACTIVITY_TIMEOUT) {
            console.log('Performing keep-alive ping');
            fetch(`https://trash-rush-server.onrender.com//health`)
                .then(() => console.log('Keep-alive successful'))
                .catch(err => console.error('Keep-alive failed:', err));
        }
    }, 60000);

    // Socket.io events
    io.on('connection', (socket) => {
      console.log(`Player connected: ${socket.id}`);
      this.players[socket.id] = { socket, gameId: null };

      socket.on('disconnect', () => this.handleDisconnect(socket));
      socket.on('quickPlay', (data) => this.handleQuickPlay(socket, data));
      socket.on('createPrivateGame', () => this.createPrivateGame(socket));
      socket.on('joinPrivateGame', (data) => this.joinPrivateGame(socket, data));
      socket.on('playerReady', (data) => this.setPlayerReady(socket, data));
      socket.on('playerAction', (data) => this.handlePlayerAction(socket, data));
      socket.on('roundComplete', () => this.handleRoundComplete(socket));
    });

    // Use Render's PORT environment variable
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running on port ${PORT}`);
        console.log(`WebSocket available at wss://your-render-url.onrender.com`);
    });

  }

  // Combined game creation logic
  createGame(socket, isPublic = true) {
    const gameId = `game_${Date.now()}`;
    const game = {
      id: gameId,
      players: [socket.id],
      host: socket.id,
      readyStates: {},
      round: 1,
      maxRounds: 3,
      gameState: 'lobby',
      trashType: this.getRandomTrashType(),
      negativeMode: false,
      scores: {},
      powerups: this.powerupManager.generatePowerupPool(gameId),
      isPublic,
      createdAt: Date.now()
    };

    if (isPublic) {
      this.publicGames.set(gameId, game);
    } else {
      this.privateGames.set(gameId, game);
    }

    this.players[socket.id].gameId = gameId;
    socket.emit(isPublic ? 'gameCreated' : 'privateGameCreated', { 
      gameId,
      isHost: true,
      seed: gameId
    });

    return gameId;
  }

  // Enhanced join game with both public/private support
  joinGame(socket, gameId, character, isPublic = true) {
    const game = isPublic ? this.publicGames.get(gameId) : this.privateGames.get(gameId);
    if (!game || game.players.length >= 4) {
      socket.emit('gameError', { message: game ? 'Game is full' : 'Game not found' });
      return false;
    }

    game.players.push(socket.id);
    this.players[socket.id] = { socket, gameId };
    game.scores[socket.id] = 0;

    // Notify all players
    socket.to(gameId).emit('playerJoined', {
      playerId: socket.id,
      position: game.players.length,
      character
    });

    socket.emit('gameJoined', {
      gameId,
      isHost: false,
      seed: gameId,
      currentRound: game.round,
      players: game.players.map(id => ({
        id,
        position: game.players.indexOf(id) + 1,
        character: id === socket.id ? character : this.players[id]?.character
      }))
    });

    // Auto-start if full
    if (game.players.length === 4) {
      this.startGame(gameId, isPublic);
    }

    return true;
  }

  // Combined game management methods
  handleQuickPlay(socket, { character }) {
    this.cleanupOldGames();
    
    // Find available public game
    let gameId;
    for (const [id, game] of this.publicGames) {
      if (!game.gameStarted && game.players.length < 4) {
        gameId = id;
        break;
      }
    }

    if (gameId) {
      this.joinGame(socket, gameId, character, true);
    } else {
      gameId = this.createGame(socket, true);
      this.joinGame(socket, gameId, character, true);
    }
    this.broadcastPlayers(gameId);
this.broadcastReadyStates(gameId);

  }

  createPrivateGame(socket) {
    const gameId = this.createGame(socket, false);
    socket.emit('privateGameCreated', { gameId });
  }

  joinPrivateGame(socket, { gameId, character }) {
    this.joinGame(socket, gameId, character, false);
  }
  broadcastPlayers(gameId) {
  const game = this.publicGames.get(gameId) || this.privateGames.get(gameId);
  if (!game) return;
  const players = game.players.map(id => ({
    id,
    character: this.players[id]?.character || 'goblin'
  }));
  game.players.forEach(id => this.players[id].socket.emit('playersUpdated', { players }));
}

broadcastReadyStates(gameId) {
  const game = this.publicGames.get(gameId) || this.privateGames.get(gameId);
  if (!game) return;
  const readyStates = game.readyStates;
  game.players.forEach(id => this.players[id].socket.emit('readyStatesUpdated', readyStates));
}
broadcastPlayers(gameId) {
  const game = this.publicGames.get(gameId) || this.privateGames.get(gameId);
  if (!game) return;
  const players = game.players.map(id => ({
    id,
    character: this.players[id]?.character || 'goblin'
  }));
  game.players.forEach(id => this.players[id].socket.emit('playersUpdated', { players }));
}

broadcastReadyStates(gameId) {
  const game = this.publicGames.get(gameId) || this.privateGames.get(gameId);
  if (!game) return;
  const readyStates = game.readyStates;
  game.players.forEach(id => this.players[id].socket.emit('readyStatesUpdated', readyStates));
}


  // All other methods (handlePlayerAction, startRound, endRound, etc.)
  // ... remain the same as in your first implementation ...
  

// Game lifecycle functions
function startGame(gameId) {
  const game = publicGames.get(gameId) || privateGames.get(gameId);
  if (!game) return;

  game.gameStarted = true;
  game.trashType = getRandomTrashType();
  
  io.to(gameId).emit('gameStart', {
    trashType: game.trashType,
    players: Object.values(game.players).map(p => ({
      id: p.id,
      character: p.character,
      position: p.position
    }))
  });
}
function endGame(gameId, isPublic) {
  // Get the game from the correct collection
  const game = isPublic ? publicGames.get(gameId) : privateGames.get(gameId);
  if (!game) return;

  // Calculate scores and winner
  const scores = {};
  let maxScore = -1;
  let winnerId = null;
  
  Object.values(game.players).forEach(player => {
    scores[player.id] = player.score;
    if (player.score > maxScore) {
      maxScore = player.score;
      winnerId = player.id;
    } else if (player.score === maxScore) {
      // Handle tie by selecting randomly
      winnerId = Math.random() > 0.5 ? winnerId : player.id;
    }
  });

  // Broadcast game over to all players
  io.to(gameId).emit('gameOver', {
    scores,
    winnerId,
    players: Object.values(game.players).map(p => ({
      id: p.id,
      character: p.character,
      position: p.position,
      score: p.score
    }))
  });

  // Clean up game after short delay
  setTimeout(() => {
    if (isPublic) {
      publicGames.delete(gameId);
    } else {
      privateGames.delete(gameId);
    }
    console.log(`Cleaned up game ${gameId}`);
  }, 30000); // 30 second delay to allow clients to process
}

function getRandomTrashType() {
  const types = ['golden', 'handbag', 'trashcan'];
  return types[Math.floor(Math.random() * types.length)];
}
// Start cleanup interval
//setInterval(cleanupOldGames, 5 * 60 * 1000); // Every 5 minutes

  // Cleanup old games
  cleanupOldGames() {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000; // 30 minutes
    
    [this.publicGames, this.privateGames].forEach(gameMap => {
      for (const [id, game] of gameMap) {
        if (now - game.createdAt > maxAge || game.players.length === 0) {
          gameMap.delete(id);
        }
      }
    });
  }
}

class PowerupManager {
  constructor() {
    this.powerups = {
      // Your powerup definitions here
    };
  }

}

// Initialize server
const gameServer = new GameServer();
gameServer.initialize();

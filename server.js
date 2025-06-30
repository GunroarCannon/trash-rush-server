// server.js
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

class Game {
  constructor(isPublic = false) {
    this.players = {};
    this.gameStarted = false;
    this.maxPlayers = 4;
    this.currentRound = 1;
    this.maxRounds = 3;
    this.trashType = null;
    this.isPublic = isPublic;
    this.createdAt = Date.now();
  }

  addPlayer(playerId, socket) {
    const position = Object.keys(this.players).length + 1;
    this.players[playerId] = {
      id: playerId,
      socket,
      connected: true,
      ready: false,
      score: 0,
      position,
      character: null,
      isHost: position === 1 // First player is host
    };
    return position;
  }

  removePlayer(playerId) {
    delete this.players[playerId];
  }

  checkAllPlayersReady() {
    const connectedPlayers = Object.values(this.players).filter(p => p.connected);
    const readyPlayers = connectedPlayers.filter(p => p.ready);
    return connectedPlayers.length >= 2 && readyPlayers.length === connectedPlayers.length;
  }

  broadcast(event, data, excludePlayerId = null) {
    Object.values(this.players).forEach(player => {
      if (player.connected && player.id !== excludePlayerId) {
        player.socket.emit(event, data);
      }
    });
  }
}
// Game management
const publicGames = new Map();  // For quick play
const privateGames = new Map(); // For private games

function generateGameId() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

function cleanupOldGames() {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes
  
  // Clean public games
  publicGames.forEach((game, id) => {
    if (now - game.createdAt > maxAge || Object.keys(game.players).length === 0) {
      publicGames.delete(id);
    }
  });
  
  // Clean private games
  privateGames.forEach((game, id) => {
    if (now - game.createdAt > maxAge || Object.keys(game.players).length === 0) {
      privateGames.delete(id);
    }
  });
}

// Game matching system
function findAvailablePublicGame() {
  for (const [id, game] of publicGames) {
    if (!game.gameStarted && Object.keys(game.players).length < game.maxPlayers) {
      return id;
    }
  }
  return null;
}


// Main connection handler
io.on('connection', (socket) => {
  let currentGameId = null;
  let currentPlayerId = socket.id;// Track ready states per game


    
    socket.on('joinGame', (gameId) => {
        currentGameId = gameId;
        gameReadyStates[gameId] = gameReadyStates[gameId] || {};
        socket.join(gameId);
        updatePlayers(gameId);
    });
    
    socket.on('playerReady', ({ isReady }) => {
        if (!currentGameId) return;
        
        // Update ready state
        gameReadyStates[currentGameId][socket.id] = isReady;
        
        // Broadcast new ready states
        io.to(currentGameId).emit('readyStatesUpdated', gameReadyStates[currentGameId]);
        
        // Check if all players are ready
        const players = getPlayersInRoom(currentGameId);
        const allReady = players.length >= 2 && 
                        players.every(player => gameReadyStates[currentGameId][player.id]);
        
        if (allReady) {
            // Start countdown
            io.to(currentGameId).emit('gameStarting');
            setTimeout(() => {
                io.to(currentGameId).emit('gameStart');
            }, 3000); // 3 second countdown
        }
    });
    
    function updatePlayers(gameId) {
        io.to(gameId).emit('playersUpdated', {
            players: getPlayersInRoom(gameId)
        });
    }
    
    function getPlayersInRoom(gameId) {
        const sockets = Array.from(io.sockets.adapter.rooms.get(gameId) || []);
        return sockets.map(socketId => {
            const socket = io.sockets.sockets.get(socketId);
            return {
                id: socket.id,
                character: socket.character
            };
        });
    }
});

  // Quick Play - Auto Matchmaking
  socket.on('quickPlay', ({ character }) => {
    // Cleanup old games first
    cleanupOldGames();

    // Find existing public game
    const existingGameId = findAvailablePublicGame();
    
    if (existingGameId) {
      joinGame(socket, existingGameId, character, false);
    } else {
      // Create new public game
      const newGameId = generateGameId();
      const game = new Game(true);
      publicGames.set(newGameId, game);
      joinGame(socket, newGameId, character, true);
    }
  });

  // Create Private Game
  socket.on('createPrivateGame', ({ character }) => {
    const gameId = generateGameId();
    const game = new Game(false);
    privateGames.set(gameId, game);
    joinGame(socket, gameId, character, true);
    socket.emit('privateGameCreated', { gameId });
  });

  // Join Private Game
  socket.on('joinPrivateGame', ({ gameId, character }) => {
    if (privateGames.has(gameId)) {
      joinGame(socket, gameId, character, false);
    } else {
      socket.emit('gameError', { message: 'Game not found' });
    }
  });

  // Shared join game logic
  function joinGame(socket, gameId, character, isHost) {
    const game = publicGames.get(gameId) || privateGames.get(gameId);
    
    if (!game || game.gameStarted || Object.keys(game.players).length >= game.maxPlayers) {
      socket.emit('gameError', { message: 'Cannot join game' });
      return;
    }

    currentGameId = gameId;
    const position = game.addPlayer(currentPlayerId, socket);
    socket.join(gameId);

    // Notify player
    socket.emit('gameJoined', {
      gameId,
      playerId: currentPlayerId,
      position,
      isHost,
      players: Object.values(game.players).map(p => ({
        id: p.id,
        character: p.character,
        position: p.position
      }))
    });

    // Notify others
    socket.to(gameId).emit('playerJoined', {
      playerId: currentPlayerId,
      position,
      character
    });

    // Auto-start if full
    if (Object.keys(game.players).length === game.maxPlayers) {
      startGame(gameId);
    }
  }

  // Player ready
  socket.on('playerReady', ({ character }) => {
    const game = getCurrentGame();
    if (!game) return;

    game.players[currentPlayerId].ready = true;
    game.players[currentPlayerId].character = character;
    
    socket.to(currentGameId).emit('playerReady', {
      playerId: currentPlayerId,
      character
    });

    // Start if enough players are ready
    const readyPlayers = Object.values(game.players).filter(p => p.ready).length;
    if (readyPlayers >= 2 && readyPlayers === Object.keys(game.players).length) {
      startGame(currentGameId);
    }
  });


  // Player action
  socket.on('playerAction', ({ gameId, action, points }) => {
    if (!currentGame || currentGame.players[currentPlayerId].gameId !== gameId) {
      return;
    }

    switch(action) {
      case 'tapTrash':
        currentGame.players[currentPlayerId].score += points;
        currentGame.broadcast('playerAction', {
          playerId: currentPlayerId,
          action,
          points
        });
        break;
    }
  });

  // Round complete
 socket.on('roundComplete', ({ gameId, isPublic }) => {
  const game = isPublic ? publicGames.get(gameId) : privateGames.get(gameId);
  if (!game) return;

  game.currentRound++;
  if (game.currentRound > game.maxRounds) {
    endGame(gameId, isPublic);
  } else {
    game.trashType = getRandomTrashType();
    io.to(gameId).emit('startNextRound', {
      round: game.currentRound,
      trashType: game.trashType
    });
  }
});

   // Helper function
  function getCurrentGame() {
    return publicGames.get(currentGameId) || privateGames.get(currentGameId);
  }

  // Disconnect handler
  socket.on('disconnect', () => {
    const game = getCurrentGame();
    if (!game || !game.players[currentPlayerId]) return;

    // Mark as disconnected but keep player data
    game.players[currentPlayerId].connected = false;
    
    // Notify others
    socket.to(currentGameId).emit('playerDisconnected', {
      playerId: currentPlayerId
    });

    // Handle host migration
    if (game.players[currentPlayerId].isHost) {
      const newHost = Object.values(game.players).find(p => p.connected);
      if (newHost) {
        newHost.isHost = true;
        io.to(newHost.id).emit('promotedToHost');
      } else if (game.isPublic) {
        publicGames.delete(currentGameId);
      } else {
        privateGames.delete(currentGameId);
      }
    }
  });
});

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
setInterval(cleanupOldGames, 5 * 60 * 1000); // Every 5 minutes

http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

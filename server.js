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

// Game lobbies
const gameLobbies = {};

// Helper function to generate unique game IDs
function generateGameId() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

// Game class to manage individual game state
class Game {
  constructor() {
    this.players = {};
    this.gameStarted = false;
    this.maxPlayers = 4;
    this.currentRound = 1;
    this.maxRounds = 3;
    this.trashType = null;
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
      character: null
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

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);
  
  let currentGame = null;
  let currentPlayerId = socket.id;

  // Create new game
  socket.on('createGame', () => {
    const gameId = generateGameId();
    gameLobbies[gameId] = new Game();
    currentGame = gameLobbies[gameId];
    
    const position = currentGame.addPlayer(currentPlayerId, socket);
    
    socket.emit('gameCreated', {
      gameId,
      playerId: currentPlayerId,
      position,
      isHost: true
    });
  });

  // Join existing game
  socket.on('joinGame', (gameId) => {
    if (!gameLobbies[gameId]) {
      socket.emit('gameError', { message: 'Game not found' });
      return;
    }

    currentGame = gameLobbies[gameId];
    
    if (Object.keys(currentGame.players).length >= currentGame.maxPlayers) {
      socket.emit('gameError', { message: 'Game is full' });
      return;
    }

    const position = currentGame.addPlayer(currentPlayerId, socket);
    
    // Notify new player
    socket.emit('gameJoined', {
      gameId,
      playerId: currentPlayerId,
      position,
      isHost: false
    });

    // Notify other players in the game
    currentGame.broadcast('playerJoined', {
      playerId: currentPlayerId,
      position
    });
  });

  // Player ready
  socket.on('playerReady', ({ gameId, character }) => {
    if (!currentGame || currentGame.players[currentPlayerId].gameId !== gameId) {
      socket.emit('gameError', { message: 'Not in this game' });
      return;
    }

    currentGame.players[currentPlayerId].ready = true;
    currentGame.players[currentPlayerId].character = character;
    
    currentGame.broadcast('playerReady', {
      playerId: currentPlayerId,
      character
    });

    if (currentGame.checkAllPlayersReady()) {
      startGame(currentGame);
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
  socket.on('roundComplete', ({ gameId }) => {
    if (!currentGame || 
        currentGame.players[currentPlayerId].gameId !== gameId ||
        !currentGame.players[currentPlayerId].isHost) {
      return;
    }

    currentGame.currentRound++;
    if (currentGame.currentRound > currentGame.maxRounds) {
      endGame(currentGame);
    } else {
      currentGame.trashType = getRandomTrashType();
      currentGame.broadcast('startNextRound', {
        round: currentGame.currentRound,
        trashType: currentGame.trashType
      });
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    if (currentGame) {
      currentGame.players[currentPlayerId].connected = false;
      currentGame.broadcast('playerDisconnected', {
        playerId: currentPlayerId
      });

      // If host disconnected, promote another player
      if (currentGame.players[currentPlayerId].isHost) {
        const remainingPlayers = Object.values(currentGame.players)
          .filter(p => p.connected);
        
        if (remainingPlayers.length > 0) {
          const newHostId = remainingPlayers[0].id;
          currentGame.players[newHostId].isHost = true;
          remainingPlayers[0].socket.emit('promoteToHost');
        } else {
          // No players left, clean up game
          delete gameLobbies[currentGame.players[currentPlayerId].gameId];
        }
      }
    }
  });
});

function startGame(game) {
  game.gameStarted = true;
  game.trashType = getRandomTrashType();
  game.broadcast('gameStart', {
    trashType: game.trashType
  });
}

function endGame(game) {
  // Calculate winner
  const scores = Object.fromEntries(
    Object.values(game.players).map(p => [p.id, p.score])
  );
  const maxScore = Math.max(...Object.values(scores));
  const winnerId = Object.keys(scores).find(id => scores[id] === maxScore);

  game.broadcast('gameOver', {
    scores,
    winnerId
  });

  // Clean up game
  delete gameLobbies[game.players[winnerId].gameId];
}

function getRandomTrashType() {
  const types = ['golden', 'handbag', 'trashcan'];
  return types[Math.floor(Math.random() * types.length)];
}

http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

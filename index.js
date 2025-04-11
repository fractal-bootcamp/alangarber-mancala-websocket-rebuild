const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*', // You can tighten this later for production security
  }
});

app.get("/", (req, res) => {
  res.send("Mancala WebSocket Server is running!");
});

// Store waiting players and active games
const waitingPlayers = [];
const games = {}; // { gameId: { board, players, currentPlayer } }

// Create initial board
function createStartingBoard() {
  return Array(14)
    .fill(4)
    .map((stones, index) => (index === 6 || index === 13 ? 0 : stones));
}

// Real Mancala move logic
function applyMove(board, pocketIndex, player) {
  const newBoard = [...board];
  let stones = newBoard[pocketIndex];
  newBoard[pocketIndex] = 0;

  let currentIndex = pocketIndex;

  const playerStore = player === "player1" ? 6 : 13;
  const opponentStore = player === "player1" ? 13 : 6;
  const isPlayerSide = (i) => (player === "player1" ? i >= 0 && i <= 5 : i >= 7 && i <= 12);

  while (stones > 0) {
    currentIndex = (currentIndex + 1) % 14;
    if (currentIndex === opponentStore) continue; // Skip opponent's store
    newBoard[currentIndex]++;
    stones--;
  }

  // Capture rule
  if (isPlayerSide(currentIndex) && newBoard[currentIndex] === 1) {
    const oppositeIndex = 12 - currentIndex;
    const captured = newBoard[oppositeIndex];
    if (captured > 0) {
      newBoard[playerStore] += captured + 1;
      newBoard[currentIndex] = 0;
      newBoard[oppositeIndex] = 0;
    }
  }

  // Extra turn rule
  const extraTurn = currentIndex === playerStore;

  // Check for game over
  const player1Empty = newBoard.slice(0, 6).every((stones) => stones === 0);
  const player2Empty = newBoard.slice(7, 13).every((stones) => stones === 0);

  if (player1Empty || player2Empty) {
    // Game over: collect all remaining stones
    for (let i = 0; i < 6; i++) {
      newBoard[6] += newBoard[i];
      newBoard[i] = 0;
    }
    for (let i = 7; i < 13; i++) {
      newBoard[13] += newBoard[i];
      newBoard[i] = 0;
    }
  }

  return {
    newBoard,
    nextPlayer: extraTurn ? player : player === "player1" ? "player2" : "player1",
    gameOver: player1Empty || player2Empty,
  };
}

// WebSocket logic
io.on('connection', (socket) => {
  console.log(`New client connected: ${socket.id}`);

  socket.on('joinGame', () => {
    console.log(`Player ${socket.id} wants to join a game`);

    if (waitingPlayers.length > 0) {
      const opponent = waitingPlayers.pop();
      const gameId = `${opponent.id}#${socket.id}`;

      socket.join(gameId);
      opponent.join(gameId);

      const startingBoard = createStartingBoard();
      games[gameId] = {
        board: startingBoard,
        players: [opponent.id, socket.id],
        currentPlayer: "player1",
      };

      // Send 'matched' event
      io.to(socket.id).emit('matched', { gameId, player: "player2" });
      io.to(opponent.id).emit('matched', { gameId, player: "player1" });

      console.log(`Match found: ${opponent.id} vs ${socket.id}`);

      // Send initial game state separately to each player
      io.to(socket.id).emit('gameState', {
        gameId,
        board: startingBoard,
        currentPlayer: "player1",
        yourPlayer: "player2",
      });

      io.to(opponent.id).emit('gameState', {
        gameId,
        board: startingBoard,
        currentPlayer: "player1",
        yourPlayer: "player1",
      });
    } else {
      waitingPlayers.push(socket);
      console.log(`Player ${socket.id} is waiting for a match`);
    }
  });

  socket.on('makeMove', (data) => {
    console.log(`Move made in game ${data.gameId}:`, data);

    const game = games[data.gameId];
    if (!game) {
      console.error(`No game found with ID: ${data.gameId}`);
      return;
    }

    const { board, currentPlayer } = game;
    const playerMakingMove = data.player;

    // Validate it's the player's turn
    if (playerMakingMove !== currentPlayer) {
      console.error(`It's not ${playerMakingMove}'s turn!`);
      return;
    }

    const result = applyMove(board, data.pocket, playerMakingMove);

    game.board = result.newBoard;
    game.currentPlayer = result.nextPlayer;

    // Broadcast updated game state
    io.to(data.gameId).emit('gameState', {
      gameId: data.gameId,
      board: result.newBoard,
      currentPlayer: result.nextPlayer,
      lastMove: {
        player: playerMakingMove,
        pocket: data.pocket,
        description: `Player ${playerMakingMove} picked pocket ${data.pocket}`,
      },
    });

    // Handle game over
    if (result.gameOver) {
      console.log(`Game over in ${data.gameId}`);
      const [player1Score, player2Score] = [result.newBoard[6], result.newBoard[13]];
      let winner = "tie";
      if (player1Score > player2Score) winner = "player1";
      else if (player2Score > player1Score) winner = "player2";

      io.to(data.gameId).emit('gameOver', {
        winner,
        message: winner === "tie" ? "It's a tie!" : `${winner} wins!`,
      });

      delete games[data.gameId];
    }
  });

  socket.on('leaveGame', (gameId) => {
    console.log(`Player ${socket.id} left game ${gameId}`);
    socket.leave(gameId);

    if (games[gameId]) {
      delete games[gameId];
    }
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);

    // Remove from waiting list if waiting
    const index = waitingPlayers.findIndex((player) => player.id === socket.id);
    if (index !== -1) {
      waitingPlayers.splice(index, 1);
      console.log(`Player ${socket.id} removed from waiting list`);
      return;
    }

    // Handle disconnection during a game
    for (const gameId in games) {
      const { players } = games[gameId];
      if (players.includes(socket.id)) {
        console.log(`Player ${socket.id} disconnected from game ${gameId}`);
        const otherPlayer = players.find((p) => p !== socket.id);
        if (otherPlayer) {
          io.to(otherPlayer).emit('opponentDisconnected', {
            gameId,
            message: "Your opponent disconnected.",
          });
        }
        delete games[gameId];
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`WebSocket server running on port ${PORT}`);
});

import { Server } from "socket.io";
import { roomRepository } from "../repositories";
import { ChatService } from "./ChatService";

interface User {
  id: string;
  accessToken: string;
  name: string;
  email: string;
  image: string;
  role: string;
}

interface Track {
  id: string;
  title: string;
  description: string;
  thumbnail: string;
  url: string;
  user: User;
}

interface RoomUser {
  id: string;
  name: string;
  email: string;
  image: string;
  role: string;
  socketId: string;
  joinedAt: Date;
  // ✅ NOVO: Campos para controle de atividade
  isActive: boolean;
  lastActivity: Date;
  canBeSyncSource: boolean;
}

interface RoomState {
  roomId: string;
  online: boolean;
  playing: boolean;
  currentTime: number;
  listeners: number;
  playlist: Track[];
  currentTrack: Track | null;
  users: Map<string, RoomUser>;
  owner: string;
  moderators: string[];
  createdAt: Date;
  lastActivity: Date;
  // ✅ NOVO: Campos para sincronização de tempo
  trackStartTime: Date | null;
  lastSyncTime: number;
  // ✅ NOVO: Sistema simples de sincronização
  videoStartTimestamp?: number; // Date.now() quando música começou
  videoId?: string; // ID da música atual
  // ✅ NOVO: Fonte de sincronização dinâmica
  syncSource: {
    userId: string;
    userRole: string;
    lastSyncTime: number;
    isActive: boolean;
    lastActivity: Date;
  } | null;
  // ✅ NOVO: Último tempo atualizado pelo host
  lastHostUpdate: Date | null;
}

const rooms: Record<string, RoomState> = {};

// Sistema de sincronização de tempo para todas as salas
const timeSyncIntervals: Record<string, NodeJS.Timeout> = {};

// ✅ NOVO: Sistema de heartbeat para verificar atividade dos usuários
const heartbeatIntervals: Record<string, NodeJS.Timeout> = {};

// ✅ NOVO: Função simples para calcular tempo atual baseado em timestamp
function getCurrentVideoTime(room: RoomState): number {
  if (!room.playing || !room.videoStartTimestamp || !room.videoId) {
    return 0;
  }
  
  const now = Date.now();
  const elapsedSeconds = Math.floor((now - room.videoStartTimestamp) / 1000);
  
  console.log(`🕐 Tempo calculado: ${elapsedSeconds}s (início: ${room.videoStartTimestamp}, agora: ${now})`);
  
  return elapsedSeconds;
}

// Função para calcular tempo atual baseado no tempo de início da música (MANTIDA PARA COMPATIBILIDADE)
function calculateCurrentTime(room: RoomState): number {
  if (!room.playing || !room.trackStartTime || !room.currentTrack) {
    console.log(`⚠️ Não é possível calcular tempo: playing=${room.playing}, trackStartTime=${!!room.trackStartTime}, currentTrack=${!!room.currentTrack}`);
    return room.currentTime;
  }
  
  const now = new Date();
  const elapsedSeconds = Math.floor((now.getTime() - room.trackStartTime.getTime()) / 1000);
  const calculatedTime = room.lastSyncTime + elapsedSeconds;
  
  console.log(`🕐 Calculando tempo: lastSyncTime=${room.lastSyncTime}s, elapsed=${elapsedSeconds}s, resultado=${calculatedTime}s`);
  
  return calculatedTime;
}

// ✅ NOVO: Função para selecionar nova fonte de sincronização
function selectNewSyncSource(room: RoomState): RoomUser | null {
  const activeUsers = Array.from(room.users.values()).filter(u => u.isActive && u.canBeSyncSource);
  
  if (activeUsers.length === 0) return null;
  
  // 1. Procura por Owner ativo
  const owner = activeUsers.find(u => u.role === 'owner');
  if (owner) return owner;
  
  // 2. Procura por Moderator ativo
  const moderator = activeUsers.find(u => u.role === 'moderator');
  if (moderator) return moderator;
  
  // 3. Procura por usuário ativo mais antigo (primeiro a entrar)
  return activeUsers.sort((a, b) => 
    a.joinedAt.getTime() - b.joinedAt.getTime()
  )[0];
}

// ✅ NOVO: Função para atualizar fonte de sincronização
function updateSyncSource(room: RoomState, io: any): boolean {
  const newSyncSource = selectNewSyncSource(room);
  
  if (newSyncSource) {
    const previousSource = room.syncSource?.userId;
    
    room.syncSource = {
      userId: newSyncSource.id,
      userRole: newSyncSource.role,
      lastSyncTime: room.currentTime || 0,
      isActive: true,
      lastActivity: new Date()
    };
    
    // ✅ Notificar todos sobre a mudança de fonte
    io.to(room.roomId).emit("syncSourceChanged", {
      newSource: room.syncSource,
      previousSource: previousSource,
      reason: previousSource ? "source_left" : "new_source_selected"
    });
    
    console.log(`Nova fonte de sincronização na sala ${room.roomId}: ${newSyncSource.name} (${newSyncSource.role})`);
    return true;
  } else {
    // ✅ Sala vazia - para o player
    room.syncSource = null;
    room.playing = false;
    room.currentTime = 0;
    room.trackStartTime = null;
    room.lastSyncTime = 0;
    
    // ✅ Parar sincronização de tempo
    stopTimeSync(room.roomId);
    
    // ✅ Notificar que sala ficou vazia
    io.to(room.roomId).emit("roomEmpty", { 
      message: "Sala vazia - reprodução parada",
      reason: "no_active_users"
    });
    
    console.log(`Sala ${room.roomId} ficou vazia - reprodução parada`);
    return false;
  }
}

// ✅ NOVO: Função para verificar atividade dos usuários
function checkUserActivity(room: RoomState, io: any) {
  const now = new Date();
  let hasActiveUsers = false;
  
  room.users.forEach(user => {
    // ✅ Verificar se socket ainda está conectado e na sala
    const socket = io.sockets.sockets.get(user.socketId);
    const wasActive = user.isActive;
    
    user.isActive = socket && socket.connected && socket.rooms.has(room.roomId);
    
    // ✅ Se status mudou, notificar
    if (wasActive !== user.isActive) {
      io.to(room.roomId).emit("userStatusChanged", {
        userId: user.id,
        isActive: user.isActive,
        reason: user.isActive ? "user_connected" : "user_disconnected"
      });
      
      if (user.isActive) {
        user.lastActivity = now;
      }
    }
    
    // ✅ IMPORTANTE: Contar usuários ativos independente de mudança de status
    if (user.isActive) {
      hasActiveUsers = true;
    }
  });
  
  // ✅ Se não há usuários ativos, marcar sala como offline
  if (!hasActiveUsers) {
    room.online = false;
    room.playing = false;
    room.currentTrack = null;
    room.currentTime = 0;
    room.trackStartTime = null;
    room.lastSyncTime = 0;
    room.syncSource = null;
    
    // ✅ Sincronizar com banco de dados
    syncRoomOnlineStatus(room.roomId, false);
    
    // ✅ Parar sincronização e heartbeat
    stopTimeSync(room.roomId);
    stopHeartbeat(room.roomId);
    
    // ✅ Notificar que sala ficou offline
    io.to(room.roomId).emit("roomOffline", { 
      message: "Sala ficou offline - não há usuários ativos",
      reason: "no_active_users"
    });
    
    console.log(`Sala ${room.roomId} ficou offline - não há usuários ativos`);
  } else {
    // ✅ IMPORTANTE: Se há usuários ativos, garantir que a sala esteja online
    if (!room.online) {
      room.online = true;
      syncRoomOnlineStatus(room.roomId, true);
      console.log(`🔄 Sala ${room.roomId} reativada - usuários ativos encontrados`);
    }
  }
}

// Função para iniciar sincronização de tempo para uma sala (FALLBACK)
function startTimeSync(roomId: string, ioInstance: any) {
  if (timeSyncIntervals[roomId]) {
    clearInterval(timeSyncIntervals[roomId]);
  }
  
  timeSyncIntervals[roomId] = setInterval(() => {
    const room = rooms[roomId];
    if (room && room.online && room.playing && room.currentTrack) {
      // ✅ NOVO: Usar sistema simples primeiro
      let currentTime = room.currentTime;
      let source = "server_calculation";
      
      if (room.videoStartTimestamp && room.videoId) {
        // Usar sistema simples
        currentTime = getCurrentVideoTime(room);
        room.currentTime = currentTime;
        source = "simple_timestamp";
      } else if (room.syncSource?.isActive) {
        // Fallback para sistema antigo
        const timeSinceHostUpdate = room.lastHostUpdate ? Date.now() - room.lastHostUpdate.getTime() : Infinity;
        
        if (timeSinceHostUpdate < 3000) { // 3 segundos
          // Host atualizou recentemente - usar tempo do host
          console.log(`🔄 Host atualizou recentemente (${Math.floor(timeSinceHostUpdate/1000)}s atrás) - usando tempo do host: ${room.currentTime}s`);
          source = "host_recent";
        } else {
          // Host não atualizou - usar cálculo como fallback
          console.log(`⚠️ Host não atualizou há ${Math.floor(timeSinceHostUpdate/1000)}s - usando cálculo como fallback`);
          currentTime = calculateCurrentTime(room);
          room.currentTime = currentTime;
          source = "fallback_calculation";
        }
      }
      
      // ✅ Enviar sincronização para todos os usuários da sala
      ioInstance.to(roomId).emit("timeSync", { 
        currentTime: currentTime,
        trackId: room.currentTrack.id,
        syncSource: room.syncSource,
        source: source
      });
    }
  }, 5000); // Sincronizar a cada 5 segundos
}

// ✅ NOVO: Função para iniciar heartbeat para uma sala
function startHeartbeat(roomId: string, io: any) {
  if (heartbeatIntervals[roomId]) {
    clearInterval(heartbeatIntervals[roomId]);
  }
  
  heartbeatIntervals[roomId] = setInterval(() => {
    const room = rooms[roomId];
    if (room && room.online) {
      checkUserActivity(room, io);
      
      // ✅ Se a fonte de sincronização ficou inativa, selecionar nova
      if (room.syncSource && !room.syncSource.isActive) {
        updateSyncSource(room, io);
      }
    }
  }, 30000); // Verificar a cada 30 segundos
}

// Função para parar sincronização de tempo para uma sala
function stopTimeSync(roomId: string) {
  if (timeSyncIntervals[roomId]) {
    clearInterval(timeSyncIntervals[roomId]);
    delete timeSyncIntervals[roomId];
  }
}

// ✅ NOVO: Função para parar heartbeat para uma sala
function stopHeartbeat(roomId: string) {
  if (heartbeatIntervals[roomId]) {
    clearInterval(heartbeatIntervals[roomId]);
    delete heartbeatIntervals[roomId];
  }
}

// ✅ NOVO: Função para sincronizar status online com banco de dados
async function syncRoomOnlineStatus(roomId: string, online: boolean) {
  try {
    const room = await roomRepository.findById(roomId);
    if (room) {
      room.online = online;
      await roomRepository.update(room);
      console.log(`🔄 Status online da sala ${roomId} sincronizado com banco: ${online}`);
    }
  } catch (error) {
    console.error(`❌ Erro ao sincronizar status online da sala ${roomId}:`, error);
  }
}

export function startSocketServer(server: any) {
  const io = new Server(server, {
    path:"/socket.io",
    cors: {
      origin: "*",
    },
  });

  io.on("connection", (socket) => {
    console.log("Usuário conectado:", socket.id);

    // Entrar na sala
    socket.on("joinRoom", ({ roomId, userId, userData }) => {
      socket.join(roomId);

      // Criar sala se não existir
      if (!rooms[roomId]) {
        rooms[roomId] = {
          roomId,
          online: false, // Inicialmente offline até o dono entrar
          playing: false,
          currentTime: 0,
          listeners: 0,
          playlist: [],
          currentTrack: null,
          users: new Map(),
          owner: userId, // ✅ CORREÇÃO: Owner é sempre quem cria a sala
          moderators: userData.moderators || [],
          createdAt: new Date(),
          lastActivity: new Date(),
          // Inicializar campos de sincronização
          trackStartTime: null,
          lastSyncTime: 0,
          // ✅ NOVO: Sistema simples de sincronização
          videoStartTimestamp: undefined,
          videoId: undefined,
          // ✅ NOVO: Inicializar fonte de sincronização
          syncSource: null,
          // ✅ NOVO: Inicializar último tempo atualizado pelo host
          lastHostUpdate: null,
        };
      }

      const room = rooms[roomId];
      
      // ✅ CORREÇÃO: Verificar se é o dono da sala (corrigir inconsistências)
      // Se userData indica que é owner, corrigir room.owner
      if (userData.owner === userId || userData.role === 'owner') {
        room.owner = userId;
        console.log(`🔧 Corrigindo owner da sala ${roomId}: ${userId}`);
      }
      
      const isOwner = userId === room.owner;
      const isModerator = room.moderators.includes(userId);
      
      // Se for o dono, ativar a sala
      if (isOwner && !room.online) {
        room.online = true;
        console.log(`Sala ${roomId} ativada pelo dono ${userId}`);
        
        // ✅ Sincronizar com banco de dados
        syncRoomOnlineStatus(roomId, true);
        
        // ✅ Iniciar heartbeat para a sala
        startHeartbeat(roomId, io);
      }
      
      // ✅ NOVO: Se owner voltou, reassumir controle automaticamente
      if (isOwner && room.online) {
        console.log(`Owner ${userId} voltou à sala ${roomId} - reassumindo controle`);
        
        // ✅ Reassumir como fonte de sincronização
        room.syncSource = {
          userId: userId,
          userRole: 'owner',
          lastSyncTime: room.currentTime || 0,
          isActive: true,
          lastActivity: new Date()
        };
        
        // ✅ Notificar que owner reassumiu controle
        io.to(roomId).emit("ownerReturned", {
          ownerId: userId,
          message: "Owner voltou e reassumiu controle da sala",
          syncSource: room.syncSource
        });
        
        console.log(`Owner ${userId} reassumiu controle da sala ${roomId}`);
      }

      // Adicionar usuário à sala
      if (!room.users.has(userId)) {
        const roomUser: RoomUser = {
          id: userId,
          name: userData.name,
          email: userData.email,
          image: userData.image,
          role: userData.role,
          socketId: socket.id,
          joinedAt: new Date(),
          // ✅ NOVO: Inicializar campos de atividade
          isActive: true,
          lastActivity: new Date(),
          canBeSyncSource: isOwner || isModerator || true, // Todos podem ser fonte por enquanto
        };
        
        room.users.set(userId, roomUser);
        room.listeners = room.users.size;
        room.lastActivity = new Date();
      } else {
        // ✅ Usuário reconectando - atualizar status
        const existingUser = room.users.get(userId)!;
        existingUser.isActive = true;
        existingUser.lastActivity = new Date();
        existingUser.socketId = socket.id;
      }

      // ✅ NOVO: Calcular tempo atual usando sistema simples
      let currentTimeToSend = room.currentTime;
      if (room.playing && room.currentTrack) {
        // Tentar usar sistema simples primeiro
        if (room.videoStartTimestamp && room.videoId) {
          currentTimeToSend = getCurrentVideoTime(room);
          room.currentTime = currentTimeToSend;
          console.log(`🎯 Usuário entrando: música tocando, tempo calculado (simples): ${currentTimeToSend}s`);
        } else if (room.trackStartTime) {
          // Fallback para sistema antigo
          currentTimeToSend = calculateCurrentTime(room);
          room.currentTime = currentTimeToSend;
          console.log(`🎯 Usuário entrando: música tocando, tempo calculado (antigo): ${currentTimeToSend}s`);
        } else {
          // Se está tocando mas não tem timestamp, criar um baseado no tempo atual
          console.log(`⚠️ Música tocando sem timestamp - criando um baseado no tempo atual`);
          const now = Date.now();
          room.videoStartTimestamp = now - (room.currentTime * 1000); // Ajustar para o tempo atual
          room.videoId = room.currentTrack.id;
          room.trackStartTime = new Date(now - (room.currentTime * 1000));
          room.lastSyncTime = room.currentTime || 0;
          currentTimeToSend = room.currentTime || 0;
          console.log(`🎯 Timestamp criado: ${room.videoStartTimestamp}, tempo atual: ${currentTimeToSend}s`);
        }
      } else {
        console.log(`ℹ️ Música não está tocando: tempo=${currentTimeToSend}s`);
      }

      // ✅ NOVO: Selecionar fonte de sincronização se não houver
      if (!room.syncSource) {
        updateSyncSource(room, io);
      }

      // Enviar estado atual da sala para o usuário que entrou
      const roomState = {
        ...room,
        currentTime: currentTimeToSend,
        users: Array.from(room.users.values()),
        currentUserRole: isOwner ? 'owner' : isModerator ? 'moderator' : 'user',
        canModerate: isOwner || isModerator,
        // ✅ NOVO: Incluir fonte de sincronização
        syncSource: room.syncSource,
      };
      
      socket.emit("roomJoined", roomState);
      
      // Notificar outros usuários sobre o novo membro
      socket.to(roomId).emit("userJoined", {
        user: room.users.get(userId),
        listeners: room.listeners,
        online: room.online,
        syncSource: room.syncSource,
      });

      // ✅ CORREÇÃO: Sempre calcular tempo atual antes de enviar updateRoom
      if (room.playing && room.currentTrack && room.trackStartTime) {
        room.currentTime = calculateCurrentTime(room);
        console.log(`🔄 updateRoom: tempo recalculado: ${room.currentTime}s`);
      }

      // Atualizar estado da sala para todos
      io.to(roomId).emit("updateRoom", {
        ...room,
        currentTime: room.currentTime, // ✅ Usar tempo calculado
        users: Array.from(room.users.values()),
        syncSource: room.syncSource,
      });

      console.log(`Usuário ${userId} entrou na sala ${roomId}. Total: ${room.listeners}. Tempo atual: ${currentTimeToSend}s. Fonte: ${room.syncSource?.userId || 'nenhuma'}`);
    });

    // Ativar/Desativar sala (apenas dono)
    socket.on("toggleRoomStatus", ({ roomId, userId, online }) => {
      const room = rooms[roomId];
      
      if (room && userId === room.owner) {
        room.online = online;
        room.lastActivity = new Date();
        
        // ✅ Sincronizar com banco de dados
        syncRoomOnlineStatus(roomId, online);
        
        if (!online) {
          // ✅ Sala desativada pelo dono - parar tudo
          room.playing = false;
          room.currentTrack = null;
          room.currentTime = 0;
          room.trackStartTime = null;
          room.lastSyncTime = 0;
          room.syncSource = null;
          
          // ✅ Parar sincronização e heartbeat
          stopTimeSync(roomId);
          stopHeartbeat(roomId);
          
          // ✅ Desconectar todos os usuários
          io.to(roomId).emit("roomOffline", { 
            message: "Sala foi desativada pelo dono",
            reason: "owner_disabled"
          });
          
          // ✅ Limpar usuários da sala
          room.users.clear();
          room.listeners = 0;
        } else {
          // ✅ Sala reativada - iniciar heartbeat
          startHeartbeat(roomId, io);
        }
        
        io.to(roomId).emit("updateRoom", {
          ...room,
          users: Array.from(room.users.values()),
          syncSource: room.syncSource,
        });
        
        console.log(`Sala ${roomId} ${online ? 'ativada' : 'desativada'} por ${userId}`);
      }
    });

    // Adicionar música à playlist
    socket.on("addTrack", ({ roomId, track, userId }) => {
      const room = rooms[roomId];
      
      if (room && room.online) {
        // Verificar se a música já existe na playlist
        const trackExists = room.playlist.some(t => t.id === track.id);
        
        if (!trackExists) {
          room.playlist.push(track);
          room.lastActivity = new Date();
          
          io.to(roomId).emit("trackAdded", { track, playlist: room.playlist });
          io.to(roomId).emit("updateRoom", {
            ...room,
            users: Array.from(room.users.values()),
            syncSource: room.syncSource,
          });
          
          console.log(`Música "${track.title}" adicionada à sala ${roomId} por ${userId}`);
        }
      }
    });

    // Remover música da playlist (apenas dono e moderadores)
    socket.on("removeTrack", ({ roomId, trackId, userId }) => {
      const room = rooms[roomId];
      
      if (room && room.online) {
        const user = room.users.get(userId);
        const canRemove = userId === room.owner || room.moderators.includes(userId);
        
        if (canRemove) {
          const trackIndex = room.playlist.findIndex(t => t.id === trackId);
          
          if (trackIndex !== -1) {
            const removedTrack = room.playlist.splice(trackIndex, 1)[0];
            room.lastActivity = new Date();
            
            io.to(roomId).emit("trackRemoved", { trackId, playlist: room.playlist });
            io.to(roomId).emit("updateRoom", {
              ...room,
              users: Array.from(room.users.values()),
              syncSource: room.syncSource,
            });
            
            console.log(`Música "${removedTrack.title}" removida da sala ${roomId} por ${userId}`);
          }
        }
      }
    });

    // Controle de reprodução
    socket.on("playPause", ({ roomId, userId, playing }) => {
      const room = rooms[roomId];
      
      if (room && room.online) {
        const user = room.users.get(userId);
        const canControl = userId === room.owner || room.moderators.includes(userId);
        
        if (canControl) {
          room.playing = playing;
          room.lastActivity = new Date();
          
          // ✅ NOVO: Gerenciar sincronização de tempo com sistema simples
          if (playing && room.currentTrack) {
            // Iniciar reprodução - marcar tempo de início
            if (!room.videoStartTimestamp || !room.videoId) {
              room.videoStartTimestamp = Date.now();
              room.videoId = room.currentTrack.id;
              room.trackStartTime = new Date();
              room.lastSyncTime = room.currentTime;
              console.log(`🎵 playPause: iniciando reprodução com timestamp: ${room.videoStartTimestamp}`);
            }
            // Iniciar sincronização de tempo
            startTimeSync(roomId, io);
          } else if (!playing) {
            // Pausar reprodução - parar sincronização
            room.trackStartTime = null;
            stopTimeSync(roomId);
            console.log(`⏸️ playPause: pausando reprodução`);
          }
          
          io.to(roomId).emit("playbackStateChanged", { 
            playing, 
            currentTime: room.currentTime,
            syncSource: room.syncSource,
          });
          io.to(roomId).emit("updateRoom", {
            ...room,
            users: Array.from(room.users.values()),
            syncSource: room.syncSource,
          });
        }
      }
    });

    // Definir música atual
    socket.on("playTrack", ({ roomId, track, userId }) => {
      const room = rooms[roomId];
      
      if (room && room.online) {
        const user = room.users.get(userId);
        const canControl = userId === room.owner || room.moderators.includes(userId);
        
        if (canControl) {
          // ✅ CORREÇÃO: Parar sincronização anterior se houver
          if (room.playing && room.currentTrack) {
            stopTimeSync(roomId);
          }
          
          // ✅ CORREÇÃO: Adicionar música à playlist se não existir (apenas para playTrack)
          const trackExists = room.playlist.some(t => t.id === track.id);
          if (!trackExists) {
            room.playlist.push(track);
            console.log(`🎵 playTrack: música "${track.title}" adicionada à playlist`);
          }
          
          // ✅ NOVO: Nova música - sempre começar do início com sistema simples
          room.currentTrack = track;
          room.playing = true;
          room.currentTime = 0;
          room.lastSyncTime = 0;
          room.trackStartTime = new Date();
          room.videoStartTimestamp = Date.now(); // ✅ NOVO: Timestamp simples
          room.videoId = track.id; // ✅ NOVO: ID da música
          room.lastActivity = new Date();
          
          console.log(`🎵 playTrack: nova música "${track.title}", começando do início (timestamp: ${room.videoStartTimestamp})`);
          
          // ✅ Iniciar sincronização de tempo para nova música
          startTimeSync(roomId, io);
          
          // ✅ CORREÇÃO: Sempre calcular tempo atual antes de enviar trackChanged
          if (room.playing && room.currentTrack && room.trackStartTime) {
            room.currentTime = calculateCurrentTime(room);
            console.log(`🎵 trackChanged: tempo recalculado: ${room.currentTime}s`);
          }

          // ✅ NOVO: Emitir trackAdded se foi adicionada à playlist
          if (!trackExists) {
            io.to(roomId).emit("trackAdded", { track, playlist: room.playlist });
          }

          io.to(roomId).emit("trackChanged", { 
            track, 
            playing: true, 
            currentTime: room.currentTime, // ✅ Usar tempo calculado
            syncSource: room.syncSource,
          });
          io.to(roomId).emit("updateRoom", {
            ...room,
            users: Array.from(room.users.values()),
            syncSource: room.syncSource,
          });
          
          console.log(`Música atual alterada para "${track.title}" na sala ${roomId} por ${userId}`);
        }
      }
    });

    // ✅ PRINCIPAL: Sincronização de tempo de reprodução do usuário fonte
    socket.on("syncTrack", ({ roomId, currentTime, userId }) => {
      const room = rooms[roomId];
      
      if (room && room.online) {
        const user = room.users.get(userId);
        const canControl = userId === room.owner || room.moderators.includes(userId);
        
        // ✅ Verificar se é o usuário fonte de sincronização
        const isSyncSource = room.syncSource?.userId === userId;
        
        if (canControl && isSyncSource) {
          console.log(`🎯 Host ${userId} enviou tempo: ${currentTime}s`);
          
          // ✅ Atualizar tempo com valor recebido do host
          room.currentTime = currentTime;
          room.lastSyncTime = currentTime;
          room.trackStartTime = new Date();
          room.lastActivity = new Date();
          room.lastHostUpdate = new Date(); // ✅ Marcar última atualização do host
          
          // ✅ Reiniciar sincronização com novo tempo
          startTimeSync(roomId, io);
          
          // ✅ Enviar para outros usuários (não para quem enviou)
          socket.to(roomId).emit("timeSync", { 
            currentTime,
            trackId: room.currentTrack?.id,
            syncSource: room.syncSource,
            source: "host_update"
          });
          
          console.log(`✅ Tempo sincronizado do host: ${currentTime}s na sala ${roomId}`);
        } else if (!canControl) {
          socket.emit("permissionDenied", { 
            action: "syncTrack", 
            message: "Apenas dono e moderadores podem sincronizar tempo" 
          });
        } else if (!isSyncSource) {
          socket.emit("syncSourceOnly", { 
            message: "Apenas a fonte de sincronização pode enviar tempo" 
          });
        }
      }
    });

    // Próxima música
    socket.on("nextTrack", ({ roomId, userId }) => {
      const room = rooms[roomId];
      
      if (room && room.online) {
        const user = room.users.get(userId);
        const canControl = userId === room.owner || room.moderators.includes(userId);
        
        if (canControl && room.playlist.length > 0) {
          // ✅ CORREÇÃO: Parar sincronização anterior
          if (room.playing && room.currentTrack) {
            stopTimeSync(roomId);
          }
          
          const currentIndex = room.currentTrack 
            ? room.playlist.findIndex(t => t.id === room.currentTrack?.id)
            : -1;
          
          const nextIndex = (currentIndex + 1) % room.playlist.length;
          const nextTrack = room.playlist[nextIndex];
          
          room.currentTrack = nextTrack;
          room.currentTime = 0; // ✅ Nova música sempre começa do início
          room.trackStartTime = new Date();
          room.lastSyncTime = 0;
          room.videoStartTimestamp = Date.now(); // ✅ NOVO: Timestamp simples
          room.videoId = nextTrack.id; // ✅ NOVO: ID da música
          room.lastActivity = new Date();
          
          // ✅ Iniciar sincronização para nova música
          startTimeSync(roomId, io);
          
          // ✅ CORREÇÃO: Sempre calcular tempo atual antes de enviar trackChanged
          if (room.playing && room.currentTrack && room.trackStartTime) {
            room.currentTime = calculateCurrentTime(room);
            console.log(`🎵 trackChanged: tempo recalculado: ${room.currentTime}s`);
          }

          // Emitir evento específico para mudança de música
          io.to(roomId).emit("trackChanged", { 
            track: nextTrack, 
            playing: true, 
            currentTime: room.currentTime, // ✅ Usar tempo calculado
            direction: 'next',
            previousTrack: room.currentTrack,
            syncSource: room.syncSource,
          });
          
          // Atualizar estado da sala
          io.to(roomId).emit("updateRoom", {
            ...room,
            users: Array.from(room.users.values()),
            syncSource: room.syncSource,
          });
          
          console.log(`Próxima música: "${nextTrack.title}" na sala ${roomId} por ${userId}`);
        } else if (!canControl) {
          socket.emit("permissionDenied", { 
            action: "nextTrack", 
            message: "Apenas dono e moderadores podem passar para a próxima música" 
          });
        } else if (room.playlist.length === 0) {
          socket.emit("playlistEmpty", { 
            message: "Não há músicas na playlist para navegar" 
          });
        }
      }
    });

    // Pular para música específica da playlist (apenas dono e moderadores)
    socket.on("jumpToTrack", ({ roomId, userId, trackIndex }) => {
      const room = rooms[roomId];
      
      if (room && room.online) {
        const user = room.users.get(userId);
        const canControl = userId === room.owner || room.moderators.includes(userId);
        
        if (canControl && room.playlist.length > 0) {
          // Validar índice
          if (trackIndex >= 0 && trackIndex < room.playlist.length) {
            // ✅ CORREÇÃO: Parar sincronização anterior
            if (room.playing && room.currentTrack) {
              stopTimeSync(roomId);
            }
            
            const targetTrack = room.playlist[trackIndex];
            
            room.currentTrack = targetTrack;
            room.currentTime = 0; // ✅ Nova música sempre começa do início
            room.trackStartTime = new Date();
            room.lastSyncTime = 0;
            room.videoStartTimestamp = Date.now(); // ✅ NOVO: Timestamp simples
            room.videoId = targetTrack.id; // ✅ NOVO: ID da música
            room.lastActivity = new Date();
            
            // ✅ Iniciar sincronização para nova música
            startTimeSync(roomId, io);
            
            // ✅ CORREÇÃO: Sempre calcular tempo atual antes de enviar trackChanged
            if (room.playing && room.currentTrack && room.trackStartTime) {
              room.currentTime = calculateCurrentTime(room);
              console.log(`🎵 trackChanged: tempo recalculado: ${room.currentTime}s`);
            }

            // Emitir evento específico para mudança de música
            io.to(roomId).emit("trackChanged", { 
              track: targetTrack, 
              playing: true, 
              currentTime: room.currentTime, // ✅ Usar tempo calculado
              direction: 'jump',
              trackIndex: trackIndex,
              previousTrack: room.currentTrack,
              syncSource: room.syncSource,
            });
            
            // Atualizar estado da sala
            io.to(roomId).emit("updateRoom", {
              ...room,
              users: Array.from(room.users.values()),
              syncSource: room.syncSource,
            });
            
            console.log(`Pulou para música ${trackIndex}: "${targetTrack.title}" na sala ${roomId} por ${userId}`);
          } else {
            socket.emit("invalidTrackIndex", { 
              message: `Índice inválido. A playlist tem ${room.playlist.length} músicas (0-${room.playlist.length - 1})` 
            });
          }
        } else if (!canControl) {
          socket.emit("permissionDenied", { 
            action: "jumpToTrack", 
            message: "Apenas dono e moderadores podem pular para músicas específicas" 
          });
        } else if (room.playlist.length === 0) {
          socket.emit("playlistEmpty", { 
            message: "Não há músicas na playlist para navegar" 
          });
        }
      }
    });

    // Música anterior
    socket.on("previousTrack", ({ roomId, userId }) => {
      const room = rooms[roomId];
      
      if (room && room.online) {
        const user = room.users.get(userId);
        const canControl = userId === room.owner || room.moderators.includes(userId);
        
        if (canControl && room.playlist.length > 0) {
          // ✅ CORREÇÃO: Parar sincronização anterior
          if (room.playing && room.currentTrack) {
            stopTimeSync(roomId);
          }
          
          const currentIndex = room.currentTrack 
            ? room.playlist.findIndex(t => t.id === room.currentTrack?.id)
            : -1;
          
          const prevIndex = currentIndex <= 0 ? room.playlist.length - 1 : currentIndex - 1;
          const prevTrack = room.playlist[prevIndex];
          
          room.currentTrack = prevTrack;
          room.currentTime = 0; // ✅ Nova música sempre começa do início
          room.trackStartTime = new Date();
          room.lastSyncTime = 0;
          room.videoStartTimestamp = Date.now(); // ✅ NOVO: Timestamp simples
          room.videoId = prevTrack.id; // ✅ NOVO: ID da música
          room.lastActivity = new Date();
          
          // ✅ Iniciar sincronização para nova música
          startTimeSync(roomId, io);
          
          // ✅ CORREÇÃO: Sempre calcular tempo atual antes de enviar trackChanged
          if (room.playing && room.currentTrack && room.trackStartTime) {
            room.currentTime = calculateCurrentTime(room);
            console.log(`🎵 trackChanged: tempo recalculado: ${room.currentTime}s`);
          }

          // Emitir evento específico para mudança de música
          io.to(roomId).emit("trackChanged", { 
            track: prevTrack, 
            playing: true, 
            currentTime: room.currentTime, // ✅ Usar tempo calculado
            direction: 'previous',
            previousTrack: room.currentTrack,
            syncSource: room.syncSource,
          });
          
          // Atualizar estado da sala
          io.to(roomId).emit("updateRoom", {
            ...room,
            users: Array.from(room.users.values()),
            syncSource: room.syncSource,
          });
          
          console.log(`Música anterior: "${prevTrack.title}" na sala ${roomId} por ${userId}`);
        } else if (!canControl) {
          socket.emit("permissionDenied", { 
            action: "previousTrack", 
            message: "Apenas dono e moderadores podem voltar para a música anterior" 
          });
        } else if (room.playlist.length === 0) {
          socket.emit("playlistEmpty", { 
            message: "Não há músicas na playlist para navegar" 
          });
        }
      }
    });

    // Expulsar usuário (apenas dono e moderadores)
    socket.on("kickUser", ({ roomId, targetUserId, userId, reason }) => {
      const room = rooms[roomId];
      
      if (room && room.online) {
        const user = room.users.get(userId);
        const canKick = userId === room.owner || room.moderators.includes(userId);
        
        if (canKick && targetUserId !== userId) {
          const targetUser = room.users.get(targetUserId);
          
          if (targetUser) {
            // Remover usuário da sala
            room.users.delete(targetUserId);
            room.listeners = room.users.size;
            room.lastActivity = new Date();
            
            // ✅ Se a fonte de sincronização foi expulsa, selecionar nova
            if (room.syncSource && room.syncSource.userId === targetUserId) {
              updateSyncSource(room, io);
            }
            
            // Desconectar usuário expulso
            io.to(targetUser.socketId).emit("kicked", { 
              reason: reason || "Você foi expulso da sala",
              roomId 
            });
            
            // Notificar outros usuários
            io.to(roomId).emit("userKicked", { 
              userId: targetUserId, 
              reason,
              listeners: room.listeners,
              syncSource: room.syncSource,
            });
            
            io.to(roomId).emit("updateRoom", {
              ...room,
              users: Array.from(room.users.values()),
              syncSource: room.syncSource,
            });
            
            console.log(`Usuário ${targetUserId} expulso da sala ${roomId} por ${userId}`);
          }
        }
      }
    });

    // Adicionar/Remover moderador (apenas dono)
    socket.on("toggleModerator", ({ roomId, targetUserId, userId, isModerator }) => {
      const room = rooms[roomId];
      
      if (room && userId === room.owner) {
        if (isModerator) {
          if (!room.moderators.includes(targetUserId)) {
            room.moderators.push(targetUserId);
          }
        } else {
          room.moderators = room.moderators.filter(id => id !== targetUserId);
        }
        
        room.lastActivity = new Date();
        
        io.to(roomId).emit("moderatorUpdated", { 
          userId: targetUserId, 
          isModerator,
          moderators: room.moderators,
          syncSource: room.syncSource,
        });
        
        io.to(roomId).emit("updateRoom", {
          ...room,
          users: Array.from(room.users.values()),
          syncSource: room.syncSource,
        });
        
        console.log(`Usuário ${targetUserId} ${isModerator ? 'promovido a' : 'removido de'} moderador na sala ${roomId}`);
      }
    });

    // Sair da sala
    socket.on("leaveRoom", ({ roomId, userId }) => {
      const room = rooms[roomId];
      
      if (room && room.users.has(userId)) {
        const user = room.users.get(userId);
        
        // Remover usuário da sala
        room.users.delete(userId);
        room.listeners = room.users.size;
        room.lastActivity = new Date();
        
        socket.leave(roomId);
        
        // ✅ Se a fonte de sincronização saiu, selecionar nova
        if (room.syncSource && room.syncSource.userId === userId) {
          updateSyncSource(room, io);
        }
        
        // ✅ Se for o dono, mas há outros usuários, NÃO desativar a sala
        if (userId === room.owner && room.users.size > 0) {
          // ✅ Transferir propriedade para o próximo usuário mais antigo
          const nextOwner = Array.from(room.users.values()).sort((a, b) => 
            a.joinedAt.getTime() - b.joinedAt.getTime()
          )[0];
          
          room.owner = nextOwner.id;
          nextOwner.role = 'owner';
          
          console.log(`Propriedade da sala ${roomId} transferida para ${nextOwner.name} (${nextOwner.id})`);
          
          // ✅ Notificar sobre mudança de dono
          io.to(roomId).emit("ownerChanged", {
            newOwner: {
              id: nextOwner.id,
              name: nextOwner.name,
              role: nextOwner.role
            },
            previousOwner: userId
          });
          
          // ✅ Atualizar fonte de sincronização se necessário
          if (!room.syncSource || !room.syncSource.isActive) {
            updateSyncSource(room, io);
          }
        } else if (userId === room.owner && room.users.size === 0) {
          // ✅ Sala realmente vazia - desativar
          room.online = false;
          room.playing = false;
          room.currentTrack = null;
          room.currentTime = 0;
          room.trackStartTime = null;
          room.lastSyncTime = 0;
          room.syncSource = null;
          
          // ✅ Sincronizar com banco de dados
          syncRoomOnlineStatus(roomId, false);
          
          // ✅ Parar sincronização e heartbeat
          stopTimeSync(roomId);
          stopHeartbeat(roomId);
          
          console.log(`Dono ${userId} saiu da sala ${roomId}. Sala vazia - desativada.`);
        } else {
          // ✅ Usuário comum saiu
          console.log(`Usuário ${userId} saiu da sala ${roomId}. Total: ${room.listeners}`);
        }
        
        // ✅ Notificar outros usuários sobre a saída
        if (room.users.size > 0) {
          io.to(roomId).emit("userLeft", { 
            userId, 
            listeners: room.listeners,
            syncSource: room.syncSource,
          });
          
          io.to(roomId).emit("updateRoom", {
            ...room,
            users: Array.from(room.users.values()),
            syncSource: room.syncSource,
          });
        }
      }
    });

    // ===== SISTEMA DE CHAT =====
    
    // Enviar mensagem de chat
    socket.on("sendChatMessage", async (data) => {
      try {
        console.log("📨 Nova mensagem de chat recebida:", data);
        
        // Validar se usuário está na sala
        const room = rooms[data.roomId];
        if (!room || !room.users.has(data.userId)) {
          socket.emit("error", { message: "Usuário não está na sala" });
          return;
        }
        
        // Salvar mensagem no Firestore
        const message = await ChatService.sendMessage(data);
        
        // Emitir para todos na sala
        io.to(data.roomId).emit("chatMessage", message);
        
        console.log("✅ Mensagem de chat enviada com sucesso");
      } catch (error) {
        console.error("❌ Erro ao enviar mensagem de chat:", error);
        const errorMessage = error instanceof Error ? error.message : "Erro desconhecido";
        socket.emit("error", { message: errorMessage });
      }
    });

    // Editar mensagem de chat
    socket.on("editChatMessage", async (data) => {
      try {
        console.log("✏️ Edição de mensagem recebida:", data);
        
        // Validar se usuário está na sala
        const room = rooms[data.roomId];
        if (!room || !room.users.has(data.userId)) {
          socket.emit("error", { message: "Usuário não está na sala" });
          return;
        }
        
        // Editar mensagem no Firestore
        const updatedMessage = await ChatService.editMessage(data);
        
        // Emitir para todos na sala
        io.to(data.roomId).emit("messageEdited", updatedMessage);
        
        console.log("✅ Mensagem editada com sucesso");
      } catch (error) {
        console.error("❌ Erro ao editar mensagem:", error);
        const errorMessage = error instanceof Error ? error.message : "Erro desconhecido";
        socket.emit("error", { message: errorMessage });
      }
    });

    // Deletar mensagem de chat
    socket.on("deleteChatMessage", async (data) => {
      try {
        console.log("🗑️ Deleção de mensagem recebida:", data);
        
        // Validar se usuário está na sala
        const room = rooms[data.roomId];
        if (!room || !room.users.has(data.userId)) {
          socket.emit("error", { message: "Usuário não está na sala" });
          return;
        }
        
        // Deletar mensagem no Firestore
        await ChatService.deleteMessage(data);
        
        // Emitir para todos na sala
        io.to(data.roomId).emit("messageDeleted", data.messageId);
        
        console.log("✅ Mensagem deletada com sucesso");
      } catch (error) {
        console.error("❌ Erro ao deletar mensagem:", error);
        const errorMessage = error instanceof Error ? error.message : "Erro desconhecido";
        socket.emit("error", { message: errorMessage });
      }
    });

    // Solicitar histórico de chat
    socket.on("requestChatHistory", async (data) => {
      try {
        console.log("📚 Solicitação de histórico de chat recebida:", data);
        
        // Validar se usuário está na sala
        const room = rooms[data.roomId];
        if (!room) {
          socket.emit("error", { message: "Sala não encontrada" });
          return;
        }
        
        // Buscar histórico no Firestore
        const history = await ChatService.getChatHistory(data.roomId);
        
        // Enviar histórico para o usuário solicitante
        socket.emit("chatHistory", history);
        
        console.log("✅ Histórico de chat enviado com sucesso");
      } catch (error) {
        console.error("❌ Erro ao buscar histórico de chat:", error);
        const errorMessage = error instanceof Error ? error.message : "Erro desconhecido";
        socket.emit("error", { message: errorMessage });
      }
    });

    // Usuário digitando
    socket.on("userTyping", (data) => {
      try {
        console.log("⌨️ Usuário digitando:", data);
        
        // Validar se usuário está na sala
        const room = rooms[data.roomId];
        if (!room || !room.users.has(data.userId)) {
          return;
        }
        
        // Emitir para todos na sala (exceto o usuário que está digitando)
        socket.to(data.roomId).emit("userTyping", {
          userId: data.userId,
          userName: data.userName
        });
        
        console.log("✅ Evento de digitação enviado");
      } catch (error) {
        console.error("❌ Erro ao processar evento de digitação:", error);
      }
    });

    // Usuário parou de digitar
    socket.on("stopTyping", (data) => {
      try {
        console.log("⏹️ Usuário parou de digitar:", data);
        
        // Validar se usuário está na sala
        const room = rooms[data.roomId];
        if (!room || !room.users.has(data.userId)) {
          return;
        }
        
        // Emitir para todos na sala (exceto o usuário que parou de digitar)
        socket.to(data.roomId).emit("userStoppedTyping", data.userId);
        
        return;
      } catch (error) {
        console.error("❌ Erro ao processar evento de parada de digitação:", error);
      }
    });

    // Desconexão
    socket.on("disconnect", () => {
      console.log("Usuário desconectado:", socket.id);
      
      // Encontrar e remover usuário de todas as salas
      for (const [roomId, room] of Object.entries(rooms)) {
        for (const [userId, user] of room.users.entries()) {
          if (user.socketId === socket.id) {
            room.users.delete(userId);
            room.listeners = room.users.size;
            room.lastActivity = new Date();
            
            // ✅ Se a fonte de sincronização desconectou, selecionar nova
            if (room.syncSource && room.syncSource.userId === userId) {
              updateSyncSource(room, io);
            }
            
            // ✅ Se for o dono, mas há outros usuários, escolher novo host temporário
            if (userId === room.owner && room.users.size > 0) {
              // ✅ CORREÇÃO: NÃO transferir propriedade - owner permanece fixo
              // Apenas escolher novo host temporário para sincronização
              console.log(`Owner ${userId} desconectou da sala ${roomId} - escolhendo novo host temporário`);
              
              // ✅ Atualizar fonte de sincronização (escolhe moderador ou listener mais antigo)
              updateSyncSource(room, io);
              
              // ✅ Notificar que owner saiu mas sala continua ativa
              io.to(roomId).emit("ownerDisconnected", {
                ownerId: userId,
                message: "Owner saiu da sala - host temporário assumiu controle",
                newHost: room.syncSource
              });
            } else if (userId === room.owner && room.users.size === 0) {
              // ✅ Sala realmente vazia - desativar
              room.online = false;
              room.playing = false;
              room.currentTrack = null;
              room.currentTime = 0;
              room.trackStartTime = null;
              room.lastSyncTime = 0;
              room.syncSource = null;
              
              // ✅ Sincronizar com banco de dados
              syncRoomOnlineStatus(roomId, false);
              
              // ✅ Parar sincronização e heartbeat
              stopTimeSync(roomId);
              stopHeartbeat(roomId);
              
              console.log(`Dono ${userId} desconectado da sala ${roomId}. Sala vazia - desativada.`);
            } else {
              // ✅ Usuário comum desconectou
              io.to(roomId).emit("userLeft", { 
                userId, 
                listeners: room.listeners,
                syncSource: room.syncSource,
              });
              
              io.to(roomId).emit("updateRoom", {
                ...room,
                users: Array.from(room.users.values()),
                syncSource: room.syncSource,
              });
            }
            
            break;
          }
        }
      }
    });

    // Ping para manter conexão ativa
    socket.on("ping", () => {
      socket.emit("pong");
    });
  });

  console.log("Servidor Socket.IO rodando com sistema de fonte de sincronização dinâmica...");
}

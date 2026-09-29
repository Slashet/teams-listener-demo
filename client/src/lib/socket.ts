import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '../../../shared/protocol';

export type MeetingSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export function createMeetingSocket(): MeetingSocket {
  return io({
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1_000,
    reconnectionDelayMax: 5_000,
    timeout: 10_000,
    autoConnect: false,
  });
}

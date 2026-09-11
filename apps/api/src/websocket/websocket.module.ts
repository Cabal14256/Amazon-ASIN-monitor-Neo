import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisWebSocketEventBus } from './redis-websocket-events';
import { WS_EVENT_BUS } from './websocket-events';
import { WebSocketService } from './websocket.service';

@Module({
  imports: [AuthModule],
  providers: [
    WebSocketService,
    { provide: WS_EVENT_BUS, useClass: RedisWebSocketEventBus },
  ],
  exports: [WebSocketService],
})
export class WebSocketModule {}
